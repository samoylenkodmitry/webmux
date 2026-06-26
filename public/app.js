'use strict';

// --- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const pickerView = $('picker');
const termView = $('terminal-view');
const sessionsEl = $('sessions');
const pickerEmpty = $('picker-empty');
const pickerStatus = $('picker-status');
const termNameEl = $('term-name');
const termTitleEl = $('term-title');
const termSubEl = $('term-sub');
const recentsSectionEl = $('recents-section');
const recentsListEl = $('recents');
const connEl = $('conn');
const overlay = $('overlay');
const overlayText = $('overlay-text');
const keysEl = $('keys');
const switcherEl = $('switcher');
const switcherList = $('switcher-list');
const termContainer = $('term');
const copyViewEl = $('copy-view');
const copyTextEl = $('copy-text');
const windowsEl = $('windows');
const windowsList = $('windows-list');
const confirmEl = $('confirm');
const composeEl = $('compose');
const composeInput = $('compose-input');

// --- terminal session state ----------------------------------------------
let term = null;
let fit = null;
let ws = null;
let currentName = null;   // actual session name (from server handshake)
let userDetached = false; // true once the user taps "back"
let reconnectTimer = null;
let reconnectDelay = 500;
let awaitingPong = false;  // outstanding liveness probe

// sticky modifiers, applied to the next single character of input
let shiftArmed = false;
let ctrlArmed = false;
let altArmed = false;
const modButtons = {};
let netTicks = 0; // net wheel-ticks scrolled up (>0 means tmux is in copy-mode)

// Soft-key bar. csi = CSI-final cursor key, tilde = "CSI n ~" key, fkey = SS3
// final, tab/seq/mod special-cased. Modifiers (shift/ctrl/alt) combine into the
// standard xterm modifier parameter.
const KEYS = [
  { label: '/', seq: '/' },     // first, by request
  { label: 'Tab', tab: true },
  { label: 'Esc', seq: '\x1b' },
  { label: '↑', csi: 'A' },
  { label: '↓', csi: 'B' },
  { label: '←', csi: 'D' },
  { label: '→', csi: 'C' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: '^C', ctrlKey: 'c' },
  { label: '⏎', seq: '\r' },
  { label: 'Undo', undo: true },     // erase exactly what was last typed/sent
  { label: 'ClrLn', clearLine: true }, // wipe the whole current input line (^U)
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '-', seq: '-' },
  { label: 'Shift', mod: 'shift' },
  { label: 'Alt', mod: 'alt' },
  { label: '^A', ctrlKey: 'a' },
  { label: '^E', ctrlKey: 'e' },
  { label: '^U', ctrlKey: 'u' },
  { label: '^W', ctrlKey: 'w' },
  { label: '^K', ctrlKey: 'k' },
  { label: '^L', ctrlKey: 'l' },
  { label: 'Home', csi: 'H' },
  { label: 'End', csi: 'F' },
  { label: 'PgUp', tilde: '5' },
  { label: 'PgDn', tilde: '6' },
  { label: '^D', ctrlKey: 'd' },
  { label: '^Z', ctrlKey: 'z' },
  { label: 'Del', tilde: '3' },
  { label: 'Ins', tilde: '2' },
  { label: '\\', seq: '\\' },
  { label: '`', seq: '`' },
  { label: 'F1', fkey: 'P' },
  { label: 'F2', fkey: 'Q' },
  { label: 'F3', fkey: 'R' },
  { label: 'F4', fkey: 'S' },
];

// =====================  Session picker  ===================================

async function loadSessions() {
  pickerStatus.textContent = 'Loading…';
  try {
    const sessions = await fetchSessions();
    renderSessions(sessions);
    pickerStatus.textContent = '';
    if (sessions.length === 0) checkHealth(); // empty could mean tmux is unreachable
  } catch (e) {
    pickerStatus.textContent = 'Failed to load sessions: ' + e.message;
  }
  loadRecents();
  loadMachines();
}

// Live machine-stats wired up by loadMachines: each entry points a stats <span>
// at a /api/stats (self) or /api/peer/stats (peer) URL, refreshed on a timer.
let machineStatsTargets = [];
let statsTimer = null;
function fmtBytes(n) {
  if (n == null) return '?';
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9) return Math.round(n / 1e9) + 'G';
  if (n >= 1e6) return Math.round(n / 1e6) + 'M';
  return Math.round(n / 1e3) + 'K';
}
function fmtStats(s) {
  if (!s || (s.cpu == null && s.mem == null && !s.disk)) return '—';
  const p = [];
  if (s.cpu != null) p.push(`CPU ${s.cpu}%`);
  if (s.gpu != null) p.push(`GPU ${s.gpu}%`);
  if (s.mem != null) p.push(`RAM ${s.mem}%`);
  if (s.disk && s.disk.free != null) p.push(`/ ${fmtBytes(s.disk.free)} free`);
  return p.join(' · ');
}
async function refreshMachineStats() {
  await Promise.all(machineStatsTargets.map(async (t) => {
    let s = null;
    try { const r = await fetch(t.url, { cache: 'no-store' }); if (r.ok) s = await r.json(); } catch { /* unreachable */ }
    if (t.statsEl.isConnected) t.statsEl.textContent = fmtStats(s);
  }));
}
function startStatsPolling() {
  if (statsTimer) return;
  statsTimer = setInterval(() => { if (!pickerView.hidden && machineStatsTargets.length) refreshMachineStats(); }, 5000);
}

