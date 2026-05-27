// phone-terminal-web: a small custom web terminal for shared tmux sessions.
//
// Replaces ttyd while keeping the existing tmux session model intact:
//   - GET  /api/sessions          -> JSON list of live tmux sessions + metadata
//   - WS   /ws/session/<name>     -> attach an existing session under a PTY
//   - WS   /ws/new[?name=<base>]  -> create + attach a new session
//
// Wire protocol on each WebSocket (symmetric, frame-type discriminated):
//   - text frame   = JSON control message ({type:"session"|"resize"|"error"|"exit", ...})
//   - binary frame = raw terminal bytes (stdin client->server, stdout server->client)
//
// Detach == kill the PTY's `tmux attach`/`tmux new` client process. tmux keeps
// the session alive as long as another client (e.g. local Ghostty) is attached;
// `destroy-unattached on` only reaps it once the last client leaves.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const execFileP = promisify(execFile);

// Optional: target a specific tmux server socket (tmux -L <name>). Defaults to
// the user's normal server. `-L` ignores the $TMUX env var, so it also gives
// real isolation when running a second instance.
const TMUX_SOCKET = process.env.TMUX_SOCKET || '';
const tmuxArgv = (args) => (TMUX_SOCKET ? ['-L', TMUX_SOCKET, ...args] : args);

// Absolute path or name of the tmux binary. Defaults to PATH lookup, but a
// launchd/systemd service often has a minimal PATH that misses Homebrew, so the
// installer bakes the resolved path in here.
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';

// Optional explicit terminal emulator for "open on PC" (must accept `-e <cmd…>`,
// e.g. ghostty/kitty/alacritty/xterm). If unset, a per-OS default is used.
const DESKTOP_TERMINAL = process.env.DESKTOP_TERMINAL || '';

// Tailscale UI integration is opt-in via the installer; the env var also acts
// as a hard kill-switch when users don't want webmux invoking `tailscale` at all.
const TAILSCALE_ENABLED = process.env.WEBMUX_TAILSCALE === '1';

// Path to the tailscale CLI, used for /api/tailnet. Resolved lazily so a launchd
// service with a minimal PATH still finds it in common install locations.
// Memoize the lookup as a single shared promise so parallel callers (status +
// serve) don't race past one another and see a half-initialized state.
let _tailscalePromise = null;
function resolveTailscale() {
  if (_tailscalePromise) return _tailscalePromise;
  _tailscalePromise = (async () => {
    const candidates = [
      process.env.TAILSCALE_BIN,
      'tailscale',
      process.env.HOME ? `${process.env.HOME}/.local/bin/tailscale` : '',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ].filter(Boolean);
    for (const c of candidates) {
      try { await execFileP(c, ['version'], { encoding: 'utf8' }); return c; }
      catch { /* try next */ }
    }
    return null;
  })();
  return _tailscalePromise;
}
async function runTailscale(args) {
  const bin = await resolveTailscale();
  if (!bin) throw new Error('tailscale binary not found');
  return (await execFileP(bin, args, { encoding: 'utf8' })).stdout;
}

// Probe https://<dns>/api/health by connecting to the peer's Tailscale IP and
// presenting the MagicDNS name via SNI + Host. The serve cert is issued for that
// name, so TLS still validates — and it works even when *this* node's MagicDNS
// can't resolve `.ts.net` (a common DNS-integration gap on Linux). Returns the
// parsed health JSON if it's a webmux instance, else null.
function probeWebmuxHealth(ip, dns, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.request(
      { host: ip, port: 443, servername: dns, path: '/api/health', method: 'GET', headers: { Host: dns }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            finish(j && typeof j === 'object' && 'tmuxBin' in j ? j : null);
          } catch { finish(null); }
        });
      }
    );
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.end();
  });
}

