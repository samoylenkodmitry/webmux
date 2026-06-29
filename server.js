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
import { readFile, writeFile, mkdir, readdir, statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
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

// The published installer one-liner (see README). The "Update" button runs this
// inside a visible tmux session so the user can watch the box self-update and the
// service restart. Overridable for forks/testing.
const INSTALL_URL = process.env.WEBMUX_INSTALL_URL || 'https://raw.githubusercontent.com/samoylenkodmitry/webmux/main/install.sh';
const UPDATE_SESSION = 'webmux-update';

// Tailscale UI integration is opt-in via the installer; the env var also acts
// as a hard kill-switch when users don't want webmux invoking `tailscale` at all.
const TAILSCALE_ENABLED = process.env.WEBMUX_TAILSCALE === '1';

// Set by the Android WebMux Host (Userland.startWebmux). On a phone there's no
// systemd, so self-update can't `systemctl restart`; instead we pull and let the
// host's runWebmuxForever supervisor restart the process. Also drives battery
// back-off (slower polling when no client is attached).
const IS_ANDROID = process.env.WEBMUX_ANDROID === '1';

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

async function tailscaleStatus() {
  try {
    const status = JSON.parse(await runTailscale(['status', '--json', '--self=true']));
    const self = status.Self || {};
    const dns = (self.DNSName || '').replace(/\.$/, '');
    if (dns) _selfDns = dns; // so our probes can self-identify to phone peers
    const keyExpiry = self.KeyExpiry || '';
    const expiryMs = keyExpiry ? Date.parse(keyExpiry) : NaN;
    const keyExpired = Boolean(self.Expired) || (Number.isFinite(expiryMs) && expiryMs <= Date.now());
    const backendState = status.BackendState || '';
    return {
      present: true,
      backendState,
      running: backendState === 'Running',
      needsLogin: backendState === 'NeedsLogin' || keyExpired,
      health: Array.isArray(status.Health) ? status.Health : [],
      dns,
      keyExpiry,
      keyExpired,
      magicDNSSuffix: status.MagicDNSSuffix || (status.CurrentTailnet && status.CurrentTailnet.MagicDNSSuffix) || '',
    };
  } catch (e) {
    return { present: false, error: e.message || String(e) };
  }
}

// A peer connection descriptor. PC peers sit behind `tailscale serve` (HTTPS on
// :443, reached by dialing the Tailscale IP with the MagicDNS name as SNI+Host so
// the serve cert validates even when this node's MagicDNS can't resolve .ts.net).
// Phones can't run `tailscale serve`, so they run webmux as plain HTTP on their
// Tailscale IP — fine, because WireGuard already encrypts the tailnet. `conn`
// captures whichever applies so every peer call works the same way.
function httpsConn(ip, dns) { return { tls: true, host: ip, port: 443, servername: dns, hostHeader: dns, urlBase: `https://${dns}/` }; }
function httpConn(ip, port) { return { tls: false, host: ip, port, hostHeader: `${ip}:${port}`, urlBase: `http://${ip}:${port}/` }; }

// Zero-config discovery for nodes that can't run `tailscale status` (a phone whose
// webmux lives in a proot box): every webmux prober tags its requests with its own
// tailnet name (X-Webmux-Self), so such a node learns its peers from whoever probes
// it — the fleet is already knocking on its door every discovery cycle. No login,
// no coordinator. `_selfDns` is our own name (set once we read tailscale status).
let _selfDns = '';
const seenPeers = new Map(); // tailnet IP -> { dns, stamp }
const isTailnetIp = (ip) => {
  const m = /^(\d+)\.(\d+)\./.exec(ip || '');
  return Boolean(m) && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127;
};
const SELF_TAILNET_IP = isTailnetIp(process.env.HOST || '') ? process.env.HOST : null;
function clientTailnetIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return isTailnetIp(ip) ? ip : null;
}

// Defense-in-depth, zero user friction: even though the listener is bound to the tun
// interface, also reject any connection whose SOURCE isn't the tailnet (CGNAT 100.64/10
// or Tailscale's IPv6 ULA fd7a:115c:a1e0::/48) or on-device loopback. So if a bind ever
// lands on a hostile network (Tailscale off + a carrier-grade-NAT WiFi, a future bug),
// webmux — which has no auth — still serves nobody. Enforced on phones, where access is
// strictly tailnet/loopback; a PC may be reached over its LAN, so opt out with
// WEBMUX_TRUST_LAN=1. This can't isolate other devices already on your tailnet (that
// needs a secret you'd have to hold) — it closes the off-tailnet-exposure hole only.
function remoteOnTailnet(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '127.0.0.1' || ip === '::1') return true;            // loopback (on-device, tailscale serve)
  if (isTailnetIp(ip)) return true;                               // 100.64.0.0/10
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0')) return true; // Tailscale IPv6 ULA
  return false;
}
const ENFORCE_TAILNET = IS_ANDROID && process.env.WEBMUX_TRUST_LAN !== '1';

// One request to a peer over its conn. Resolves { status, body } or null on a
// connection error / timeout. Body is capped.
function peerHttp(conn, { method = 'GET', path = '/', body = null, timeoutMs = 4000, maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const headers = { Host: conn.hostHeader, 'X-Webmux-Self': _selfDns };
    let payload = null;
    if (body != null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    } else if (method === 'POST') {
      headers['Content-Length'] = 0;
    }
    const opts = { host: conn.host, port: conn.port, path, method, headers, timeout: timeoutMs };
    if (conn.tls && conn.servername) opts.servername = conn.servername;
    const req = (conn.tls ? https : http).request(opts, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > maxBytes) req.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body: b }));
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Is there a webmux at this conn? Returns its /api/health JSON if so, else null.
async function probeWebmuxHealth(conn, timeoutMs) {
  const r = await peerHttp(conn, { path: '/api/health', timeoutMs, maxBytes: 65536 });
  if (!r || r.status !== 200) return null;
  try { const j = JSON.parse(r.body); return j && typeof j === 'object' && 'tmuxBin' in j ? j : null; }
  catch { return null; }
}

