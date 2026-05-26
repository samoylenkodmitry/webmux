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

// Optional explicit terminal emulator for "open on PC" (must accept `-e <cmd…>`,
// e.g. ghostty/kitty/alacritty/xterm). If unset, a per-OS default is used.
const DESKTOP_TERMINAL = process.env.DESKTOP_TERMINAL || '';

// How to spawn a terminal window that runs `tmux new-session -A -s <name>`.
function desktopLaunchSpec(name) {
  const run = ['tmux', ...(TMUX_SOCKET ? ['-L', TMUX_SOCKET] : []), 'new-session', '-A', '-s', name];
  if (DESKTOP_TERMINAL) return [DESKTOP_TERMINAL, ['-e', ...run]];
  if (process.platform === 'darwin') {
    // macOS apps generally can't be driven by `-e` from the CLI, so open a
    // Terminal.app window via AppleScript. `name` is validated by NAME_RE, so
    // there are no quotes/spaces to escape inside the script string.
    return ['osascript', ['-e', `tell application "Terminal" to do script "${run.join(' ')}"`]];
  }
  return ['ghostty', ['-e', ...run]]; // Linux default
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

// tmux session names we are willing to touch. node-pty spawns tmux with an arg
// array (no shell), so this is belt-and-suspenders, not the only defense.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// --- tmux helpers ----------------------------------------------------------

async function tmux(args) {
  const { stdout } = await execFileP('tmux', tmuxArgv(args), { encoding: 'utf8' });
  return stdout;
}

function prettyPath(p) {
  if (!p) return '';
  if (p === HOME) return '~';
  if (HOME && p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

async function listSessions() {
  let out;
  try {
    // Pane vars resolve against each session's active pane, so one call is enough.
    out = await tmux([
      'list-sessions', '-F',
      '#{session_name}\t#{session_attached}\t#{session_windows}\t#{pane_current_command}\t#{pane_current_path}',
    ]);
  } catch {
    return []; // no server running -> no sessions
  }
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, attached, windows, command, cwd] = line.split('\t');
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
    '#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}',
  ]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [index, wname, active, command] = line.split('\t');
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
  const out = await tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_command}\t#{pane_current_path}']);
  const [command, dir] = out.trim().split('\t');
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
    out = await tmux(['list-sessions', '-F', '#{session_name}\t#{pane_current_path}\t#{pane_current_command}']);
  } catch { /* no server -> every tracked session has closed */ }
  const current = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, dir, command] = line.split('\t');
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
  if (url.pathname === '/api/sessions') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, { sessions: await listSessions() });
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
  } catch {
    sendCtrl(ws, {
      type: 'error',
      message: mode === 'attach' ? `session not found: ${name}` : 'could not create session',
    });
    return ws.close();
  }

  let term;
  try {
    term = pty.spawn('tmux', tmuxArgv(args), {
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