// Cached peer probe — discovering peers means an HTTPS round-trip to every
// online tailnet node, so we cache the result for a few seconds rather than
// hammering on every picker refresh.
const PEER_CACHE_MS = 10_000;
let _peersCachePromise = null;
let _peersCacheStamp = 0;
async function tailscalePeers() {
  const now = Date.now();
  if (_peersCachePromise && now - _peersCacheStamp < PEER_CACHE_MS) return _peersCachePromise;
  _peersCacheStamp = now;
  _peersCachePromise = (async () => {
    try {
      const status = JSON.parse(await runTailscale(['status', '--json']));
      const peers = Object.values(status.Peer || {})
        .filter((p) => p.Online && p.DNSName && Array.isArray(p.TailscaleIPs) && p.TailscaleIPs.length)
        .map((p) => {
          const dns = p.DNSName.replace(/\.$/, '');
          const ip = p.TailscaleIPs.find((a) => a.includes('.')) || p.TailscaleIPs[0];
          return { name: p.HostName || dns, dns, ip, url: `https://${dns}/` };
        });
      const probes = peers.map(async (p) => {
        const health = await probeWebmuxHealth(p.ip, p.dns, 2500);
        return health ? { name: p.name, dns: p.dns, ip: p.ip, url: p.url } : null;
      });
      return (await Promise.all(probes)).filter(Boolean);
    } catch {
      return [];
    }
  })();
  return _peersCachePromise;
}

// Best-effort lookup of this node's own tailnet HTTPS URL from `tailscale serve
// status`. Returns { url, dns } when serve is configured for our port; null
// otherwise (tailscale missing, not logged in, no serve config, etc.).
async function tailscaleSelf() {
  try {
    const [statusOut, serveOut] = await Promise.all([
      runTailscale(['status', '--json', '--self=true']),
      runTailscale(['serve', 'status', '--json']),
    ]);
    const status = JSON.parse(statusOut);
    const serve = JSON.parse(serveOut);
    const dns = ((status.Self && status.Self.DNSName) || '').replace(/\.$/, '');
    if (!dns || !serve.Web) return null;
    const localPort = String(PORT);
    for (const [hostPort, cfg] of Object.entries(serve.Web)) {
      for (const [routePath, h] of Object.entries(cfg.Handlers || {})) {
        const proxy = h.Proxy || '';
        const m = proxy.match(/:(\d+)(?:\/|$)/);
        if (!m || m[1] !== localPort) continue;
        const [host, port = '443'] = hostPort.split(':');
        const proto = port === '80' ? 'http' : 'https';
        const portSuffix = (port === '443' || port === '80') ? '' : `:${port}`;
        return { dns, url: `${proto}://${host}${portSuffix}${routePath}` };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// How to spawn a terminal window that runs `tmux new-session -A -s <name>`.
// DESKTOP_TERMINAL is a token the installer picks from the installed terminals.
function desktopLaunchSpec(name) {
  const run = [TMUX_BIN, ...(TMUX_SOCKET ? ['-L', TMUX_SOCKET] : []), 'new-session', '-A', '-s', name];
  const cmdline = run.join(' '); // name (NAME_RE) + tmux path have no spaces/quotes to escape
  const t = (DESKTOP_TERMINAL || '').toLowerCase();
  if (process.platform === 'darwin') {
    // macOS GUI apps can't be driven by `-e` from the CLI; use open / AppleScript.
    if (t === 'iterm' || t === 'iterm2')
      return ['osascript', ['-e', `tell application "iTerm" to create window with default profile command "${cmdline}"`]];
    if (t === 'ghostty')
      return ['open', ['-na', 'Ghostty', '--args', '-e', ...run]];
    if (t && t !== 'terminal' && t !== 'terminal.app')
      return [DESKTOP_TERMINAL, ['-e', ...run]]; // some other CLI emulator
    return ['osascript', ['-e', `tell application "Terminal" to do script "${cmdline}"`]]; // default
  }
  // Linux / other
  if (!t) return ['ghostty', ['-e', ...run]];
  if (t === 'gnome-terminal') return ['gnome-terminal', ['--', ...run]];
  if (t === 'wezterm') return ['wezterm', ['start', '--', ...run]];
  return [DESKTOP_TERMINAL, ['-e', ...run]]; // ghostty/kitty/alacritty/foot/konsole/xterm
}

// Open a real terminal window on the PC attached to the tmux session, so it is
// visible locally and (being a second client) outlives the browser. Best-effort:
// if there's no display or the emulator is missing, the web session still works.
function launchDesktop(name) {
  const [cmd, args] = desktopLaunchSpec(name);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {}); // emulator missing / no DISPLAY: ignore
    child.unref();
  } catch { /* ignore */ }
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8083', 10);
const TERM_NAME = process.env.TERM_NAME || 'xterm-256color';
const HOME = process.env.HOME || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// Validation for session names. Real tmux names can contain spaces and unicode
// (and tmux maps ':' / '.' to '_' itself), so the old strict regex wrongly
// rejected sessions that the picker had listed ("session not found"). Names are
// always passed to tmux as an argv element (never a shell), so the only genuine
// hazard is control characters; existence is checked separately via has-session.
const NAME_RE = /^[^\x00-\x1f\x7f]{1,128}$/;

// --- tmux helpers ----------------------------------------------------------

async function tmux(args) {
  const { stdout } = await execFileP(TMUX_BIN, tmuxArgv(args), { encoding: 'utf8' });
  return stdout;
}

function prettyPath(p) {
  if (!p) return '';
  if (p === HOME) return '~';
  if (HOME && p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

// tmux 3.6 replaces non-printable bytes (TAB, \x1f, etc.) with '_' in -F output,
// so we use a printable multi-char delimiter that won't appear in real paths/commands.
const FS = '<<>>';

async function listSessions() {
  let out;
  try {
    // Pane vars resolve against each session's active pane, so one call is enough.
    out = await tmux([
      'list-sessions', '-F',
      `#{session_name}${FS}#{session_attached}${FS}#{session_windows}${FS}#{pane_current_command}${FS}#{pane_current_path}`,
    ]);
  } catch {
    return []; // no server running -> no sessions
  }
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, attached, windows, command, cwd] = line.split(FS);
    return {
      name,
      attached: Number(attached) || 0,
      windows: Number(windows) || 0,
      command: command || '',
      path: prettyPath(cwd || ''),
    };
  });
}

async function uniqueName(base) {
  const want = NAME_RE.test(base || '') ? base : 'web';
  const taken = new Set((await listSessions()).map((s) => s.name));
  if (!taken.has(want)) return want;
  for (let i = 2; ; i++) {
    const candidate = `${want}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function listWindows(name) {
  const out = await tmux([
    'list-windows', '-t', `=${name}`, '-F',
    `#{window_index}${FS}#{window_name}${FS}#{window_active}${FS}#{pane_current_command}`,
  ]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [index, wname, active, command] = line.split(FS);
    return {
      index: Number(index),
      name: wname || '',
      active: active === '1',
      command: command || '',
    };
  });
}