// GET <path> from a peer over its conn, parsed JSON or null. Used to pull a
// peer's session list / stats so the picker can show every machine.
async function fetchPeerJson(conn, reqPath, timeoutMs) {
  const r = await peerHttp(conn, { path: reqPath, timeoutMs });
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

// POST https://<dns>/api/update on a peer to ask it to self-update. Best-effort:
// resolves true if the peer accepted. Same SNI + Host dialing as the GET helper.
async function postPeerUpdate(conn, timeoutMs) {
  const r = await peerHttp(conn, { method: 'POST', path: '/api/update', timeoutMs });
  return Boolean(r && r.status === 200);
}

// Bootstrap a peer that's too OLD to have /api/update: drive its `/ws/new` the
// same way the UI does — it opens a tmux session with a shell — and "type" the
// installer one-liner into it. The install is wrapped in `nohup … & disown` so it
// detaches from the throwaway session and survives both the session closing and
// the service restart it triggers. Resolves true once the command was dispatched.
function bootstrapPeerViaShell(conn, connectTimeoutMs) {
  return new Promise((resolve) => {
    let settled = false, sent = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    let ws;
    try {
      const wsOpts = { headers: { Host: conn.hostHeader }, handshakeTimeout: connectTimeoutMs };
      if (conn.tls && conn.servername) wsOpts.servername = conn.servername;
      ws = new WsClient(`${conn.tls ? 'wss' : 'ws'}://${conn.host}:${conn.port}/ws/new?cols=80&rows=24`, wsOpts);
    } catch { return resolve(false); }
    const giveUp = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } settle(false); }, connectTimeoutMs + 8000);
    ws.on('message', (data, isBinary) => {
      if (isBinary || sent) return;
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'session') {
        sent = true;
        // Let the shell's rc settle, then send a detached self-update + exit.
        setTimeout(() => {
          // Env var must sit on `bash` (the installer), not `curl`. cd to a dir
          // without a server.js so install.sh takes its git-update path.
          const inner = `cd /tmp && curl -fsSL ${INSTALL_URL} | WEBMUX_NONINTERACTIVE=1 bash`;
          const cmd = `nohup sh -c '${inner}' >/tmp/webmux-update.log 2>&1 </dev/null & disown 2>/dev/null; exit\n`;
          try { ws.send(Buffer.from(cmd, 'utf8')); }
          catch { clearTimeout(giveUp); return settle(false); }
          // Command dispatched — that's success. The `exit` in it makes the peer
          // close the socket almost immediately; resolve now so that close (which
          // would otherwise settle false) is a no-op. nohup keeps the install alive.
          clearTimeout(giveUp);
          settle(true);
          setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 1500);
        }, 1000);
      } else if (msg.type === 'error') {
        clearTimeout(giveUp); settle(false);
      }
    });
    ws.on('error', () => { clearTimeout(giveUp); settle(false); });
    ws.on('close', () => { clearTimeout(giveUp); settle(false); });
  });
}

// Update one peer: prefer the native endpoint (clean, watchable session on newer
// builds); fall back to driving its shell over /ws/new for builds that predate it.
async function updatePeer(p) {
  if (await postPeerUpdate(p.conn, 8000)) return { name: p.name, dns: p.dns, ip: p.ip, ok: true, via: 'api' };
  const ok = await bootstrapPeerViaShell(p.conn, 6000);
  return { name: p.name, dns: p.dns, ip: p.ip, ok, via: ok ? 'shell' : 'fail' };
}

// Cached peer probe — discovering peers means a round-trip to every online tailnet
// node, so we cache the result for a few seconds rather than hammering on every
// picker refresh. Ports a phone might run webmux on (plain HTTP); overridable.
const PEER_CACHE_MS = 10_000;
const PEER_HTTP_PORTS = (process.env.WEBMUX_PEER_PORTS || '8083').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
let _peersCachePromise = null;
let _peersCacheStamp = 0;
// Peers that have probed us recently (the learned-discovery fallback). Pruned to a
// 2-minute window so a node that goes offline drops out of the picker.
function learnedNodes() {
  const cutoff = Date.now() - 120_000;
  const out = [];
  for (const [ip, v] of seenPeers) {
    if (v.stamp < cutoff) { seenPeers.delete(ip); continue; }
    out.push({ name: v.dns || ip, dns: v.dns || '', ip });
  }
  return out;
}

// Confirm each candidate is a webmux and capture how to reach it. PCs answer over
// tailscale-serve HTTPS (dial the IP, present the name as SNI+Host); phones over
// plain HTTP on a port. A learned phone peer may have no name — HTTP-only then.
async function probeNodes(nodes) {
  const probes = nodes.map(async (n) => {
    if (n.dns) {
      const hc = httpsConn(n.ip, n.dns);
      const h = await probeWebmuxHealth(hc, 2500);
      if (h) { const node = { name: n.name, dns: n.dns, ip: n.ip, url: hc.urlBase, conn: hc, power: h.power || null }; recordWakeEndpoint(node, h.wakeEndpoint); return node; }
    }
    for (const port of PEER_HTTP_PORTS) {
      const pc = httpConn(n.ip, port);
      const h = await probeWebmuxHealth(pc, 1500);
      if (h) { const node = { name: n.name, dns: n.dns || '', ip: n.ip, url: pc.urlBase, conn: pc, power: h.power || null }; recordWakeEndpoint(node, h.wakeEndpoint); return node; }
    }
    return null;
  });
  return (await Promise.all(probes)).filter(Boolean);
}

async function tailscalePeers() {
  const now = Date.now();
  if (_peersCachePromise && now - _peersCacheStamp < PEER_CACHE_MS) return _peersCachePromise;
  _peersCacheStamp = now;
  _peersCachePromise = (async () => {
    let nodes = null;
    try {
      const status = JSON.parse(await runTailscale(['status', '--json']));
      if (status.BackendState && status.BackendState !== 'Running') return [];
      nodes = Object.values(status.Peer || {})
        .filter((p) => p.Online && !p.Expired && p.InNetworkMap !== false && p.DNSName && Array.isArray(p.TailscaleIPs) && p.TailscaleIPs.length)
        .map((p) => {
          const dns = p.DNSName.replace(/\.$/, '');
          const ip = p.TailscaleIPs.find((a) => a.includes('.')) || p.TailscaleIPs[0];
          return { name: p.HostName || dns, dns, ip };
        });
    } catch {
      nodes = null; // no tailscale CLI here (a phone's proot box) — learn instead
    }
    if (!nodes) nodes = learnedNodes();
    return probeNodes(nodes);
  })();
  return _peersCachePromise;
}