// A row of webmux instances on the tailnet: this machine (marked) + peers, each
// shown as a small card with live CPU/GPU/RAM/disk stats. Tapping a peer switches
// to it in the SAME tab; if it can't be reached here, tapping shows a hint.
function machineCard(tag, labelText) {
  const el = document.createElement(tag);
  el.className = 'machine';
  const nameEl = document.createElement('span');
  nameEl.className = 'machine-name';
  const label = document.createElement('span');
  label.className = 'machine-label';
  label.textContent = labelText;
  nameEl.append(label);
  const statsEl = document.createElement('span');
  statsEl.className = 'machine-stats';
  statsEl.textContent = '…';
  el.append(nameEl, statsEl);
  return { el, nameEl, statsEl };
}
async function loadMachines() {
  const wrap = $('machines'), row = $('machines-row'), hint = $('machine-hint');
  if (!wrap) return;
  let data;
  try { data = await (await fetch('/api/tailnet', { cache: 'no-store' })).json(); }
  catch { wrap.hidden = true; return; }
  const peers = Array.isArray(data.peers) ? data.peers : [];
  const issue = tailnetIssue(data);
  if (!data.enabled || (!data.self && !peers.length && !issue)) { wrap.hidden = true; return; }
  row.innerHTML = '';
  hint.hidden = true;
  hint.innerHTML = '';
  machineStatsTargets = [];

  if (data.self && data.self.url) {
    const { el, nameEl, statsEl } = machineCard('span', (data.self.dns || '').split('.')[0] || 'this');
    el.classList.add('current');
    if (issue) { el.classList.add('unreachable'); el.title = issue.message; }
    const copy = document.createElement('button');
    copy.className = 'machine-copy';
    copy.title = 'Copy this machine’s share URL';
    copy.textContent = '⧉';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(data.self.url)
        .then(() => { copy.textContent = '✓'; setTimeout(() => { copy.textContent = '⧉'; }, 1000); })
        .catch(() => {});
    });
    nameEl.append(copy);
    row.append(el);
    machineStatsTargets.push({ statsEl, url: '/api/stats' });
  } else if (issue) {
    const { el } = machineCard('span', 'this PC');
    el.classList.add('current', 'unreachable');
    el.title = issue.message;
    row.append(el);
    machineStatsTargets.push({ statsEl: el.querySelector('.machine-stats'), url: '/api/stats' });
  }

  for (const p of peers) {
    const { el } = machineCard('a', p.name || p.dns);
    el.href = p.url;                 // same-tab navigation (no target=_blank)
    el.title = p.dns;
    el.addEventListener('click', (e) => {
      if (el.dataset.unreachable === '1') { e.preventDefault(); showMachineHint(p); }
    });
    row.append(el);
    machineStatsTargets.push({ statsEl: el.querySelector('.machine-stats'), url: `/api/peer/stats?dns=${encodeURIComponent(p.dns)}&ip=${encodeURIComponent(p.ip)}` });
    // Probe from THIS device; if unreachable, mark it and offer the hint.
    probeReachable(p.url).then((ok) => {
      if (!ok) { el.classList.add('unreachable'); el.dataset.unreachable = '1'; }
    });
  }
  if (issue) renderMachineHint(hint, issue.message, issue.command);
  wrap.hidden = false;
  refreshMachineStats();
  startStatsPolling();
}

function tailnetIssue(data) {
  const status = data.status || {};
  if (status.present === false) {
    return { message: 'Tailscale is not available to the webmux service.', command: null };
  }
  if (status.needsLogin || (status.backendState && status.backendState !== 'Running')) {
    let reason = status.backendState ? `Tailscale is ${status.backendState}` : 'Tailscale is not connected';
    if (status.keyExpired && status.keyExpiry) {
      const expiry = new Date(status.keyExpiry);
      reason = `Tailscale key expired ${Number.isNaN(expiry.getTime()) ? status.keyExpiry : expiry.toLocaleDateString()}`;
    }
    return { message: `${reason}. Log in again to share this machine.`, command: 'tailscale up' };
  }
  if (!data.self && data.port) {
    return { message: 'This machine is not shared through Tailscale Serve yet.', command: `tailscale serve --bg ${data.port}` };
  }
  return null;
}

function renderMachineHint(hint, message, command) {
  hint.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'hint-msg';
  msg.textContent = message;
  hint.append(msg);
  if (command) {
    const code = document.createElement('code');
    code.className = 'hint-cmd';
    code.textContent = command;
    const copy = document.createElement('button');
    copy.className = 'btn';
    copy.textContent = 'Copy command';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(command)
        .then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy command'; }, 1300); })
        .catch(() => {});
    });
    hint.append(code, copy);
  }
  hint.hidden = false;
}

// Reachable from the browser? no-cors fetch resolves (opaque) if the host
// answers, rejects on DNS/connection failure. Used to decide whether a peer
// link will open on this device.
function probeReachable(url) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => { ctrl.abort(); resolve(false); }, 3000);
    fetch(url, { mode: 'no-cors', signal: ctrl.signal })
      .then(() => { clearTimeout(t); resolve(true); })
      .catch(() => { clearTimeout(t); resolve(false); });
  });
}

function showMachineHint(p) {
  const hint = $('machine-hint');
  const cmd = `echo '${p.ip} ${p.dns}' | sudo tee -a /etc/hosts`;
  renderMachineHint(hint, `“${p.name || p.dns}” won’t open from this device (Tailscale MagicDNS not resolving here). On this device, add it to /etc/hosts:`, cmd);
}

// If there are no sessions, distinguish "nothing running" from "tmux not found".
async function checkHealth() {
  try {
    const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
    if (!h.ok) {
      pickerStatus.textContent = `tmux not reachable (${h.tmuxBin}): ${h.tmux && h.tmux.error || 'unknown'}. ` +
        `Install tmux, or set TMUX_BIN to its full path in the service.`;
    }
  } catch { /* ignore */ }
}

async function loadRecents() {
  let recents = [];
  try {
    const res = await fetch('/api/recents', { cache: 'no-store' });
    recents = (await res.json()).recents || [];
  } catch { /* leave empty */ }
  recentsListEl.innerHTML = '';
  recentsSectionEl.hidden = recents.length === 0;
  for (const r of recents) {
    const li = document.createElement('li');
    li.className = 'session';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.path || r.dir;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = 'last: ' + (r.command || 'shell');
    meta.append(name, sub);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '＋ open';
    li.append(meta, badge);
    li.addEventListener('click', () => openSession('new', null, { dir: r.dir }));
    recentsListEl.append(li);
  }
}

async function fetchSessions() {
  const res = await fetch('/api/sessions', { cache: 'no-store' });
  const { sessions } = await res.json();
  return sessions || [];
}