// One session's live command + directory (for the dynamic browser title).
async function sessionInfo(name) {
  const out = await tmux(['display-message', '-p', '-t', `=${name}:`, `#{pane_current_command}${FS}#{pane_current_path}`]);
  const [command, dir] = out.trim().split(FS);
  return { name, command: command || '', dir: dir || '', path: prettyPath(dir || '') };
}

// --- recent directories (history of closed sessions) -----------------------
// We sample live sessions; when one disappears, its last directory + command is
// pushed to a small persisted list so it can be reopened from the picker.
const STATE_DIR = process.env.WEBMUX_STATE || path.join(os.homedir(), '.local', 'state', 'webmux');
const HISTORY_FILE = path.join(STATE_DIR, 'recents.json');
const RECENTS_MAX = 30;
let recents = [];
let seen = new Map(); // session name -> { dir, command }

async function loadRecents() {
  try {
    const data = JSON.parse(await readFile(HISTORY_FILE, 'utf8'));
    if (Array.isArray(data)) recents = data.filter((r) => r && r.dir).slice(0, RECENTS_MAX);
  } catch { /* no history yet */ }
}

let saveTimer = null;
function saveRecents() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(HISTORY_FILE, JSON.stringify(recents, null, 2));
    } catch { /* best effort */ }
  }, 500);
}