// Best-effort lookup of this node's own tailnet HTTPS URL from `tailscale serve
// status`. Returns { url, dns } when serve is configured for our port; null
// otherwise (tailscale missing, not logged in, no serve config, etc.).
async function tailscaleSelf(status = null) {
  try {
    const ts = status || await tailscaleStatus();
    const serveOut = await runTailscale(['serve', 'status', '--json']);
    const serve = JSON.parse(serveOut);
    const dns = ts.dns || '';
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

// A background user service (systemd/launchd) starts without the graphical
// session's env — so it has no DISPLAY/WAYLAND_DISPLAY/DBUS address and any GUI
// terminal it spawns can't reach the display and dies silently. The desktop
// imports those vars into the systemd *user manager* on login, so read them back
// from there at spawn time (always current, never hardcoded) and pass them to
// the child. Linux-only: macOS launches GUI apps via open/osascript without these.
const GRAPHICAL_VARS = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP',
];
const GRAPHICAL_ENV_TTL = 5000;
let _graphicalEnvPromise = null;
let _graphicalEnvStamp = 0;
function graphicalEnv() {
  if (process.platform !== 'linux') return Promise.resolve({});
  const now = Date.now();
  if (_graphicalEnvPromise && now - _graphicalEnvStamp < GRAPHICAL_ENV_TTL) return _graphicalEnvPromise;
  _graphicalEnvStamp = now;
  _graphicalEnvPromise = (async () => {
    try {
      // `systemctl --user` reaches the manager over $XDG_RUNTIME_DIR (no DISPLAY
      // needed), so this works even though our own process lacks the GUI env.
      const { stdout } = await execFileP('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
      const env = {};
      for (const line of stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        if (!GRAPHICAL_VARS.includes(key)) continue;
        let val = line.slice(eq + 1);
        if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1).replace(/\\(["\\])/g, '$1'); // systemd quotes only when needed
        }
        if (val) env[key] = val;
      }
      return env;
    } catch {
      return {}; // no user manager / systemctl: fall back to process.env
    }
  })();
  return _graphicalEnvPromise;
}

// Open a real terminal window on the PC attached to the tmux session, so it is
// visible locally and (being a second client) outlives the browser. Best-effort:
// if there's no display or the emulator is missing, the web session still works.
async function launchDesktop(name) {
  const [cmd, args] = desktopLaunchSpec(name);
  const env = { ...process.env, ...(await graphicalEnv()) };
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
    child.on('error', () => {}); // emulator missing / no display: ignore
    child.unref();
  } catch { /* ignore */ }
}

// Run the published installer one-liner inside a fresh `webmux-update` tmux
// session so the user can attach and watch the box self-update + restart. The
// session lives on webmux's own tmux server (shows up in the picker), runs
// non-interactively so it never blocks on a prompt, and drops to a shell after so
// the result stays visible. The tmux process is independent of this Node server,
// so the install's `systemctl restart` doesn't kill the update mid-run.
async function startUpdateSession() {
  try { await tmux(['kill-session', '-t', `=${UPDATE_SESSION}`]); } catch { /* none running yet */ }
  // cd /tmp so install.sh doesn't see this dir's server.js and skip the git pull;
  // WEBMUX_NONINTERACTIVE must sit on `bash`, not `curl`, to take effect.
  const script =
    "clear 2>/dev/null; printf '\\033[1m== webmux update ==\\033[0m\\n'; cd /tmp; " +
    'curl -fsSL ' + INSTALL_URL + ' | WEBMUX_NONINTERACTIVE=1 bash; ' +
    'code=$?; printf \'\\n== update finished (exit %s) -- this shell stays open ==\\n\' "$code"; ' +
    'exec "${SHELL:-/bin/sh}"';
  await tmux(['new-session', '-d', '-s', UPDATE_SESSION, script]);
  // Survive having no client attached (e.g. while the service restarts).
  try { await tmux(['set-option', '-t', UPDATE_SESSION, 'destroy-unattached', 'off']); } catch { /* best effort */ }
}

// Self-update on Android: there's no systemd, so the installer's `systemctl restart`
// is a no-op and the box would keep serving the old code forever ("stuck updating").
// Instead, pull origin/main in an independent tmux session (the box's tmux server
// outlives this Node process), then `kill` ourselves — the WebMux Host's
// runWebmuxForever supervisor immediately re-execs `node server.js` on the fresh
// checkout. Same PID namespace under proot, so the kill reaches us.
async function startAndroidSelfUpdate() {
  try { await tmux(['kill-session', '-t', `=${UPDATE_SESSION}`]); } catch { /* none running yet */ }
  const script =
    "clear 2>/dev/null; printf '\\033[1m== webmux update (android) ==\\033[0m\\n'; " +
    `cd ${__dirname} && ` +
    'git fetch --quiet origin main && git reset --hard origin/main && ' +
    '(npm install --no-audit --no-fund || true); ' +
    "printf '\\n== pulled — restarting webmux ==\\n'; " +
    `kill ${process.pid}; ` +
    'exec "${SHELL:-/bin/sh}"';
  await tmux(['new-session', '-d', '-s', UPDATE_SESSION, script]);
  try { await tmux(['set-option', '-t', UPDATE_SESSION, 'destroy-unattached', 'off']); } catch { /* best effort */ }
}

// Short git hash of the running checkout — the fleet-update progress UI uses it to
// tell when a machine has actually restarted onto the new code. Cached for the
// life of the process (the install restarts us, so a fresh process re-reads it).
let _versionPromise = null;
function webmuxVersion() {
  if (_versionPromise) return _versionPromise;
  _versionPromise = (async () => {
    try {
      const { stdout } = await execFileP('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
      return stdout.trim();
    } catch { return ''; }
  })();
  return _versionPromise;
}

// The version the fleet will CONVERGE TO on update: the installer does
// `git reset --hard origin/main`, so the target is the *remote* main HEAD — not this
// coordinator's local version (which may be behind). Polling the coordinator's own
// version as the target leaves every peer stuck "updating…" forever when the
// coordinator isn't on HEAD. Falls back to local if the fetch fails.
async function remoteTargetVersion() {
  try {
    await execFileP('git', ['-C', __dirname, 'fetch', '--quiet', 'origin', 'main'], { encoding: 'utf8', timeout: 15000 });
    const { stdout } = await execFileP('git', ['-C', __dirname, 'rev-parse', '--short', 'origin/main'], { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return webmuxVersion();
  }
}

// --- machine stats (CPU / GPU / disk / RAM) for the picker's machine row ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
async function cpuPercent() {
  const a = cpuTimes();
  await sleep(120);
  const b = cpuTimes();
  const dt = b.total - a.total, di = b.idle - a.idle;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null;
}
// Best-effort GPU utilisation %: NVIDIA via nvidia-smi, else AMD/Intel via the
// DRM sysfs `gpu_busy_percent`. Returns null when nothing reports it. We stop
// trying nvidia-smi once it's clearly absent, so we don't spawn it every poll.
let _noNvidia = false;
async function gpuPercent() {
  if (!_noNvidia) {
    try {
      const { stdout } = await execFileP('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 1500 });
      const v = parseInt(stdout.trim().split('\n')[0], 10);
      if (Number.isFinite(v)) return v;
    } catch (e) { if (e && e.code === 'ENOENT') _noNvidia = true; /* nvidia-smi not installed */ }
  }
  try {
    for (const d of await readdir('/sys/class/drm')) {
      if (!/^card\d+$/.test(d)) continue;
      try {
        const v = parseInt(await readFile(`/sys/class/drm/${d}/device/gpu_busy_percent`, 'utf8'), 10);
        if (Number.isFinite(v)) return v;
      } catch { /* try next card */ }
    }
  } catch { /* no drm sysfs */ }
  return null;
}
async function diskFree() {
  try {
    const s = await statfs('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { free, total, usedPct: total ? Math.round((1 - free / total) * 100) : null };
  } catch { return null; }
}
function memPercent() {
  const total = os.totalmem();
  return total ? Math.round((1 - os.freemem() / total) * 100) : null;
}
async function cpuTemp() {
  if (process.platform !== 'linux') return null;
  try {
    let cpu = null, fallback = null;
    for (const d of await readdir('/sys/class/thermal')) {
      if (!/^thermal_zone\d+$/.test(d)) continue;
      let type = '', v = NaN;
      try { type = (await readFile(`/sys/class/thermal/${d}/type`, 'utf8')).trim().toLowerCase(); } catch { /* no type */ }
      try { v = parseInt(await readFile(`/sys/class/thermal/${d}/temp`, 'utf8'), 10); } catch { /* no temp */ }
      if (!Number.isFinite(v) || v <= 0 || v >= 200000) continue;
      const c = Math.round(v / 1000);
      // Prefer a CPU/package zone; otherwise fall back to the hottest sensor.
      if (/cpu|coretemp|x86_pkg|package|k10temp|zenpower|tctl|tdie/.test(type)) cpu = cpu == null ? c : Math.max(cpu, c);
      fallback = Math.max(fallback ?? 0, c);
    }
    return cpu != null ? cpu : fallback;
  } catch { return null; }
}
// Top processes by CPU (name + %). Linux/macOS ps differ on the all-processes flag.
async function topProcs() {
  try {
    const args = process.platform === 'darwin' ? ['-A', '-o', 'pcpu=,comm=', '-r'] : ['-eo', 'pcpu=,comm=', '--sort=-pcpu'];
    const { stdout } = await execFileP('ps', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const out = [];
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^([\d.]+)\s+(.+)$/);
      if (!m) continue;
      out.push({ cpu: Math.round(parseFloat(m[1]) * 10) / 10, cmd: m[2].split('/').pop() });
      if (out.length >= 5) break;
    }
    return out;
  } catch { return []; }
}
// Cached so rapid polls (and several browser tabs) don't each pay the CPU sample.
// NOTE: deliberately excludes top processes — `ps -e` over all of /proc is too
// heavy for the every-5s poll on slow boxes (it pinned an Orange Pi). Top procs
// are fetched on demand via /api/procs only when the detail sheet is opened.
let _statsCache = null, _statsStamp = 0;
async function machineStats() {
  const now = Date.now();
  if (_statsCache && now - _statsStamp < 2000) return _statsCache;
  const [cpu, gpu, disk, temp] = await Promise.all([cpuPercent(), gpuPercent(), diskFree(), cpuTemp()]);
  _statsStamp = Date.now();
  _statsCache = {
    host: os.hostname(), cpu, gpu, mem: memPercent(), disk, temp,
    uptime: Math.round(os.uptime()),
    load: os.loadavg().map((x) => Math.round(x * 100) / 100),
  };
  return _statsCache;
}

// Read a JSON request body (small, capped). Used by POST endpoints with payloads.
function readBody(req, max = 65536) {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
// Run a shell command (broadcast), capturing combined output (bounded + timed).
async function runCommand(cmd) {
  const host = os.hostname();
  if (!cmd || typeof cmd !== 'string') return { host, ok: false, output: 'no command' };
  try {
    const { stdout, stderr } = await execFileP('sh', ['-c', cmd], { encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024, cwd: HOME || process.cwd(), env: process.env });
    return { host, ok: true, code: 0, output: (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).slice(0, 8000) };
  } catch (e) {
    const out = (String(e.stdout || '') + String(e.stderr || '')).slice(0, 8000) || (e.killed ? 'timed out' : (e.message || 'failed'));
    return { host, ok: false, code: e.code ?? 1, output: out };
  }
}
// POST JSON to a peer (used for broadcast fan-out). Returns parsed JSON or null.
async function postPeerJson(conn, reqPath, bodyObj, timeoutMs) {
  const r = await peerHttp(conn, { method: 'POST', path: reqPath, body: bodyObj || {}, timeoutMs });
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
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

async function ensureTmuxMouse() {
  try {
    await tmux(['set-option', '-g', 'mouse', 'on']);
  } catch {
    // Attach/create paths below will report real tmux failures to the client.
  }
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

// tmux's `pane_current_command` is just the comm of the pane's foreground process
// — so `sudo btop` shows as "sudo". Resolve the pane's controlling-terminal
// foreground process group (via /proc tpgid) and read its full argv for a much
// more informative label. Linux-only; elsewhere we keep the comm.
function cleanCommand(argv) {
  if (!argv || !argv.length) return '';
  let prog = String(argv[0]).replace(/^-/, '');   // login shells appear as "-zsh"
  prog = prog.split('/').pop();                    // basename of the program
  const s = [prog, ...argv.slice(1)].join(' ').trim();
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}
async function foregroundCommand(panePid, fallback) {
  const pid = Number(panePid);
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return fallback;
  try {
    // /proc/<pid>/stat: after the "(comm)" field come state ppid pgrp session
    // tty_nr tpgid … — index 5 past the last ')' is tpgid (foreground pgid).
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const tpgid = parseInt(after[5], 10);
    const target = Number.isInteger(tpgid) && tpgid > 0 ? tpgid : pid;
    const argv = (await readFile(`/proc/${target}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    return argv.length ? cleanCommand(argv) : fallback;
  } catch {
    return fallback;
  }
}

async function listSessions() {
  let out;
  try {
    // Pane vars resolve against each session's active pane, so one call is enough.
    out = await tmux([
      'list-sessions', '-F',
      `#{session_name}${FS}#{session_attached}${FS}#{session_windows}${FS}#{pane_current_command}${FS}#{pane_current_path}${FS}#{pane_pid}${FS}#{session_activity}`,
    ]);
  } catch {
    return []; // no server running -> no sessions
  }
  const rows = out.split('\n').filter(Boolean).map((line) => {
    const [name, attached, windows, command, cwd, panePid, activity] = line.split(FS);
    return {
      name,
      attached: Number(attached) || 0,
      windows: Number(windows) || 0,
      command: command || '',
      path: prettyPath(cwd || ''),
      activity: Number(activity) || 0, // unix seconds of last activity (for "new" badges)
      panePid,
    };
  });
  // Upgrade each comm to the full foreground command line (best-effort, parallel).
  await Promise.all(rows.map(async (r) => { r.command = await foregroundCommand(r.panePid, r.command); delete r.panePid; }));
  return rows;
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

// One session's live command + directory (for the dynamic browser title). Also
// returns session_activity so the client can mark this session "seen".
async function sessionInfo(name) {
  const out = await tmux(['display-message', '-p', '-t', `=${name}:`, `#{pane_current_command}${FS}#{pane_current_path}${FS}#{session_activity}`]);
  const [command, dir, activity] = out.trim().split(FS);
  return { name, command: command || '', dir: dir || '', path: prettyPath(dir || ''), activity: Number(activity) || 0 };
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

// --- quick-reply snippets (shared across the fleet) ------------------------
// Stored server-side and persisted, so editing them on one webmux can be pushed
// to every tailnet peer (each box's clients read from their own server).
const SNIPPETS_FILE = path.join(STATE_DIR, 'snippets.json');
const DEFAULT_SNIPPETS = ['y', 'n', 'continue', 'approve', '/clear', 'exit'];
let snippets = DEFAULT_SNIPPETS.slice();
async function loadSnippetsFile() {
  try {
    const a = JSON.parse(await readFile(SNIPPETS_FILE, 'utf8'));
    if (Array.isArray(a)) snippets = a.filter((s) => typeof s === 'string');
  } catch { /* keep defaults */ }
}
function saveSnippetsFile() {
  mkdir(STATE_DIR, { recursive: true }).then(() => writeFile(SNIPPETS_FILE, JSON.stringify(snippets))).catch(() => {});
}

// --- Web Push (activity alerts) --------------------------------------------
// Notify the phone when a session that was producing output goes quiet while no
// client is attached — i.e. "your agent/build finished and is waiting." Best
// effort: if web-push isn't installed, the endpoints just report disabled.
const VAPID_FILE = path.join(STATE_DIR, 'vapid.json');
const SUBS_FILE = path.join(STATE_DIR, 'push-subs.json');
let webpush = null;
let vapid = null;
let pushSubs = [];
async function initPush() {
  try { webpush = (await import('web-push')).default; }
  catch { return; } // dependency missing → push disabled, server still runs
  try { vapid = JSON.parse(await readFile(VAPID_FILE, 'utf8')); } catch { vapid = null; }
  if (!vapid || !vapid.publicKey || !vapid.privateKey) {
    vapid = webpush.generateVAPIDKeys();
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(VAPID_FILE, JSON.stringify(vapid)); } catch { /* best effort */ }
  }
  webpush.setVapidDetails('mailto:webmux@localhost', vapid.publicKey, vapid.privateKey);
  try { const d = JSON.parse(await readFile(SUBS_FILE, 'utf8')); if (Array.isArray(d)) pushSubs = d; } catch { /* none yet */ }
}
function savePushSubs() {
  mkdir(STATE_DIR, { recursive: true }).then(() => writeFile(SUBS_FILE, JSON.stringify(pushSubs))).catch(() => {});
}
async function sendPush(payload) {
  if (!webpush || !pushSubs.length) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(pushSubs.map(async (s) => {
    try { await webpush.sendNotification(s, body); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s.endpoint); }
  }));
  if (dead.length) { pushSubs = pushSubs.filter((s) => !dead.includes(s.endpoint)); savePushSubs(); }
}

// --- wake-on-demand registry ----------------------------------------------
// A phone in battery-saver sleeps when idle; to reach it we POST to its UnifiedPush
// "wake endpoint" (served by a distributor like ntfy), which wakes the app. We learn
// each phone's endpoint from its /api/health while it's awake and persist it, so any
// box can wake a phone that's currently offline (and keep it listed in the picker).
const WAKE_REGISTRY_FILE = path.join(STATE_DIR, 'wake-registry.json');
const wakeRegistry = new Map(); // dns||ip -> { name, dns, ip, endpoint, stamp }
let _wakeEndpoint = ''; // this box's own endpoint (Android only)
let _powerState = null; // last power snapshot from the host control API (Android only)
let _powerStateAt = 0;
const wakeKey = (n) => String(n.dns || n.ip || n.name || '').toLowerCase();

async function loadWakeRegistry() {
  try {
    const a = JSON.parse(await readFile(WAKE_REGISTRY_FILE, 'utf8'));
    if (Array.isArray(a)) for (const e of a) if (e && e.endpoint) wakeRegistry.set(wakeKey(e), e);
  } catch { /* none yet */ }
}
function saveWakeRegistry() {
  mkdir(STATE_DIR, { recursive: true })
    .then(() => writeFile(WAKE_REGISTRY_FILE, JSON.stringify([...wakeRegistry.values()], null, 2)))
    .catch(() => {});
}
// Record/refresh a peer's wake endpoint learned from its health probe.
function recordWakeEndpoint(node, endpoint) {
  if (!endpoint) return;
  const key = wakeKey(node);
  if (!key) return;
  const prev = wakeRegistry.get(key);
  wakeRegistry.set(key, {
    name: node.name || (prev && prev.name) || key, dns: node.dns || '', ip: node.ip || '',
    endpoint, stamp: Date.now(),
  });
  if (!prev || prev.endpoint !== endpoint) saveWakeRegistry();
}
// On Android, read our own endpoint from the WebMux Host control API (loopback :8084).
function refreshWakeEndpoint() {
  if (!IS_ANDROID) return;
  const r = http.request({ host: '127.0.0.1', port: 8084, path: '/wake-endpoint', method: 'GET', timeout: 2000 }, (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => { try { _wakeEndpoint = JSON.parse(b).endpoint || _wakeEndpoint; } catch { /* ignore */ } });
  });
  r.on('error', () => {});
  r.end();
}
// On Android, read the host's live power/battery snapshot (loopback :8084). Cached and
// refreshed lazily from /api/health so the fleet UI can show each phone's battery + sleep
// state without the health call ever blocking on the loopback hop.
function refreshPowerState() {
  if (!IS_ANDROID) return;
  const r = http.request({ host: '127.0.0.1', port: 8084, path: '/power', method: 'GET', timeout: 2000 }, (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => {
      try { const j = JSON.parse(b); if (j && typeof j.battery !== 'undefined') { _powerState = j; _powerStateAt = Date.now(); } }
      catch { /* ignore */ }
    });
  });
  r.on('error', () => {});
  r.end();
}
// POST to a UnifiedPush endpoint URL to wake the phone. Best-effort; resolves bool.
function sendWake(endpoint) {
  return new Promise((resolve) => {
    let u; try { u = new URL(endpoint); } catch { return resolve(false); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', timeout: 6000,
    }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.end('webmux wake');
  });
}

// Per-session activity state machine: notify once when a session goes idle for
// IDLE_NOTIFY_MS after having produced output, while unattached.
const IDLE_NOTIFY_MS = 12000;
const activityState = new Map(); // name -> { activity, changedAt, notified }
function checkActivity(name, activity, attached, nowMs) {
  let st = activityState.get(name);
  if (!st) { activityState.set(name, { activity, changedAt: nowMs, notified: true }); return; } // first sight: don't alert
  if (attached > 0) st.notified = true; // you're watching it; consider it acknowledged
  if (activity > st.activity) {           // new output → it's busy again
    st.activity = activity; st.changedAt = nowMs;
    if (attached === 0) st.notified = false;
    return;
  }
  if (!st.notified && attached === 0 && nowMs - st.changedAt >= IDLE_NOTIFY_MS) {
    st.notified = true;
    sendPush({ title: 'webmux', body: `“${name}” is idle — your turn`, tag: `idle-${name}`, name });
  }
}

async function sampleSessions() {
  let out = '';
  try {
    out = await tmux(['list-sessions', '-F', `#{session_name}${FS}#{pane_current_path}${FS}#{pane_current_command}${FS}#{session_activity}${FS}#{session_attached}`]);
  } catch { /* no server -> every tracked session has closed */ }
  const current = new Map();
  const nowMs = Date.now();
  const live = new Set();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, dir, command, activity, attached] = line.split(FS);
    current.set(name, { dir, command });
    live.add(name);
    checkActivity(name, Number(activity) || 0, Number(attached) || 0, nowMs);
  }
  for (const [name, info] of seen) {
    if (!current.has(name)) recordRecent(info.dir, info.command);
  }
  for (const name of activityState.keys()) { if (!live.has(name)) activityState.delete(name); } // prune closed
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
  if (ENFORCE_TAILNET && !remoteOnTailnet(req)) { // reject non-tailnet sources (see remoteOnTailnet)
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden: tailnet only\n');
  }
  // Learn peers from whoever probes us (the X-Webmux-Self tag identifies a webmux
  // prober and carries its tailnet name). Lets a node with no `tailscale status`
  // discover the fleet for free.
  const xself = req.headers['x-webmux-self'];
  if (xself !== undefined) {
    const sip = clientTailnetIp(req);
    if (sip && sip !== SELF_TAILNET_IP) seenPeers.set(sip, { dns: String(xself).replace(/\.$/, ''), stamp: Date.now() });
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') {
    let tmuxState;
    try { tmuxState = { found: true, version: (await tmux(['-V'])).trim() }; }
    catch (e) { tmuxState = { found: false, error: e.message || String(e) }; }
    if (IS_ANDROID && Date.now() - _powerStateAt > 4000) refreshPowerState(); // refresh lazily; serve cached
    return sendJson(res, 200, {
      ok: tmuxState.found,
      platform: process.platform,
      node: process.version,
      tmuxBin: TMUX_BIN,
      tmux: tmuxState,
      version: await webmuxVersion(),
      android: IS_ANDROID, // a phone box vs a PC (both report platform "linux")
      wakeEndpoint: _wakeEndpoint, // UnifiedPush endpoint to wake this box (Android)
      power: _powerState, // {awake,battery,charging,dutyPct,...} on Android, else null
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
    const status = await tailscaleStatus();
    // Discover when tailscale is running OR when peers have probed us (the phone case).
    const wantPeers = status.running || seenPeers.size > 0;
    const [self, peers] = await Promise.all([tailscaleSelf(status), wantPeers ? tailscalePeers() : []]);
    // Drop the internal `conn` descriptor before sending to the browser.
    const live = peers.map(({ conn, ...p }) => p);
    const liveKeys = new Set(live.map((p) => wakeKey(p)));
    for (const p of live) if (wakeRegistry.has(wakeKey(p))) p.wakeable = true;
    // Surface known-but-currently-unreachable wakeable phones (asleep), so the picker
    // can offer "tap to wake" instead of dropping them when their probe fails.
    const port0 = PEER_HTTP_PORTS[0] || 8083;
    const asleep = [];
    for (const e of wakeRegistry.values()) {
      if (liveKeys.has(wakeKey(e))) continue;
      asleep.push({
        name: e.name, dns: e.dns, ip: e.ip,
        url: e.dns ? `https://${e.dns}/` : (e.ip ? `http://${e.ip}:${port0}/` : ''),
        wakeable: true, asleep: true,
      });
    }
    return sendJson(res, 200, { enabled: true, port: PORT, status, self, peers: [...live, ...asleep] });
  }
  if (url.pathname === '/api/wake') {
    // Wake a sleeping phone by POSTing to its learned UnifiedPush endpoint.
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const name = (url.searchParams.get('name') || '').toLowerCase();
    const dns = (url.searchParams.get('dns') || '').toLowerCase();
    const ip = (url.searchParams.get('ip') || '').toLowerCase();
    let entry = null;
    for (const e of wakeRegistry.values()) {
      const ek = String(e.dns || '').toLowerCase();
      const ik = String(e.ip || '').toLowerCase();
      const nk = String(e.name || '').toLowerCase();
      if ((dns && ek === dns) || (ip && ik === ip) ||
          (name && (nk === name || ek.split('.')[0] === name))) { entry = e; break; }
    }
    if (!entry) return sendJson(res, 404, { error: 'no wake endpoint known — open the phone once while it is awake so the fleet learns it' });
    const ok = await sendWake(entry.endpoint);
    return sendJson(res, 200, { ok, name: entry.name });
  }
  if (url.pathname === '/api/peer/broadcast') {
    // Run a command on ONE peer (the `fleet run <node>` path): this box → that peer's
    // /api/broadcast?scope=self. Same peer-allowlist guard as the other peer proxies.
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!TAILSCALE_ENABLED) return sendJson(res, 200, { result: null });
    const dns = url.searchParams.get('dns') || '';
    const ip = url.searchParams.get('ip') || '';
    const body = await readBody(req);
    const cmd = typeof body.cmd === 'string' ? body.cmd : '';
    if (!cmd.trim()) return sendJson(res, 400, { error: 'no command' });
    const peers = await tailscalePeers();
    const match = peers.find((p) => p.dns === dns && p.ip === ip) ||
      peers.find((p) => ip && p.ip === ip) || peers.find((p) => dns && p.dns === dns);
    if (!match) return sendJson(res, 404, { error: 'unknown peer' });
    const r = await postPeerJson(match.conn, '/api/broadcast', { cmd }, 24000);
    const one = r && Array.isArray(r.results) && r.results[0];
    return sendJson(res, 200, { result: one || { host: match.name, ok: false, output: 'unreachable or too old' } });
  }
  if (url.pathname === '/api/peer/sessions') {
    // Proxy a peer's session list so the picker can group sessions by machine
    // without the browser hitting cross-origin CORS. Only proxies to hosts that
    // are *currently discovered* webmux peers — not an open relay.
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!TAILSCALE_ENABLED) return sendJson(res, 200, { sessions: [] });
    const dns = url.searchParams.get('dns') || '';
    const ip = url.searchParams.get('ip') || '';
    const peers = await tailscalePeers();
    const match = peers.find((p) => p.dns === dns && p.ip === ip);
    if (!match) return sendJson(res, 404, { error: 'unknown peer' });
    const data = await fetchPeerJson(match.conn, '/api/sessions', 4000);
    return sendJson(res, 200, { sessions: (data && data.sessions) || [] });
  }
  if (url.pathname === '/api/peer/health') {
    // Proxy a peer's health so the fleet-update progress UI can read its running
    // version cross-origin. Same peer-allowlist guard as /api/peer/sessions.
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!TAILSCALE_ENABLED) return sendJson(res, 200, { reachable: false });
    const dns = url.searchParams.get('dns') || '';
    const ip = url.searchParams.get('ip') || '';
    const peers = await tailscalePeers();
    const match = peers.find((p) => p.dns === dns && p.ip === ip);
    if (!match) return sendJson(res, 404, { error: 'unknown peer' });
    const data = await fetchPeerJson(match.conn, '/api/health', 4000);
    return sendJson(res, 200, { reachable: Boolean(data), version: (data && data.version) || '', ok: Boolean(data && data.ok) });
  }
  if (url.pathname === '/api/stats') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, await machineStats());
  }
  if (url.pathname === '/api/procs') {
    // On-demand top processes (runs ps) — only hit when a detail sheet opens, so
    // it stays off the every-5s stats poll that would overload slow boxes.
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, { top: await topProcs() });
  }
  if (url.pathname === '/api/peer/procs') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!TAILSCALE_ENABLED) return sendJson(res, 200, { top: [] });
    const dns = url.searchParams.get('dns') || '';
    const ip = url.searchParams.get('ip') || '';
    const peers = await tailscalePeers();
    const match = peers.find((p) => p.dns === dns && p.ip === ip);
    if (!match) return sendJson(res, 404, { error: 'unknown peer' });
    return sendJson(res, 200, (await fetchPeerJson(match.conn, '/api/procs', 5000)) || { top: [] });
  }
  if (url.pathname === '/api/peer/stats') {
    // Proxy a peer's stats for the picker's machine row (same peer-allowlist guard).
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!TAILSCALE_ENABLED) return sendJson(res, 200, {});
    const dns = url.searchParams.get('dns') || '';
    const ip = url.searchParams.get('ip') || '';
    const peers = await tailscalePeers();
    const match = peers.find((p) => p.dns === dns && p.ip === ip);
    if (!match) return sendJson(res, 404, { error: 'unknown peer' });
    return sendJson(res, 200, (await fetchPeerJson(match.conn, '/api/stats', 4000)) || {});
  }
  if (url.pathname === '/api/broadcast') {
    // Run a shell command on this machine (scope=self) or on the whole fleet
    // (scope=all: this box + every tailnet peer, which each run it via scope=self).
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const scope = url.searchParams.get('scope') || 'self';
    const body = await readBody(req);
    const cmd = typeof body.cmd === 'string' ? body.cmd : '';
    if (!cmd.trim()) return sendJson(res, 400, { error: 'no command' });
    const selfResult = await runCommand(cmd);
    if (scope !== 'all') return sendJson(res, 200, { results: [selfResult] });
    let peerResults = [];
    if (TAILSCALE_ENABLED) {
      try {
        const status = await tailscaleStatus();
        const list = status.running ? await tailscalePeers() : [];
        peerResults = await Promise.all(list.map(async (p) => {
          const r = await postPeerJson(p.conn, '/api/broadcast', { cmd }, 24000);
          const one = r && Array.isArray(r.results) && r.results[0];
          return one ? { ...one, host: one.host || p.name } : { host: p.name, ok: false, output: 'unreachable or too old to support broadcast' };
        }));
      } catch { /* best effort */ }
    }
    return sendJson(res, 200, { results: [selfResult, ...peerResults] });
  }
  if (url.pathname === '/api/snippets') {
    // Shared quick-reply chips. GET returns them; POST replaces them and (scope=all)
    // pushes the same list to every tailnet peer so the fleet stays in sync.
    if (req.method === 'GET') return sendJson(res, 200, { snippets });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    if (!Array.isArray(body.snippets)) return sendJson(res, 400, { error: 'invalid snippets' });
    snippets = body.snippets.filter((s) => typeof s === 'string').slice(0, 100);
    saveSnippetsFile();
    let peers = [];
    if ((url.searchParams.get('scope') || 'self') === 'all' && TAILSCALE_ENABLED) {
      try {
        const status = await tailscaleStatus();
        const list = status.running ? await tailscalePeers() : [];
        peers = await Promise.all(list.map(async (p) => ({ name: p.name, ok: Boolean(await postPeerJson(p.conn, '/api/snippets', { snippets }, 8000)) })));
      } catch { /* best effort */ }
    }
    return sendJson(res, 200, { ok: true, snippets, peers });
  }
  if (url.pathname === '/api/push/key') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, { enabled: Boolean(webpush && vapid), key: vapid ? vapid.publicKey : '' });
  }
  if (url.pathname === '/api/push/subscribe') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const sub = await readBody(req);
    if (!sub || !sub.endpoint) return sendJson(res, 400, { error: 'invalid subscription' });
    if (!pushSubs.find((s) => s.endpoint === sub.endpoint)) { pushSubs.push(sub); savePushSubs(); }
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/push/unsubscribe') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const b = await readBody(req);
    const before = pushSubs.length;
    pushSubs = pushSubs.filter((s) => s.endpoint !== (b && b.endpoint));
    if (pushSubs.length !== before) savePushSubs();
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/push/test') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    await sendPush({ title: 'webmux', body: 'Notifications are on ✓', tag: 'webmux-test' });
    return sendJson(res, 200, { ok: true, subs: pushSubs.length });
  }
  if (url.pathname === '/api/update') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const scope = url.searchParams.get('scope') || 'self';
    if (scope === 'self') {
      // This machine updates itself (direct, or because a coordinator fanned out
      // to us). Runs in a watchable tmux session that survives the restart. On
      // Android there's no systemd, so use the pull-and-respawn path instead.
      try { await (IS_ANDROID ? startAndroidSelfUpdate() : startUpdateSession()); }
      catch (e) { return sendJson(res, 500, { error: 'could not start update: ' + (e.message || e) }); }
      return sendJson(res, 200, { ok: true, session: UPDATE_SESSION, version: await webmuxVersion() });
    }
    // scope=all: act as coordinator — update every peer but DON'T restart
    // ourselves, so we stay up to proxy health for the progress UI. `version` is
    // the target the fleet should converge to (this box is the source of truth).
    let peers = [];
    if (TAILSCALE_ENABLED) {
      try {
        const status = await tailscaleStatus();
        const list = status.running ? await tailscalePeers() : [];
        peers = await Promise.all(list.map((p) => updatePeer(p)));
      } catch { /* peer fan-out is best-effort */ }
    }
    return sendJson(res, 200, { ok: true, version: await remoteTargetVersion(), peers });
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
      // -S -: the entire scrollback (history-limit caps it); -J joins wrapped
      // lines for clean copy. NB: full-screen TUIs that repaint in place (e.g.
      // Claude Code) keep their own scroll view and don't push history to the
      // terminal scrollback, so only the current screen is available for those.
      const out = await tmux(['capture-pane', '-t', `=${name}:`, '-p', '-J', '-S', '-']);
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
      await ensureTmuxMouse();
      await launchDesktop(name);
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
  // Re-assert "busy" while a session is live so the wake-lock survives a restart of
  // either side (the phone is already awake here, so this loopback ping is free).
  if (wss.clients.size > 0) postPowerBusy(true);
  refreshWakeEndpoint(); // keep our announced UnifiedPush wake endpoint fresh (Android)
}, HEARTBEAT_MS);
heartbeat.unref();

