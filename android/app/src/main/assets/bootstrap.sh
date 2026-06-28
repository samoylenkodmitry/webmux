#!/bin/bash
# Runs INSIDE the proot Debian rootfs (as fake-root) on first launch. Installs the
# toolchain, webmux, and current Claude Code. Everything here is ordinary glibc
# Debian, so node-pty compiles and Claude's arm64 binary runs unmodified.
set -e
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WEBMUX_DIR=/opt/webmux
REPO="${WEBMUX_REPO:-https://github.com/samoylenkodmitry/webmux}"
NODE_VER="${NODE_VER:-v20.18.1}"   # official glibc arm64 build — newer/robust npm 10

# NOTE: the apt/dpkg toolchain install runs as a SEPARATE proot pass WITH
# --link2symlink (see Userland.APT_PHASE) because dpkg's hardlink ops need it; this
# script runs WITHOUT it (link2symlink breaks Claude's hardlinked native binary).

if [ ! -x /usr/local/bin/node ]; then
  echo "BOOT: install Node $NODE_VER"
  curl -fsSL -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-arm64.tar.xz"
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
echo "BOOT: node $(node --version 2>&1) / npm $(npm --version 2>&1)"

if [ ! -d "$WEBMUX_DIR/.git" ]; then
  echo "BOOT: clone webmux"
  git clone --depth 1 "$REPO" "$WEBMUX_DIR"
else
  echo "BOOT: update webmux"
  git -C "$WEBMUX_DIR" pull --ff-only || true
fi

# npm under proot: serialize fetches and clear any cache poisoned by an earlier run.
npm config set audit false
npm config set fund false
npm config set maxsockets 1
rm -rf /root/.npm/_cacache 2>/dev/null || true

cd "$WEBMUX_DIR"
echo "BOOT: npm install"
npm install --no-audit --no-fund

# node-pty 1.x ships no linux prebuild, and its `prebuild.js || node-gyp rebuild`
# install step can exit 0 without producing pty.node. Force a source compile.
echo "BOOT: compile node-pty"
npm install -g node-gyp >/dev/null 2>&1 || true
( cd node_modules/node-pty && node-gyp rebuild ) 2>&1 | tail -15
if [ -f node_modules/node-pty/build/Release/pty.node ]; then
  echo "BOOT: node-pty compiled"
else
  echo "BOOT: node-pty FAILED to build"; exit 3
fi

echo "BOOT: install current Claude Code"
# Force a clean (re)install so a prior link2symlink-broken native binary is replaced.
npm uninstall -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
npm install -g @anthropic-ai/claude-code || echo "BOOT: claude install failed (continuing without it)"
command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1 && echo "BOOT: claude ok ($(claude --version 2>&1 | head -1))" || echo "BOOT: claude NOT runnable"

echo "BOOT: install phone-control CLI + Claude guide"
install -d /usr/local/bin
cat > /usr/local/bin/phone <<'PHONE'
#!/bin/bash
# Drive the Android phone this Claude runs on, via the WebMux Host control API.
API="http://127.0.0.1:8084"; c="$1"; shift 2>/dev/null || true
case "$c" in
  screenshot) o="${1:-/tmp/screen.png}"; curl -fsS -o "$o" "$API/screenshot" && echo "saved $o" ;;
  ui)     curl -fsS "$API/ui"; echo ;;
  tap)    curl -fsS -X POST "$API/tap?x=$1&y=$2"; echo ;;
  swipe)  curl -fsS -X POST "$API/swipe?x1=$1&y1=$2&x2=$3&y2=$4&ms=${5:-300}"; echo ;;
  type)   curl -fsS -X POST "$API/text" --data-binary "${1:-}"; echo ;;
  key)    curl -fsS -X POST "$API/key?name=$1"; echo ;;
  keys)   curl -fsS -X POST "$API/ime/text" --data-binary "${1:-}"; echo ;;
  press)  n="$1"; shift 2>/dev/null || true; q="name=$n"; for m in "$@"; do q="$q&$m=1"; done; curl -fsS -X POST "$API/ime/key?$q"; echo ;;
  clipget) curl -fsS "$API/clipboard"; echo ;;
  clipset) curl -fsS -X POST "$API/clipboard" --data-binary "${1:-}"; echo ;;
  launch) curl -fsS -X POST "$API/launch?pkg=$1"; echo ;;
  apps)   curl -fsS "$API/apps"; echo ;;
  health) curl -fsS "$API/health"; echo ;;
  *) echo "usage: phone {screenshot [file]|ui|tap X Y|swipe X1 Y1 X2 Y2 [ms]|type TEXT|key BACK|HOME|RECENTS|NOTIFICATIONS|keys TEXT|press KEY [ctrl] [shift] [alt]|clipget|clipset TEXT|launch PKG|apps|health}" ;;
