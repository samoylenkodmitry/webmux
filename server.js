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
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const execFileP = promisify(execFile);

// Terminal emulator used to open a session on the local desktop. Override with
// DESKTOP_TERMINAL (must accept `-e <cmd...>`, like ghostty/kitty/alacritty/xterm).
const DESKTOP_TERMINAL = process.env.DESKTOP_TERMINAL || 'ghostty';

// Open a real terminal window on the PC attached to the tmux session, so it is
// visible locally and (being a second client) outlives the browser. Best-effort:
// if there's no display or the emulator is missing, the web session still works.
function launchDesktop(name) {
  try {
    const child = spawn(DESKTOP_TERMINAL, ['-e', 'tmux', 'new-session', '-A', '-s', name], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
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
  const { stdout } = await execFileP('tmux', args, { encoding: 'utf8' });
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
      // Create the session up front — detached and persistent — in one atomic
      // command. The global `destroy-unattached on` would otherwise reap it the
      // instant no client is attached (e.g. before the desktop window attaches,
      // or after the phone leaves). Setting destroy-unattached off per-session
      // makes it always survive and stay returnable. Then attach the browser.
      await tmux(['new-session', '-d', '-s', name, ';', 'set-option', '-t', name, 'destroy-unattached', 'off']);
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
    term = pty.spawn('tmux', args, {
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
  console.log(`phone-terminal-web listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