// On Android, tell the WebMux Host service when our connected-client count crosses
// 0↔1 (loopback control API on :8084). It then holds the CPU wake-lock only while a
// session is live, so an idle phone can sleep instead of draining battery.
let _powerBusy = false;
function postPowerBusy(busy) {
  if (!IS_ANDROID) return;
  const r = http.request(
    { host: '127.0.0.1', port: 8084, path: `/power?busy=${busy ? 1 : 0}`, method: 'POST', timeout: 2000 },
    (res) => res.resume()
  );
  r.on('error', () => {});
  r.end();
}
function refreshPowerSignal() {
  const busy = wss.clients.size > 0;
  if (busy === _powerBusy) return;
  _powerBusy = busy;
  postPowerBusy(busy);
}

function sendCtrl(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

server.on('upgrade', (req, socket, head) => {
  if (ENFORCE_TAILNET && !remoteOnTailnet(req)) { socket.destroy(); return; } // tailnet-only (see remoteOnTailnet)
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
  wss.handleUpgrade(req, socket, head, (ws) => {
    refreshPowerSignal();
    ws.on('close', () => setImmediate(refreshPowerSignal));
    startSession(ws, mode, name, url);
  });
});

async function startSession(ws, mode, name, url) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const cols = clampInt(url.searchParams.get('cols'), 80, 1, 1000);
  const rows = clampInt(url.searchParams.get('rows'), 24, 1, 1000);

  let args;
  try {
    await ensureTmuxMouse();
    if (mode === 'attach') {
      if (!NAME_RE.test(name)) throw new Error('invalid session name');
      await tmux(['has-session', '-t', `=${name}`]); // throws if missing
      args = ['attach-session', '-t', `=${name}`];
    } else {
      name = await uniqueName(name);
      // Start directory: an explicit dir (e.g. reopening a recent dir) wins;
      // otherwise default to HOME so new terminals open in ~ rather than the
      // service's working directory (~/.local/share/webmux).
      const dir = url.searchParams.get('dir') || HOME || '';
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
  // Sync the power signal to "idle" on boot so a wake-lock left held by a previous
  // run (e.g. webmux restarted mid-session) can't pin the phone awake forever.
  postPowerBusy(false);
  refreshWakeEndpoint();
});

// Phones bind to their tailnet IP (HOST=$ip), so the local `fleet` tool can't use
// 127.0.0.1. Add a loopback listener that re-dispatches into the same handler.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
  const loopback = http.createServer((req, res) => server.emit('request', req, res));
  loopback.on('error', (e) => console.error('loopback listener:', e.message));
  loopback.listen(PORT, '127.0.0.1');
}