esac
PHONE
chmod +x /usr/local/bin/phone

# fleet CLI/MCP lives in the webmux checkout so it updates with `git pull`. Thin wrapper:
cat > /usr/local/bin/fleet <<'FLEET'
#!/bin/bash
exec node /opt/webmux/tools/fleet.cjs "$@"
FLEET
chmod +x /usr/local/bin/fleet

cat > /root/CLAUDE.md <<'GUIDE'
# You are running on an Android phone

You're in a Debian (proot) box inside the WebMux Host app, but you CAN control the
phone with the `phone` command (it drives the app's accessibility service):

- `phone screenshot /tmp/s.png` then read the image to see the screen
- `phone ui` — JSON of on-screen elements: text, [left,top,right,bottom] bounds, tap/edit flags
- `phone tap X Y` — tap a point (use the center of an element's bounds)
- `phone swipe X1 Y1 X2 Y2 [ms]` — swipe / scroll
- `phone type "text"` — set the focused field's text (accessibility; replaces it)
- `phone key BACK|HOME|RECENTS|NOTIFICATIONS` — global buttons
- `phone launch <package>` — open an app;  `phone apps` lists installed apps + packages

Full keyboard + clipboard (via the WebMux Keyboard IME — needs it enabled + active):
- `phone keys "text"` — type literal text at the cursor (inserts, unlike `type`)
- `phone press ENTER` / `press TAB` / `press UP` / `press C ctrl` — a keystroke (+ modifiers)
- `phone clipget` — read the clipboard;  `phone clipset "text"` — set it

Loop: `phone ui` (or a screenshot) to see what's on screen → tap/type → re-check.
If `phone health` shows accessibility:false, the user must enable "WebMux Host" in
Android Settings → Accessibility. If keyboard:false, the user must enable + switch to
the "WebMux Keyboard" (open the WebMux Host app → Enable keyboard). You also have all
of these as native MCP tools (phone:*).

## You are one node in a webmux fleet

Other phones + PCs on the tailnet run webmux too. Operate across them with `fleet`:

- `fleet list` — every node (name, url, asleep/wakeable); the one marked `you_are_here` is you
- `fleet run <node> "<cmd>"` — run a shell command on any node and get its output (`self` = here)
- `fleet sessions [node]` — tmux sessions on a node
- `fleet wake <node>` — wake a sleeping phone so it becomes reachable, then act on it
- `fleet ask <node> "<prompt>"` — send a prompt to another node's Claude and read the reply

Also native MCP tools (fleet:*). Phone control is local-only by design: to drive a
*different* phone, `fleet ask` its on-device Claude to run the `phone …` commands there.
GUIDE

echo "BOOT: install phone MCP server for Claude"
install -d /usr/local/lib
cat > /usr/local/lib/phone-mcp.js <<'MCP'
#!/usr/bin/env node
// Minimal stdio MCP server exposing Android phone control to Claude (via the
// WebMux Host loopback API on 127.0.0.1:8084).
const http = require('http');
const API = 'http://127.0.0.1:8084';
function call(path, method = 'GET', body) {
  return new Promise((res) => {
    const u = new URL(API + path);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method }, (s) => {
      const ch = []; s.on('data', (c) => ch.push(c));
      s.on('end', () => res({ status: s.statusCode, buf: Buffer.concat(ch) }));
    });
    r.on('error', () => res({ status: 0, buf: Buffer.alloc(0) }));
    if (body) r.write(body); r.end();
  });
}
const T = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const TOOLS = [
  { name: 'screenshot', description: 'Screenshot the phone screen (returns an image). Android 11+.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ui', description: 'On-screen elements as JSON: text, [left,top,right,bottom] bounds, tap/edit flags.', inputSchema: { type: 'object', properties: {} } },
  { name: 'tap', description: 'Tap a point on screen.', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'swipe', description: 'Swipe/scroll between two points.', inputSchema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, ms: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'type', description: 'Type text into the focused field.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'key', description: 'Press a global button: BACK, HOME, RECENTS, NOTIFICATIONS.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'launch', description: 'Launch an app by package name.', inputSchema: { type: 'object', properties: { pkg: { type: 'string' } }, required: ['pkg'] } },
  { name: 'apps', description: 'List installed apps + package names.', inputSchema: { type: 'object', properties: {} } },
  { name: 'sendkeys', description: 'Type literal text at the cursor via the WebMux keyboard (inserts, unlike type which replaces). Needs the WebMux Keyboard enabled + active and a focused field.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'press', description: 'Press a keyboard key with optional modifiers. key: ENTER, TAB, ESC, UP/DOWN/LEFT/RIGHT, BACKSPACE, DELETE, HOME, END, PAGEUP, PAGEDOWN, or a single char. e.g. {key:"C",ctrl:true}. Needs WebMux Keyboard active + a focused field.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, ctrl: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' } }, required: ['key'] } },
  { name: 'clipboard_get', description: 'Read the phone clipboard text. Needs the WebMux Keyboard active.', inputSchema: { type: 'object', properties: {} } },
  { name: 'clipboard_set', description: 'Set the phone clipboard text. Needs the WebMux Keyboard active.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];
async function run(name, a = {}) {
  if (name === 'screenshot') { const r = await call('/screenshot'); return r.status === 200 ? { content: [{ type: 'image', data: r.buf.toString('base64'), mimeType: 'image/png' }] } : T('screenshot failed (needs Android 11+ and accessibility enabled)'); }
  if (name === 'ui') return T((await call('/ui')).buf.toString());
  if (name === 'apps') return T((await call('/apps')).buf.toString());
  if (name === 'tap') { await call(`/tap?x=${a.x}&y=${a.y}`, 'POST'); return T(`tapped ${a.x},${a.y}`); }
  if (name === 'swipe') { await call(`/swipe?x1=${a.x1}&y1=${a.y1}&x2=${a.x2}&y2=${a.y2}&ms=${a.ms || 300}`, 'POST'); return T('swiped'); }
  if (name === 'type') { await call('/text', 'POST', String(a.text || '')); return T('typed'); }
  if (name === 'key') { await call(`/key?name=${encodeURIComponent(a.name)}`, 'POST'); return T(`key ${a.name}`); }
  if (name === 'launch') { await call(`/launch?pkg=${encodeURIComponent(a.pkg)}`, 'POST'); return T(`launched ${a.pkg}`); }
  if (name === 'sendkeys') { const r = await call('/ime/text', 'POST', String(a.text || '')); return T(r.status === 200 ? 'sent' : (r.buf.toString() || 'keyboard not active')); }
  if (name === 'press') { const q = `name=${encodeURIComponent(a.key)}&ctrl=${a.ctrl ? 1 : 0}&shift=${a.shift ? 1 : 0}&alt=${a.alt ? 1 : 0}`; const r = await call('/ime/key?' + q, 'POST'); return T(r.status === 200 ? `pressed ${a.key}` : (r.buf.toString() || 'keyboard not active')); }
  if (name === 'clipboard_get') { const r = await call('/clipboard'); try { return T(JSON.parse(r.buf.toString()).text || ''); } catch { return T(r.buf.toString() || 'keyboard not active'); } }
  if (name === 'clipboard_set') { const r = await call('/clipboard', 'POST', String(a.text || '')); return T(r.status === 200 ? 'clipboard set' : (r.buf.toString() || 'keyboard not active')); }
  return T('unknown tool ' + name);
}
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
let buf = '';
process.stdin.on('data', async (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const { id, method, params } = m;
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'phone', version: '1.0.0' } } });
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    else if (method === 'tools/call') { try { send({ jsonrpc: '2.0', id, result: await run(params.name, params.arguments) }); } catch (e) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true } }); } }
    else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
  }
});
MCP
chmod +x /usr/local/lib/phone-mcp.js

echo "BOOT: register phone MCP with Claude (user scope)"
claude mcp remove phone -s user 2>/dev/null || true
claude mcp add phone -s user -- node /usr/local/lib/phone-mcp.js 2>&1 | tail -1 || echo "BOOT: mcp add failed (phone CLI still works)"

echo "BOOT: register fleet MCP with Claude (user scope)"
claude mcp remove fleet -s user 2>/dev/null || true
claude mcp add fleet -s user -- node /opt/webmux/tools/fleet.cjs 2>&1 | tail -1 || echo "BOOT: fleet mcp add failed (fleet CLI still works)"

echo "BOOT: done"
touch /opt/.webmux-bootstrapped