function sessionItem(s, { current = false, onClick } = {}) {
  const li = document.createElement('li');
  li.className = 'session' + (current ? ' current' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = s.name;
  // Command on its own line (it can be a long full argv now, e.g. "sudo btop")
  // so it isn't squeezed/trimmed next to the path on a narrow phone screen.
  const cmd = document.createElement('div');
  cmd.className = 'cmd';
  cmd.textContent = s.command || 'shell';
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = (s.path || '') + (s.windows > 1 ? `  ·  ${s.windows} windows` : '');
  meta.append(name, cmd, sub);

  const badge = document.createElement('span');
  badge.className = 'badge' + (s.attached > 0 ? ' live' : '');
  badge.textContent = current ? 'current' : (s.attached > 0 ? `● ${s.attached}` : 'idle');

  li.append(meta, badge);
  if (onClick && !current) li.addEventListener('click', onClick);
  return li;
}

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  pickerEmpty.hidden = sessions.length > 0;
  for (const s of sessions) {
    sessionsEl.append(sessionItem(s, { onClick: () => openSession('attach', s.name) }));
  }
}

$('refresh').addEventListener('click', loadSessions);
$('new').addEventListener('click', () => openSession('new'));

// =====================  Terminal  ========================================

// Font size is remembered per session (keyed by tmux name) so each terminal keeps
// its own zoom; brand-new/unknown sessions fall back to the last-used global size.
function clampFont(px) { return Math.max(4, Math.min(28, Number.isFinite(px) ? px : 14)); }
const FONT_MAP_KEY = 'ptw-font-by-session';
function globalDefaultFont() { return clampFont(parseInt(localStorage.getItem('ptw-font') || '14', 10)); }
function loadFontMap() { try { return JSON.parse(localStorage.getItem(FONT_MAP_KEY)) || {}; } catch { return {}; } }
function saveSessionFont(name, px) {
  if (!name) return;
  const m = loadFontMap();
  m[name] = px;
  try { localStorage.setItem(FONT_MAP_KEY, JSON.stringify(m)); } catch { /* quota: ignore */ }
}

let fontSize = globalDefaultFont();
// Apply a size to the live terminal + menu readout, without persisting it.
function applyFont(px) {
  fontSize = clampFont(px);
  const val = $('font-val');
  if (val) val.textContent = String(fontSize);
  if (term) { term.options.fontSize = fontSize; doFit(); }
}
// User-initiated change: apply, then remember it both globally and per session.
function setFontSize(px) {
  applyFont(px);
  try { localStorage.setItem('ptw-font', String(fontSize)); } catch { /* ignore */ }
  saveSessionFont(currentName, fontSize);
}
// On (re)attach: restore this session's remembered size, else the global default.
function applySessionFont(name) {
  const m = loadFontMap();
  applyFont(Number.isFinite(m[name]) ? m[name] : globalDefaultFont());
}

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termContainer);
  term.onData(onTermInput);
  renderKeys();
  setupKeyBar();
  setupTouchScroll();
}

// The scrollback lives in tmux, not in xterm. tmux `mouse on` means a real
// mouse wheel scrolls it (via copy-mode); on a phone there's no wheel, so we
// translate a finger drag into the same SGR wheel sequences and write them to
// tmux. A plain tap is left untouched so it still focuses + opens the keyboard.
const WHEEL_PX = 36; // finger pixels per wheel tick
function setupTouchScroll() {
  let startY = 0, lastY = 0, accum = 0, scrolling = false;
  termContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startY = lastY = e.touches[0].clientY;
    accum = 0;
    scrolling = false;
  }, { capture: true, passive: true });

  termContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!scrolling && Math.abs(y - startY) > 8) scrolling = true;
    if (!scrolling) return;
    e.preventDefault();
    e.stopPropagation(); // keep it away from xterm's own mouse forwarding
    accum += y - lastY;
    lastY = y;
    const ticks = Math.trunc(accum / WHEEL_PX); // drag down (>0) => scroll to older
    if (ticks !== 0) { wheelScroll(ticks); accum -= ticks * WHEEL_PX; }
  }, { capture: true, passive: false });

  termContainer.addEventListener('touchend', (e) => {
    if (scrolling) e.stopPropagation(); // suppress the synthetic tap after a scroll
    scrolling = false;
  }, { capture: true });
}

function sendWheel(up, ticks) {
  const x = term ? Math.max(1, Math.floor(term.cols / 2)) : 1;
  const y = term ? Math.max(1, Math.floor(term.rows / 2)) : 1;
  const seq = `\x1b[<${up ? 64 : 65};${x};${y}M`; // SGR mouse: 64=wheel up, 65=down
  for (let i = 0; i < ticks; i++) sendBytes(seq);
}
function wheelScroll(ticks) {
  if (ticks > 0) { sendWheel(true, ticks); netTicks += ticks; }
  else { const n = -ticks; sendWheel(false, n); netTicks = Math.max(0, netTicks - n); }
}
// Before any keystroke reaches the shell, leave copy-mode by scrolling to the
// bottom. Wheel-down is harmless when not in copy-mode, so this is always safe.
function ensureBottom() {
  if (netTicks > 0) { sendWheel(false, netTicks + 3); netTicks = 0; }
}

// Build the soft-key bar. Keys are non-focusable <div>s; the whole row is driven
// by one pointer handler (see setupKeyBar) so we can keep the terminal focused.
function renderKeys() {
  keysEl.innerHTML = '';
  for (const k of KEYS) {
    const b = document.createElement('div');
    b.className = 'key';
    b.setAttribute('role', 'button');
    b.textContent = k.label;
    b._key = k;
    if (k.mod) modButtons[k.mod] = b;
    keysEl.append(b);
  }
}

function handleKey(k) {
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* unsupported */ } }
  if (k.mod) toggleMod(k.mod);
  else pressKey(k);
}