function recordRecent(dir, command) {
  if (!dir) return;
  recents = recents.filter((r) => r.dir !== dir);
  recents.unshift({ dir, command: command || '', ts: Date.now() });
  if (recents.length > RECENTS_MAX) recents.length = RECENTS_MAX;
  saveRecents();
}

async function sampleSessions() {
  let out = '';
  try {
    out = await tmux(['list-sessions', '-F', `#{session_name}${FS}#{pane_current_path}${FS}#{pane_current_command}`]);
  } catch { /* no server -> every tracked session has closed */ }
  const current = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, dir, command] = line.split(FS);
    current.set(name, { dir, command });
  }
  for (const [name, info] of seen) {
    if (!current.has(name)) recordRecent(info.dir, info.command);
  }
  seen = current;
}

// --- tiny HTTP layer -------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(pathname));
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') {
    let tmuxState;
    try { tmuxState = { found: true, version: (await tmux(['-V'])).trim() }; }
    catch (e) { tmuxState = { found: false, error: e.message || String(e) }; }
    return sendJson(res, 200, {
      ok: tmuxState.found,
      platform: process.platform,
      node: process.version,
      tmuxBin: TMUX_BIN,
      tmux: tmuxState,
      PATH: process.env.PATH,
    });
  }
  if (url.pathname === '/api/sessions') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, { sessions: await listSessions() });
  }
  if (url.pathname === '/api/tailnet') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!TAILSCALE_ENABLED) return sendJson(res, 200, { enabled: false, self: null, peers: [] });
    const [self, peers] = await Promise.all([tailscaleSelf(), tailscalePeers()]);
    return sendJson(res, 200, { enabled: true, self, peers });
  }
  if (url.pathname === '/api/recents') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const open = new Set([...seen.values()].map((s) => s.dir));
    // Hide dirs that currently have a live session; abbreviate for display.
    const list = recents
      .filter((r) => !open.has(r.dir))
      .map((r) => ({ dir: r.dir, path: prettyPath(r.dir), command: r.command, ts: r.ts }));
    return sendJson(res, 200, { recents: list });
  }
  if (url.pathname === '/api/session') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const name = url.searchParams.get('name') || '';
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid session name' });
    try { return sendJson(res, 200, await sessionInfo(name)); }
    catch { return sendJson(res, 404, { error: 'session not found' }); }
  }
  if (url.pathname === '/api/capture') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const name = url.searchParams.get('name') || '';
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid session name' });
    try {
      // -S -5000: up to 5000 lines of scrollback; -J joins wrapped lines for clean copy.
      const out = await tmux(['capture-pane', '-t', `=${name}:`, '-p', '-J', '-S', '-5000']);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(out);
    } catch {
      return sendJson(res, 404, { error: 'capture failed' });
    }
  }
  if (url.pathname === '/api/open') {
    // Open an existing session as a real terminal window on the PC. Useful for
    // sessions that only live in tmux (created from the phone, or auto-tmux) and
    // aren't yet visible at the desk. launchDesktop runs `tmux new-session -A`,
    // which attaches to the existing session rather than creating a new one.
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const name = url.searchParams.get('name') || '';
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid session name' });
    try {
      await tmux(['has-session', '-t', `=${name}`]); // throws if missing
      launchDesktop(name);
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 404, { error: 'session not found' });
    }
  }
  if (url.pathname === '/api/kill') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const name = url.searchParams.get('name') || '';
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid session name' });
    try {
      await tmux(['kill-session', '-t', `=${name}`]);
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 404, { error: 'kill failed' });
    }
  }
  if (url.pathname === '/api/windows') {
    const name = url.searchParams.get('name') || '';
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid session name' });
    if (req.method === 'GET') {
      try { return sendJson(res, 200, { windows: await listWindows(name) }); }
      catch { return sendJson(res, 404, { error: 'session not found' }); }
    }
    if (req.method === 'POST') {
      const action = url.searchParams.get('action');
      const index = parseInt(url.searchParams.get('index'), 10);
      const target = Number.isFinite(index) ? `=${name}:${index}` : `=${name}`;
      try {
        if (action === 'select') await tmux(['select-window', '-t', target]);
        else if (action === 'new') await tmux(['new-window', '-t', `=${name}`]);
        else if (action === 'kill') await tmux(['kill-window', '-t', target]);
        else return sendJson(res, 400, { error: 'unknown action' });
        return sendJson(res, 200, { windows: await listWindows(name) });
      } catch {
        return sendJson(res, 404, { error: 'window action failed' });
      }
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, url);
});