// Track recent directories: seed from current sessions, then sample so that a
// session disappearing records its last directory into the history.
await initPush();
await loadSnippetsFile();
await loadRecents();
await loadWakeRegistry();
await sampleSessions();

// Adaptive background polling. An always-on phone peer holds a CPU wake-lock, so the
// dominant battery cost is how often we wake the cores. When no client is attached
// nobody's watching this node's picker, so we slow everything down; a connecting
// client restores fast rates within one idle cycle. Self-rescheduling (not a fixed
// setInterval) so the *timer itself* fires less often, not just its body.
const busy = () => wss.clients.size > 0;

// Recent-dir sampler: 5s attached / 30s idle.
(function sampleLoop() {
  setTimeout(() => { sampleSessions().catch(() => {}).finally(sampleLoop); }, busy() ? 5000 : 30_000).unref();
})();

// Discovery: probe peers so this node learns the fleet. Each probe carries our
// X-Webmux-Self tag, so peers that can't run `tailscale status` (a phone's proot)
// learn us from it. 25s attached / 120s idle. (No-op if Tailscale is disabled.)
if (TAILSCALE_ENABLED) {
  tailscalePeers().catch(() => {});
  (function discoveryLoop() {
    setTimeout(() => { tailscalePeers().catch(() => {}).finally(discoveryLoop); }, busy() ? 25_000 : 120_000).unref();
  })();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