// Track the most recent run of printable input (from typing or the compose bar)
// so "Undo" can erase exactly it. Any control byte (Enter, arrows, ^C, …) is a
// boundary that resets the buffer, so Undo never deletes across a submitted line.
let lastInput = '';
function noteInput(text) {
  if (!text) return;
  if (/[\x00-\x1f\x7f]/.test(text)) { lastInput = ''; return; }
  lastInput = (lastInput + text).slice(-4096);
}
function undoLastInput() {
  if (!lastInput) return;
  const n = [...lastInput].length; // count code points (approx for wide chars)
  sendBytes('\x7f'.repeat(n));      // DEL/backspace ×N
  lastInput = '';
}

// Container-level pointer handling. preventDefault on pointerdown stops focus
// from leaving the terminal textarea (so the on-screen keyboard never hides). A
// horizontal drag scrolls the row; a stationary press fires the key under it.
function setupKeyBar() {
  let id = null, startX = 0, startY = 0, startScroll = 0, moved = false, pressed = null;
  const setPressed = (el) => {
    if (pressed) pressed.classList.remove('pressed');
    pressed = el;
    if (el) el.classList.add('pressed');
  };
  const keyAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest('.key'); };

  keysEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // keep the terminal focused → keyboard stays up
    id = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    startScroll = keysEl.scrollLeft;
    moved = false;
    setPressed(keyAt(e.clientX, e.clientY));
    try { keysEl.setPointerCapture(id); } catch { /* ignore */ }
  });
  keysEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - startX;
    if (!moved && Math.hypot(dx, e.clientY - startY) > 8) { moved = true; setPressed(null); }
    if (moved) keysEl.scrollLeft = startScroll - dx; // manual horizontal scroll
  });
  const finish = (e) => {
    if (e.pointerId !== id) return;
    try { keysEl.releasePointerCapture(id); } catch { /* ignore */ }
    if (!moved) {
      const key = keyAt(e.clientX, e.clientY);
      if (key && key._key) { handleKey(key._key); focusActiveInput(); }
    }
    setPressed(null);
    id = null;
  };
  keysEl.addEventListener('pointerup', finish);
  keysEl.addEventListener('pointercancel', () => { setPressed(null); id = null; });
}

function toggleMod(mod) {
  if (mod === 'shift') shiftArmed = !shiftArmed;
  else if (mod === 'ctrl') ctrlArmed = !ctrlArmed;
  else altArmed = !altArmed;
  updateMods();
}
function clearMods() {
  shiftArmed = ctrlArmed = altArmed = false;
  updateMods();
}
function updateMods() {
  if (modButtons.shift) modButtons.shift.classList.toggle('armed', shiftArmed);
  if (modButtons.ctrl) modButtons.ctrl.classList.toggle('armed', ctrlArmed);
  if (modButtons.alt) modButtons.alt.classList.toggle('armed', altArmed);
}

// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4)
function modNumber() {
  return 1 + (shiftArmed ? 1 : 0) + (altArmed ? 2 : 0) + (ctrlArmed ? 4 : 0);
}

// A soft special key (cursor / nav / function / tab / literal symbol).
function pressKey(k) {
  ensureBottom();
  if (k.undo) { undoLastInput(); clearMods(); return; }
  if (k.clearLine) { sendBytes('\x15'); lastInput = ''; clearMods(); return; } // ^U kills the line
  const mod = modNumber();
  let out;
  if (k.ctrlKey) {
    out = toCtrl(k.ctrlKey); // e.g. ^C => 0x03, regardless of armed modifiers
  } else if (k.csi) {
    out = mod > 1 ? `\x1b[1;${mod}${k.csi}` : `\x1b[${k.csi}`;
  } else if (k.tilde) {
    out = mod > 1 ? `\x1b[${k.tilde};${mod}~` : `\x1b[${k.tilde}~`;
  } else if (k.fkey) {
    out = mod > 1 ? `\x1b[1;${mod}${k.fkey}` : `\x1bO${k.fkey}`;
  } else if (k.tab) {
    out = shiftArmed ? '\x1b[Z' : '\t'; // Shift+Tab = back-tab
  } else if (k.seq.length === 1) {
    out = applyMods(k.seq); // symbol/literal: let modifiers apply
  } else {
    out = k.seq; // Esc, etc.
  }
  clearMods();
  sendBytes(out);
}

// Apply armed modifiers to a single printable character.
function applyMods(ch) {
  if (shiftArmed) ch = ch.toUpperCase();
  if (ctrlArmed) ch = toCtrl(ch);
  if (altArmed) ch = '\x1b' + ch; // Meta = ESC prefix
  return ch;
}

// Guard against a stray huge paste (the OS keyboard delivers a paste as one big
// onData chunk, so this also catches pastes that bypass our Paste button).
const PASTE_WARN = 2000;
async function confirmLarge(text) {
  if (text.length <= PASTE_WARN) return true;
  const lines = text.split(/\r\n|\r|\n/).length;
  const preview = text.length > 600 ? text.slice(0, 600) + '\n…' : text;
  return askConfirm({
    title: 'Large paste',
    message: `Send ${text.length.toLocaleString()} characters (${lines.toLocaleString()} lines) to the terminal?`,
    preview,
    okLabel: 'Paste anyway',
    danger: true,
  });
}

function onTermInput(data) {
  // Big chunk = a paste: confirm first. Nothing forwards to the PTY except
  // sendBytes, so deferring it behind the async dialog is safe.
  if (data.length > PASTE_WARN) {
    confirmLarge(data).then((ok) => { if (ok) { ensureBottom(); lastInput = ''; sendBytes(data); } });
    return;
  }
  ensureBottom(); // a keystroke means "go live"
  if (data.length === 1 && (shiftArmed || ctrlArmed || altArmed)) {
    const out = applyMods(data);
    clearMods();
    noteInput(out);
    return sendBytes(out);
  }
  noteInput(data);
  sendBytes(data);
}

