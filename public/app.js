'use strict';

// --- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const pickerView = $('picker');
const termView = $('terminal-view');
const sessionsEl = $('sessions');
const pickerEmpty = $('picker-empty');
const pickerStatus = $('picker-status');
const termNameEl = $('term-name');
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
  } catch (e) {
    pickerStatus.textContent = 'Failed to load sessions: ' + e.message;
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
  const sub = document.createElement('div');
  sub.className = 'sub';
  const cmd = document.createElement('span');
  cmd.className = 'cmd';
  cmd.textContent = s.command || 'shell';
  sub.append(cmd, document.createTextNode('  ·  ' + (s.path || '') +
    (s.windows > 1 ? `  ·  ${s.windows} windows` : '')));
  meta.append(name, sub);

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

let fontSize = clampFont(parseInt(localStorage.getItem('ptw-font') || '14', 10));
function clampFont(px) { return Math.max(9, Math.min(28, Number.isFinite(px) ? px : 14)); }
function setFontSize(px) {
  fontSize = clampFont(px);
  localStorage.setItem('ptw-font', String(fontSize));
  const val = $('font-val');
  if (val) val.textContent = String(fontSize);
  if (term) { term.options.fontSize = fontSize; doFit(); }
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
  if (k.mod) toggleMod(k.mod);
  else pressKey(k);
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
      if (key && key._key) { handleKey(key._key); if (term) term.focus(); }
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
    confirmLarge(data).then((ok) => { if (ok) { ensureBottom(); sendBytes(data); } });
    return;
  }
  ensureBottom(); // a keystroke means "go live"
  if (data.length === 1 && (shiftArmed || ctrlArmed || altArmed)) {
    const out = applyMods(data);
    clearMods();
    return sendBytes(out);
  }
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

// Open from the picker: show the terminal view, then (re)attach.
function openSession(mode, name) {
  ensureTerm();
  pickerView.hidden = true;
  termView.hidden = false;
  requestAnimationFrame(() => switchSession(mode, name));
}

// Switch the live terminal to a different session without leaving the view.
function switchSession(mode, name) {
  closeSwitcher();
  teardownWs();
  clearMods();
  netTicks = 0;
  userDetached = false;
  reconnectDelay = 500;
  currentName = mode === 'attach' ? name : null;
  termNameEl.textContent = mode === 'attach' ? name : 'new session…';
  if (term) term.reset();
  doFit();
  connect(mode, name);
  if (term) term.focus();
}

function wsUrl(mode, name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const dims = term ? `cols=${term.cols}&rows=${term.rows}` : '';
  if (mode === 'attach') {
    return `${proto}://${location.host}/ws/session/${encodeURIComponent(name)}?${dims}`;
  }
  // New sessions open a real terminal window on the PC (desktop=1) so they
  // persist after the browser leaves and are visible locally.
  const params = [dims, 'desktop=1'];
  if (name) params.push(`name=${encodeURIComponent(name)}`);
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

function connect(mode, name) {
  clearTimeout(reconnectTimer);
  setConn('connecting', 'connecting…');
  ws = new WebSocket(wsUrl(mode, name));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectDelay = 500;
    overlay.hidden = true;
    setConn('ok', 'connected');
    doFit(); // push our real size to tmux
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
      termNameEl.textContent = msg.name;
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
  resolveConfirm(false);
  copyViewEl.hidden = true;
  clearMods();
  teardownWs();
  overlay.hidden = true;
  termView.hidden = true;
  pickerView.hidden = false;
  if (term) term.reset();
  loadSessions();
}

function setConn(cls, text) {
  connEl.className = 'conn ' + cls; // dot rendered via CSS; color conveys state
  connEl.title = text;
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

async function openSwitcher() {
  switcherList.innerHTML = '<li class="empty">Loading…</li>';
  switcherEl.hidden = false;
  let sessions = [];
  try { sessions = await fetchSessions(); } catch { /* show empty */ }
  switcherList.innerHTML = '';
  if (!sessions.length) {
    switcherList.innerHTML = '<li class="empty">No sessions</li>';
    return;
  }
  for (const s of sessions) {
    switcherList.append(sessionItem(s, {
      current: s.name === currentName,
      onClick: () => switchSession('attach', s.name),
    }));
  }
}
function closeSwitcher() { switcherEl.hidden = true; }

termNameEl.addEventListener('click', openSwitcher);
$('switcher-close').addEventListener('click', closeSwitcher);
$('switcher-new').addEventListener('click', () => switchSession('new'));
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
  else term.focus();
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

$('menu-windows').addEventListener('click', () => { closeMenu(); openWindows(); });

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

// =====================  boot  ============================================
loadSessions();