// --- WebSocket / PTY bridge ------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// Heartbeat: ping every 30s, drop a client that misses a pong. This frees the
// PTY (detaching tmux) when a phone vanishes without a clean close.
const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

function sendCtrl(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['ws','session','name']
  let mode = null;
  let name = '';
  if (parts[0] === 'ws' && parts[1] === 'session' && parts.length >= 3) {
    mode = 'attach';
    name = decodeURIComponent(parts.slice(2).join('/'));
  } else if (parts[0] === 'ws' && parts[1] === 'new') {
    mode = 'new';
    name = url.searchParams.get('name') || '';
  } else {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => startSession(ws, mode, name, url));
});

async function startSession(ws, mode, name, url) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const cols = clampInt(url.searchParams.get('cols'), 80, 1, 1000);
  const rows = clampInt(url.searchParams.get('rows'), 24, 1, 1000);

  let args;
  try {
    if (mode === 'attach') {
      if (!NAME_RE.test(name)) throw new Error('invalid session name');
      await tmux(['has-session', '-t', `=${name}`]); // throws if missing
      args = ['attach-session', '-t', `=${name}`];
    } else {
      name = await uniqueName(name);
      // Optional start directory (e.g. reopening a recent dir from history).
      const dir = url.searchParams.get('dir') || '';
      const create = ['new-session', '-d', '-s', name];
      if (dir) create.push('-c', dir);
      // Create the session up front — detached and persistent — in one atomic
      // command. The global `destroy-unattached on` would otherwise reap it the
      // instant no client is attached (e.g. before the desktop window attaches,
      // or after the phone leaves). Setting destroy-unattached off per-session
      // makes it always survive and stay returnable. Then attach the browser.
      await tmux([...create, ';', 'set-option', '-t', name, 'destroy-unattached', 'off']);
      if (url.searchParams.get('desktop') === '1') launchDesktop(name);
      args = ['attach-session', '-t', `=${name}`];
    }
  } catch (e) {
    sendCtrl(ws, {
      type: 'error',
      message: mode === 'attach' ? `session not found: ${name}` : `could not create session: ${e.message || e}`,
    });
    return ws.close();
  }

  let term;
  try {
    term = pty.spawn(TMUX_BIN, tmuxArgv(args), {
      name: TERM_NAME,
      cols,
      rows,
      cwd: HOME || process.cwd(),
      env: process.env,
    });
  } catch (e) {
    sendCtrl(ws, { type: 'error', message: `failed to start tmux: ${e.message}` });
    return ws.close();
  }

  sendCtrl(ws, { type: 'session', name, cols, rows });

  let alive = true;
  const detach = () => {
    if (!alive) return;
    alive = false;
    try { term.kill(); } catch { /* already gone */ }
  };

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8')); // binary frame
  });
  term.onExit(({ exitCode }) => {
    alive = false;
    sendCtrl(ws, { type: 'exit', code: exitCode });
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      term.write(data.toString('utf8')); // terminal input
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'resize') {
      try { term.resize(clampInt(msg.cols, cols, 1, 1000), clampInt(msg.rows, rows, 1, 1000)); } catch { /* race with exit */ }
    } else if (msg.type === 'ping') {
      sendCtrl(ws, { type: 'pong' }); // app-level liveness probe from the client
    }
  });

  ws.on('close', detach);
  ws.on('error', detach);
}

server.listen(PORT, HOST, () => {
  console.log(`webmux listening on http://${HOST}:${PORT}`);
});

// Track recent directories: seed from current sessions, then sample so that a
// session disappearing records its last directory into the history.
await loadRecents();
await sampleSessions();
const sampler = setInterval(() => { sampleSessions().catch(() => {}); }, 5000);
sampler.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