// In-app confirm dialog returning a Promise<boolean>. Reliable in installed
// PWAs where window.confirm() may be suppressed / auto-accepted.
let confirmResolve = null;
function askConfirm({ title = 'Confirm', message = '', preview = '', okLabel = 'OK', danger = false }) {
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = message;
  const pv = $('confirm-preview');
  if (preview) { pv.textContent = preview; pv.hidden = false; } else { pv.hidden = true; pv.textContent = ''; }
  const ok = $('confirm-ok');
  ok.textContent = okLabel;
  ok.classList.toggle('btn-danger', danger);
  ok.classList.toggle('btn-primary', !danger);
  resolveConfirm(false); // settle any previous pending dialog
  confirmEl.hidden = false;
  return new Promise((res) => { confirmResolve = res; });
}
function resolveConfirm(v) {
  confirmEl.hidden = true;
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(v); }
}
$('confirm-ok').addEventListener('click', () => resolveConfirm(true));
$('confirm-cancel').addEventListener('click', () => resolveConfirm(false));
confirmEl.addEventListener('click', (e) => { if (e.target === confirmEl) resolveConfirm(false); });

function toCtrl(ch) {
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 63 && code <= 95) return String.fromCharCode(code & 0x1f); // @ A-Z [ \ ] ^ _
  if (ch === ' ') return '\x00';
  return ch;
}

function sendBytes(str) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(str));
}

function setSessionLabel(text) {
  termTitleEl.textContent = text;
  termSubEl.textContent = '';
}

// Open from the picker: show the terminal view, then (re)attach. opts.dir starts
// a new session in that directory (used by the "recent directories" list).
function openSession(mode, name, opts = {}) {
  ensureTerm();
  pickerView.hidden = true;
  termView.hidden = false;
  requestAnimationFrame(() => switchSession(mode, name, opts));
}

// Switch the live terminal to a different session without leaving the view.
function switchSession(mode, name, opts = {}) {
  closeSwitcher();
  teardownWs();
  clearMods();
  netTicks = 0;
  userDetached = false;
  reconnectDelay = 500;
  currentName = mode === 'attach' ? name : null;
  setSessionLabel(mode === 'attach' ? name : 'new session…');
  if (term) term.reset();
  doFit();
  connect(mode, name, opts);
  if (term) term.focus();
}

function wsUrl(mode, name, opts = {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const dims = term ? `cols=${term.cols}&rows=${term.rows}` : '';
  if (mode === 'attach') {
    return `${proto}://${location.host}/ws/session/${encodeURIComponent(name)}?${dims}`;
  }
  // New sessions open a real terminal window on the PC (desktop=1) so they
  // persist after the browser leaves and are visible locally.
  const params = [dims, 'desktop=1'];
  if (name) params.push(`name=${encodeURIComponent(name)}`);
  if (opts.dir) params.push(`dir=${encodeURIComponent(opts.dir)}`);
  return `${proto}://${location.host}/ws/new?${params.join('&')}`;
}

function teardownWs() {
  clearTimeout(reconnectTimer);
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = old.onclose = old.onerror = old.onmessage = null;
    try { old.close(); } catch {}
  }
}

function connect(mode, name, opts = {}) {
  clearTimeout(reconnectTimer);
  setConn('connecting', 'connecting…');
  ws = new WebSocket(wsUrl(mode, name, opts));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectDelay = 500;
    overlay.hidden = true;
    setConn('ok', 'connected');
    doFit(); // push our real size to tmux
    startTitlePolling();
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return onControl(JSON.parse(ev.data));
    term.write(new Uint8Array(ev.data));
  };

  ws.onclose = () => {
    setConn('warn', 'disconnected');
    if (userDetached) return;
    if (!currentName) { backToPicker(); return; } // new session never handshaked
    scheduleReconnect();
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

function onControl(msg) {
  switch (msg.type) {
    case 'pong':
      awaitingPong = false; // liveness probe answered
      break;
    case 'session':
      currentName = msg.name;
      termTitleEl.textContent = msg.name;
      applySessionFont(msg.name); // each terminal remembers its own zoom
      history.replaceState(null, '', '#s=' + encodeURIComponent(msg.name)); // bookmarkable
      refreshTitle();
      break;
    case 'error':
      overlay.hidden = false;
      overlayText.textContent = msg.message;
      userDetached = true; // don't auto-reconnect into an error
      setTimeout(backToPicker, 1400);
      break;
    case 'exit':
      userDetached = true; // session ended; nothing to reconnect to
      backToPicker();
      break;
  }
}

function scheduleReconnect() {
  overlay.hidden = false;
  overlayText.textContent = `Reconnecting to ${currentName}…`;
  reconnectTimer = setTimeout(() => connect('attach', currentName), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
}

function backToPicker() {
  userDetached = true;
  closeSwitcher();
  closeMenu();
  closeWindows();
  closeCompose();
  closeUpdateProgress();
  resolveConfirm(false);
  copyViewEl.hidden = true;
  clearMods();
  teardownWs();
  stopTitlePolling();
  overlay.hidden = true;
  termView.hidden = true;
  pickerView.hidden = false;
  history.replaceState(null, '', location.pathname + location.search); // drop #s=
  if (term) term.reset();
  loadSessions();
}

function setConn(cls, text) {
  connEl.className = 'conn ' + cls; // dot rendered via CSS; color conveys state
  connEl.title = text;
}

// --- dynamic title: reflect the session's live command + directory ---------
let titleTimer = null;
async function refreshTitle() {
  if (!currentName) return;
  try {
    const res = await fetch('/api/session?name=' + encodeURIComponent(currentName), { cache: 'no-store' });
    if (!res.ok) return;
    const s = await res.json();
    termSubEl.textContent = (s.command || '') + (s.path ? '  ·  ' + s.path : '');
    document.title = (s.command ? s.command + ' — ' : '') + (s.path || currentName);
  } catch { /* leave previous */ }
}
function startTitlePolling() {
  clearInterval(titleTimer);
  refreshTitle();
  titleTimer = setInterval(refreshTitle, 4000);
}
function stopTitlePolling() {
  clearInterval(titleTimer);
  titleTimer = null;
  termSubEl.textContent = '';
  document.title = 'terminal';
}

// --- copy view: full tmux history as selectable DOM text ------------------

function localBufferText() {
  if (!term) return '';
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const ln = buf.getLine(i);
    lines.push(ln ? ln.translateToString(true) : '');
  }
  return lines.join('\n');
}

async function openCopyView() {
  if (!term) return;
  copyTextEl.value = 'Loading history…';
  copyViewEl.hidden = false;
  let text = '';
  if (currentName) {
    try {
      const res = await fetch('/api/capture?name=' + encodeURIComponent(currentName), { cache: 'no-store' });
      if (res.ok) text = await res.text();
    } catch { /* fall back below */ }
  }
  if (!text) text = localBufferText(); // new/unnamed session or capture failed
  copyTextEl.value = text.replace(/\s+$/, '') + '\n';
  requestAnimationFrame(() => { copyTextEl.scrollTop = copyTextEl.scrollHeight; });
}
function closeCopyView() {
  copyViewEl.hidden = true;
  if (term) term.focus();
}

$('copy').addEventListener('click', openCopyView);
$('copy-close').addEventListener('click', closeCopyView);
$('copy-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(copyTextEl.value);
    const prev = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = prev; }, 1300);
  } catch {
    // Clipboard API blocked: select all in the textarea so the user can copy.
    copyTextEl.focus();
    copyTextEl.setSelectionRange(0, copyTextEl.value.length);
  }
});

// --- session switcher -----------------------------------------------------

// Group header with a per-machine "＋ New" button (so each PC can start its own
// session — locally, or on a peer by opening it there).
function groupHeader(text, onNew) {
  const li = document.createElement('li');
  li.className = 'switcher-group';
  const label = document.createElement('span');
  label.textContent = text;
  li.append(label);
  if (onNew) {
    const btn = document.createElement('button');
    btn.className = 'btn group-new';
    btn.textContent = '＋ New';
    btn.addEventListener('click', (e) => { e.stopPropagation(); onNew(); });
    li.append(btn);
  }
  return li;
}
function noticeRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

async function openSwitcher() {
  switcherList.innerHTML = '';
  switcherEl.hidden = false;
  // 1) This machine's sessions render immediately (fast path).
  switcherList.append(groupHeader('This PC', () => switchSession('new')));
  const localLoading = noticeRow('Loading…');
  switcherList.append(localLoading);
  let sessions = [];
  try { sessions = await fetchSessions(); } catch { /* show empty */ }
  localLoading.remove();
  if (!sessions.length) switcherList.append(noticeRow('No sessions'));
  for (const s of sessions) {
    switcherList.append(sessionItem(s, {
      current: s.name === currentName,
      onClick: () => switchSession('attach', s.name),
    }));
  }
  // 2) Other machines stream in afterwards, each under its own header.
  loadPeerGroups();
}

// Fetch peers, then for each append a header + loading row and resolve its
// sessions independently. Each peer's rows are inserted right before its own
// loading anchor, so concurrent loads stay grouped under the correct header.
async function loadPeerGroups() {
  let data;
  try { data = await (await fetch('/api/tailnet', { cache: 'no-store' })).json(); }
  catch { return; }
  const peers = (data && data.enabled && Array.isArray(data.peers)) ? data.peers : [];
  for (const p of peers) {
    if (switcherEl.hidden) return; // switcher closed meanwhile
    // Peer "New" opens a fresh session on that machine via a #new deep link.
    switcherList.append(groupHeader(p.name || p.dns, () => { location.href = p.url + '#new'; }));
    const loading = noticeRow('Loading…');
    switcherList.append(loading);
    fetchPeerSessions(p).then((sessions) => {
      if (switcherEl.hidden || !loading.isConnected) return;
      const frag = document.createDocumentFragment();
      if (!sessions.length) frag.append(noticeRow('No sessions'));
      for (const s of sessions) {
        frag.append(sessionItem(s, {
          onClick: () => { location.href = p.url + '#s=' + encodeURIComponent(s.name); },
        }));
      }
      switcherList.insertBefore(frag, loading);
      loading.remove();
    });
  }
}

async function fetchPeerSessions(peer) {
  try {
    const res = await fetch(`/api/peer/sessions?dns=${encodeURIComponent(peer.dns)}&ip=${encodeURIComponent(peer.ip)}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()).sessions || [];
  } catch { return []; }
}
function closeSwitcher() { switcherEl.hidden = true; }

termNameEl.addEventListener('click', openSwitcher);
$('switcher-close').addEventListener('click', closeSwitcher);
switcherEl.addEventListener('click', (e) => { if (e.target === switcherEl) closeSwitcher(); });

// --- fit / resize ---------------------------------------------------------

let fitTimer = null;
function doFit() {
  if (!fit || termView.hidden) return;
  try { fit.fit(); } catch { return; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(doFit, 120);
}

// Pin the app to the visual viewport so the keys bar + prompt stay above the
// on-screen keyboard (which shrinks visualViewport.height but not innerHeight).
function setAppHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');
}
function onViewportChange() {
  setAppHeight();
  scheduleFit();
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onViewportChange);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}
setAppHeight();

// --- top-bar controls -----------------------------------------------------

$('back').addEventListener('click', backToPicker);

// ⌨ toggles the on-screen keyboard (focus to show, blur to hide).
$('kbd').addEventListener('click', () => {
  if (!term) return;
  const ta = termContainer.querySelector('.xterm-helper-textarea');
  if (ta && document.activeElement === ta) ta.blur();
  else focusActiveInput();
});

// --- compose bar: reliable mobile text entry ------------------------------
// Typing directly into xterm routes through the browser IME, and some mobile
// keyboards (T9 / predictive text) double characters that way. The compose bar is
// a plain textarea where that never happens: type (suggestions work), optionally
// edit, then Send pushes the text to the PTY in one shot.
let composeOpen = false;
function focusActiveInput() {
  if (composeOpen) composeInput.focus();
  else if (term) term.focus();
}
function autosizeCompose() {
  composeInput.style.height = 'auto';
  composeInput.style.height = Math.min(composeInput.scrollHeight, 120) + 'px';
}
function openCompose() {
  composeOpen = true;
  composeEl.hidden = false;
  $('compose-btn').classList.add('armed');
  autosizeCompose();
  scheduleFit();
  composeInput.focus();
}
function closeCompose() {
  composeOpen = false;
  composeEl.hidden = true;
  $('compose-btn').classList.remove('armed');
  scheduleFit();
  if (term) term.focus();
}
function toggleCompose() { if (composeOpen) closeCompose(); else openCompose(); }

// Push the composed text to the terminal. withEnter also submits the line.
function sendCompose(withEnter) {
  const text = composeInput.value;
  if (text) { ensureBottom(); noteInput(text); sendBytes(text); }
  if (withEnter) { ensureBottom(); sendBytes('\r'); lastInput = ''; }
  composeInput.value = '';
  autosizeCompose();
  composeInput.focus(); // keep the keyboard up for the next line
}

$('compose-btn').addEventListener('click', toggleCompose);
$('compose-send').addEventListener('click', () => sendCompose(false));
$('compose-go').addEventListener('click', () => sendCompose(true));
composeInput.addEventListener('input', autosizeCompose);
composeInput.addEventListener('keydown', (e) => {
  // Enter submits (send + Enter); Shift+Enter inserts a newline for multi-line.
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompose(true); }
});

$('paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && await confirmLarge(text)) { ensureBottom(); sendBytes(text); }
  } catch {
    overlayText.textContent = 'Clipboard blocked — long-press the screen to paste.';
    overlay.hidden = false;
    setTimeout(() => { overlay.hidden = true; }, 1600);
  }
  if (term) term.focus();
});

// --- terminal menu --------------------------------------------------------

const menuEl = $('menu');
function openMenu() { $('font-val').textContent = String(fontSize); menuEl.hidden = false; }
function closeMenu() { menuEl.hidden = true; }

$('menu-btn').addEventListener('click', openMenu);
$('menu-close').addEventListener('click', closeMenu);
menuEl.addEventListener('click', (e) => { if (e.target === menuEl) closeMenu(); });

$('font-dec').addEventListener('click', () => setFontSize(fontSize - 1));
$('font-inc').addEventListener('click', () => setFontSize(fontSize + 1));

$('menu-bottom').addEventListener('click', () => {
  ensureBottom();
  if (term) term.scrollToBottom();
  closeMenu();
  if (term) term.focus();
});

$('menu-reconnect').addEventListener('click', () => {
  closeMenu();
  reconnectNow();
  if (term) term.focus();
});

// --- fleet update with a progress window ----------------------------------
// This PC is the source of truth: it tells every tailnet peer to self-update,
// then we poll each peer's reported version until it matches this PC's (= it
// pulled the new code and restarted). This PC itself isn't restarted, so it can
// keep proxying peer health for the progress UI.
const updateProgressEl = $('update-progress');
let updatePoll = null;

function closeUpdateProgress() {
  clearInterval(updatePoll);
  updatePoll = null;
  updateProgressEl.hidden = true;
}
$('update-close').addEventListener('click', closeUpdateProgress);
updateProgressEl.addEventListener('click', (e) => { if (e.target === updateProgressEl) closeUpdateProgress(); });

function updateRow(m) {
  const li = document.createElement('li');
  li.className = 'session';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = m.name + (m.self ? '  (this PC)' : '');
  const sub = document.createElement('div');
  sub.className = 'sub';
  meta.append(name, sub);
  const badge = document.createElement('span');
  badge.className = 'badge';
  li.append(meta, badge);
  m.subEl = sub; m.badgeEl = badge;
  setRowState(m, m.self ? 'done' : 'queued');
  return li;
}
function setRowState(m, state, detail) {
  m.state = state;
  const map = {
    queued:   ['queued…',     ''],
    updating: ['updating…',   'live'],
    done:     ['✓ updated',   'live'],
    current:  ['✓ current',   'live'],
    failed:   ['✗ failed',    ''],
    timeout:  ['⏱ slow…',     ''],
  };
  const [label, cls] = map[state] || ['', ''];
  m.badgeEl.textContent = m.self && state === 'done' ? '✓ current' : label;
  m.badgeEl.className = 'badge' + (cls ? ' ' + cls : '');
  if (detail !== undefined) m.subEl.textContent = detail;
}

$('menu-update').addEventListener('click', async () => {
  const ok = await askConfirm({
    title: 'Update all PCs',
    message: 'Update every other webmux machine on your tailnet to this PC’s version (non-interactive — each keeps its own settings)?',
    okLabel: 'Update all',
  });
  if (!ok) return;
  closeMenu();
  openUpdateProgress();
});

async function openUpdateProgress() {
  const listEl = $('update-list');
  const note = $('update-note');
  listEl.innerHTML = '';
  note.textContent = 'Starting…';
  updateProgressEl.hidden = false;

  const self = { id: 'self', name: 'This PC', self: true };
  const machines = [self];
  listEl.append(updateRow(self));

  let target = '';
  let peers = [];
  try {
    const res = await fetch('/api/update?scope=all', { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'update failed');
    target = j.version || '';
    peers = Array.isArray(j.peers) ? j.peers : [];
  } catch (e) {
    note.textContent = 'Could not start update: ' + (e.message || e);
    return;
  }
  self.subEl.textContent = target ? 'version ' + target : '';

  for (const p of peers) {
    const m = { id: p.dns, name: p.name, dns: p.dns, ip: p.ip };
    machines.push(m);
    listEl.append(updateRow(m));
    // Always watch by version (the source of truth) even if the trigger was
    // unconfirmed — a peer can close us before acking yet still be updating.
    setRowState(m, 'updating', p.ok ? `triggered via ${p.via}` : 'trigger unconfirmed, watching…');
  }
  if (peers.length === 0) { note.textContent = 'No other webmux machines found on the tailnet.'; return; }

  const peerMachines = machines.filter((m) => !m.self);
  const started = Date.now();
  const TIMEOUT_MS = 240000;
  note.textContent = `Updating ${peerMachines.length} machine(s) to ${target || 'latest'}…`;

  const tick = async () => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    await Promise.all(peerMachines.map(async (m) => {
      if (m.state === 'done' || m.state === 'failed') return;
      let health = null;
      try {
        const r = await fetch(`/api/peer/health?dns=${encodeURIComponent(m.dns)}&ip=${encodeURIComponent(m.ip)}`, { cache: 'no-store' });
        if (r.ok) health = await r.json();
      } catch { /* unreachable mid-restart */ }
      const v = health && health.version;
      if (v && (!target || v === target)) setRowState(m, 'done', 'version ' + v);
      else if (Date.now() - started > TIMEOUT_MS) setRowState(m, 'timeout', v ? 'still on ' + v : 'no response');
      else setRowState(m, 'updating', v ? 'on ' + v + ', updating…' : `updating… (${elapsed}s)`);
    }));
    const pending = peerMachines.filter((m) => m.state === 'updating');
    if (!pending.length) {
      clearInterval(updatePoll); updatePoll = null;
      const done = peerMachines.filter((m) => m.state === 'done').length;
      note.textContent = `Done — ${done}/${peerMachines.length} updated.` +
        (done < peerMachines.length ? ' Some may still be finishing (slow boxes rebuild node-pty).' : '');
    }
  };
  clearInterval(updatePoll);
  updatePoll = setInterval(tick, 4000);
  tick();
}

$('menu-windows').addEventListener('click', () => { closeMenu(); openWindows(); });

// Pop the current session open as a real terminal window on the PC (it attaches
// the existing session, so the desktop and the browser share the same tmux).
$('menu-open-pc').addEventListener('click', async () => {
  const btn = $('menu-open-pc');
  if (!currentName) { closeMenu(); return; }
  const prev = btn.textContent;
  try {
    const res = await fetch('/api/open?name=' + encodeURIComponent(currentName), { method: 'POST' });
    btn.textContent = res.ok ? '🖥 Opened on PC ✓' : '🖥 Could not open';
  } catch {
    btn.textContent = '🖥 Could not open';
  }
  setTimeout(() => { btn.textContent = prev; closeMenu(); if (term) term.focus(); }, 1100);
});

$('menu-kill').addEventListener('click', async () => {
  if (!currentName) { closeMenu(); return; }
  const ok = await askConfirm({
    title: 'Close session',
    message: `Kill tmux session "${currentName}"? This ends it for all clients (including the desktop terminal).`,
    okLabel: 'Kill session',
    danger: true,
  });
  if (!ok) return;
  try {
    await fetch('/api/kill?name=' + encodeURIComponent(currentName), { method: 'POST' });
  } catch { /* the session may just disappear; fall through to picker */ }
  closeMenu();
  backToPicker();
});

// --- window switcher ------------------------------------------------------

function closeWindows() { windowsEl.hidden = true; }

async function openWindows() {
  windowsList.innerHTML = '<li class="empty">Loading…</li>';
  windowsEl.hidden = false;
  await refreshWindows();
}

async function refreshWindows() {
  if (!currentName) { windowsList.innerHTML = '<li class="empty">No session</li>'; return; }
  let wins = [];
  try {
    const res = await fetch('/api/windows?name=' + encodeURIComponent(currentName), { cache: 'no-store' });
    if (res.ok) wins = (await res.json()).windows || [];
  } catch { /* show empty */ }
  windowsList.innerHTML = '';
  if (!wins.length) { windowsList.innerHTML = '<li class="empty">No windows</li>'; return; }
  for (const w of wins) {
    const li = document.createElement('li');
    li.className = 'session' + (w.active ? ' current' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${w.index}: ${w.name}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = w.command || '';
    meta.append(name, sub);
    li.append(meta);
    if (w.active) {
      const badge = document.createElement('span');
      badge.className = 'badge live';
      badge.textContent = 'active';
      li.append(badge);
    } else {
      meta.addEventListener('click', () => windowAction('select', w.index));
      const kill = document.createElement('button');
      kill.className = 'btn btn-danger';
      kill.textContent = '✕';
      kill.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await askConfirm({
          title: 'Close window',
          message: `Kill window ${w.index} (${w.name})?`,
          okLabel: 'Kill window',
          danger: true,
        });
        if (ok) windowAction('kill', w.index);
      });
      li.append(kill);
    }
    windowsList.append(li);
  }
}

async function windowAction(action, index) {
  if (!currentName) return;
  let q = `/api/windows?name=${encodeURIComponent(currentName)}&action=${action}`;
  if (index != null) q += `&index=${index}`;
  try { await fetch(q, { method: 'POST' }); } catch { /* ignore */ }
  if (action === 'select') { closeWindows(); if (term) term.focus(); return; }
  await refreshWindows();
}

$('windows-close').addEventListener('click', closeWindows);
$('windows-new').addEventListener('click', () => windowAction('new'));
windowsEl.addEventListener('click', (e) => { if (e.target === windowsEl) closeWindows(); });

// --- reconnect on resume (phone wake / network change) --------------------

function reconnectNow() {
  if (userDetached || !currentName) return;
  teardownWs();
  netTicks = 0;
  reconnectDelay = 500;
  connect('attach', currentName);
}

// On resume, probe the socket: if it's closed, reconnect now; if it looks open
// but doesn't answer a ping within 3s (a zombie socket after sleep), reconnect.
function maybeResume() {
  if (userDetached || !currentName) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return reconnectNow();
  awaitingPong = true;
  try { ws.send(JSON.stringify({ type: 'ping' })); } catch { return reconnectNow(); }
  setTimeout(() => { if (awaitingPong && !userDetached) reconnectNow(); }, 3000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeResume();
});
window.addEventListener('online', maybeResume);
window.addEventListener('focus', maybeResume);

// --- service worker (installable PWA) -------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// --- deep link: open directly into #s=<name> -----------------------------
function openFromHash() {
  if (location.hash === '#new') {
    // Arrived via a peer's "＋ New" — start a fresh session here. Clear the hash
    // first so a reload doesn't spawn another one before the session handshake.
    history.replaceState(null, '', location.pathname + location.search);
    return openSession('new');
  }
  const m = /^#s=(.+)$/.exec(location.hash);
  if (m) openSession('attach', decodeURIComponent(m[1]));
}

// =====================  boot  ============================================
loadSessions();
openFromHash();
