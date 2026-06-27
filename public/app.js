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
const snippetsEl = $('snippets');
const snipEditEl = $('snip-edit');
const snipEditText = $('snip-edit-text');
const copySearchInput = $('copy-search-input');
const copySearchCount = $('copy-search-count');

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
const statHistory = {}; // key -> recent cpu samples, for the sparkline
function pushHistory(key, v) {
  const a = statHistory[key] || (statHistory[key] = []);
  a.push(v);
  if (a.length > 40) a.shift();
}
function drawSpark(canvas, data) {
  const c = canvas.getContext && canvas.getContext('2d');
  if (!c) return;
  const w = canvas.width, h = canvas.height;
  c.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const pt = (i) => [(i / (data.length - 1)) * w, h - (Math.max(0, Math.min(100, data[i])) / 100) * (h - 3) - 1.5];
  c.beginPath();
  data.forEach((_, i) => { const [x, y] = pt(i); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = '#2f81f7'; c.lineWidth = 1.5; c.stroke();
  c.lineTo(w, h); c.lineTo(0, h); c.closePath();
  c.fillStyle = 'rgba(47,129,247,0.15)'; c.fill();
}
async function refreshMachineStats() {
  await Promise.all(machineStatsTargets.map(async (t) => {
    let s = null;
    try { const r = await fetch(t.url, { cache: 'no-store' }); if (r.ok) s = await r.json(); } catch { /* unreachable */ }
    t.last = s;
    if (s && s.cpu != null) pushHistory(t.key, s.cpu);
    if (t.statsEl.isConnected) t.statsEl.textContent = fmtStats(s);
    if (t.spark) drawSpark(t.spark, statHistory[t.key] || []);
  }));
  if (detailTarget && !$('machine-detail').hidden) renderMachineDetail();
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
  const info = document.createElement('button');
  info.className = 'machine-info';
  info.textContent = 'ⓘ';
  info.title = 'Details';
  info.addEventListener('pointerdown', (e) => e.preventDefault());
  nameEl.append(label, info);
  const statsEl = document.createElement('span');
  statsEl.className = 'machine-stats';
  statsEl.textContent = '…';
  const spark = document.createElement('canvas');
  spark.className = 'machine-spark';
  spark.width = 240; spark.height = 36;
  el.append(nameEl, statsEl, spark);
  return { el, nameEl, statsEl, spark, info };
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
    const label = (data.self.dns || '').split('.')[0] || 'this';
    const { el, nameEl, statsEl, spark, info } = machineCard('span', label);
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
    const t = { statsEl, spark, url: '/api/stats', key: '/api/stats', procsUrl: '/api/procs', last: null };
    machineStatsTargets.push(t);
    info.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMachineDetail(t, label); });
  } else if (issue) {
    const { el } = machineCard('span', 'this PC');
    el.classList.add('current', 'unreachable');
    el.title = issue.message;
    row.append(el);
    machineStatsTargets.push({ statsEl: el.querySelector('.machine-stats'), spark: el.querySelector('.machine-spark'), url: '/api/stats', key: '/api/stats', last: null });
  }

  for (const p of peers) {
    const { el, statsEl, spark, info } = machineCard('a', p.name || p.dns);
    el.href = p.url;                 // same-tab navigation (no target=_blank)
    el.title = p.dns;
    el.addEventListener('click', (e) => {
      if (el.dataset.unreachable === '1') { e.preventDefault(); showMachineHint(p); }
    });
    row.append(el);
    const url = `/api/peer/stats?dns=${encodeURIComponent(p.dns)}&ip=${encodeURIComponent(p.ip)}`;
    const procsUrl = `/api/peer/procs?dns=${encodeURIComponent(p.dns)}&ip=${encodeURIComponent(p.ip)}`;
    const t = { statsEl, spark, url, key: url, procsUrl, last: null };
    machineStatsTargets.push(t);
    info.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMachineDetail(t, p.name || p.dns); });
    // Probe from THIS device; if unreachable, mark it and offer the hint. Skip
    // plain-HTTP peers (phones): a no-cors probe from the HTTPS app is
    // mixed-content-blocked, which would falsely mark them unreachable.
    if (p.url.startsWith('https://')) probeReachable(p.url).then((ok) => {
      if (!ok) { el.classList.add('unreachable'); el.dataset.unreachable = '1'; }
    });
  }
  if (issue) renderMachineHint(hint, issue.message, issue.command);
  wrap.hidden = false;
  refreshMachineStats();
  startStatsPolling();
}

// --- machine detail (top procs / temp / uptime / load) --------------------
let detailTarget = null;
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : (h ? `${h}h ${m}m` : `${m}m`);
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function openMachineDetail(t, name) {
  detailTarget = t;
  t.procs = null; // not yet loaded
  $('machine-detail-name').textContent = name;
  $('machine-detail').hidden = false;
  renderMachineDetail();
  // Top procs are fetched on demand (ps is too heavy for the routine poll).
  if (t.procsUrl) {
    try {
      const r = await fetch(t.procsUrl, { cache: 'no-store' });
      if (r.ok && detailTarget === t) { t.procs = (await r.json()).top || []; renderMachineDetail(); }
    } catch { /* leave as loading */ }
  }
}
function closeMachineDetail() { detailTarget = null; $('machine-detail').hidden = true; }
function renderMachineDetail() {
  const body = $('machine-detail-body');
  const s = detailTarget && detailTarget.last;
  if (!s) { body.textContent = 'Loading…'; return; }
  const meta = [];
  if (s.uptime != null) meta.push('up ' + fmtUptime(s.uptime));
  if (s.temp != null) meta.push(s.temp + '°C');
  if (s.load) meta.push('load ' + s.load.join(' '));
  const rows = [`<div class="md-line"><b>${escapeHtml(fmtStats(s))}</b></div>`];
  if (meta.length) rows.push(`<div class="md-line">${escapeHtml(meta.join('  ·  '))}</div>`);
  if (s.disk && s.disk.total) rows.push(`<div class="md-line">disk ${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)} (${s.disk.usedPct}% used)</div>`);
  rows.push('<div class="md-sub">Top processes</div>');
  const top = detailTarget.procs;
  if (top == null) rows.push('<div class="md-line">loading…</div>');
  else if (!top.length) rows.push('<div class="md-line">—</div>');
  else for (const p of top) rows.push(`<div class="md-proc"><span>${escapeHtml(p.cmd)}</span><span>${p.cpu}%</span></div>`);
  body.innerHTML = rows.join('');
}
$('machine-detail-close').addEventListener('click', closeMachineDetail);
$('machine-detail').addEventListener('click', (e) => { if (e.target === $('machine-detail')) closeMachineDetail(); });

// --- broadcast a command to the whole fleet -------------------------------
function openBroadcast() {
  $('broadcast-results').innerHTML = '';
  $('broadcast-cmd').value = '';
  $('broadcast').hidden = false;
  setTimeout(() => $('broadcast-cmd').focus(), 50);
}
function closeBroadcast() { $('broadcast').hidden = true; }
async function runBroadcast() {
  const cmd = $('broadcast-cmd').value.trim();
  if (!cmd) return;
  const ok = await askConfirm({ title: 'Run on all PCs', message: `Run "${cmd}" on this PC and every tailnet peer?`, okLabel: 'Run', danger: true });
  if (!ok) return;
  const resEl = $('broadcast-results');
  resEl.innerHTML = '<div class="md-sub">Running…</div>';
  try {
    const r = await fetch('/api/broadcast?scope=all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) });
    const j = await r.json();
    resEl.innerHTML = '';
    for (const res of (j.results || [])) {
      const block = document.createElement('div');
      block.className = 'bc-result' + (res.ok ? '' : ' bad');
      const head = document.createElement('div');
      head.className = 'bc-host';
      head.textContent = `${res.host || '?'} ${res.ok ? '✓' : '✗'}`;
      const pre = document.createElement('pre');
      pre.className = 'bc-out';
      pre.textContent = res.output || '(no output)';
      block.append(head, pre);
      resEl.append(block);
    }
    if (!j.results || !j.results.length) resEl.innerHTML = '<div class="md-sub">No results.</div>';
  } catch (e) {
    resEl.innerHTML = '<div class="md-sub">Failed: ' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
$('broadcast-btn').addEventListener('click', openBroadcast);
$('broadcast-close').addEventListener('click', closeBroadcast);
$('broadcast').addEventListener('click', (e) => { if (e.target === $('broadcast')) closeBroadcast(); });
$('broadcast-run').addEventListener('click', runBroadcast);
$('broadcast-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runBroadcast(); } });

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

// "Seen" activity timestamps (server's session_activity, seconds) per session,
// so the picker can flag sessions that produced output since you last viewed them.
function loadSeen() { try { return JSON.parse(localStorage.getItem('ptw-seen')) || {}; } catch { return {}; } }
function markSeen(name, activity) {
  if (!name || !activity) return;
  const m = loadSeen();
  if (m[name] === activity) return;
  m[name] = activity;
  const keys = Object.keys(m);
  if (keys.length > 200) delete m[keys[0]];
  try { localStorage.setItem('ptw-seen', JSON.stringify(m)); } catch { /* quota */ }
}

function sessionItem(s, { current = false, onClick } = {}) {
  const li = document.createElement('li');
  li.className = 'session' + (current ? ' current' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = s.name;
  // "New output since you last looked" dot (unattached sessions only).
  if (!current && s.activity && s.activity > (loadSeen()[s.name] || 0) && !(s.attached > 0)) {
    const dot = document.createElement('span');
    dot.className = 'act-dot';
    dot.title = 'new output since you last looked';
    dot.textContent = '●';
    name.prepend(dot);
  }
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
  renderSnippets();
  applySnippetsVisibility();
  fetchSnippets(); // pull the fleet-shared list from the server, then re-render
}

// The scrollback lives in tmux, not in xterm. tmux `mouse on` means a real mouse
// wheel scrolls it (via copy-mode); on a phone there's no wheel, so we translate
// a finger drag — and a flick's inertia — into SGR wheel sequences for tmux. A
// plain tap is left untouched so it still focuses + opens the keyboard.
//
// One wheel ≈ one terminal line of finger travel (so content roughly tracks the
// finger); momentum keeps it gliding after a flick, with friction. The step is
// derived from the rendered cell height so it adapts to the current font size.
function cellHeightPx() {
  if (!term || !term.rows) return 18;
  const h = termContainer.clientHeight / term.rows;
  return (Number.isFinite(h) && h > 4) ? h : 18;
}
function setupTouchScroll() {
  let startY = 0, lastY = 0, lastT = 0, accum = 0, vel = 0, step = 18, scrolling = false, momentum = 0;
  const stopMomentum = () => { if (momentum) { cancelAnimationFrame(momentum); momentum = 0; } };
  // Accumulate finger pixels; emit whole wheel ticks as they cross the step.
  const feed = (dyPx) => {
    accum += dyPx;
    const ticks = Math.trunc(accum / step);
    if (ticks !== 0) { wheelScroll(ticks); accum -= ticks * step; }
  };

  termContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    stopMomentum();
    startY = lastY = e.touches[0].clientY;
    lastT = performance.now();
    accum = 0; vel = 0; scrolling = false;
    step = cellHeightPx();
  }, { capture: true, passive: true });

  termContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY, t = performance.now();
    if (!scrolling) {
      if (Math.abs(y - startY) <= 8) { lastY = y; lastT = t; return; }
      scrolling = true; lastY = y; lastT = t; // start fresh so the first delta is small
    }
    e.preventDefault();
    e.stopPropagation(); // keep it away from xterm's own mouse forwarding
    const dy = y - lastY, dt = Math.max(1, t - lastT);
    vel = dy / dt; // px per ms (signed; +down => scroll to older)
    feed(dy);
    lastY = y; lastT = t;
  }, { capture: true, passive: false });

  const onEnd = (e) => {
    if (scrolling) e.stopPropagation(); // suppress the synthetic tap after a scroll
    scrolling = false;
    let v = Math.max(-3, Math.min(3, vel)) * 16; // px/frame, capped
    if (Math.abs(v) < 4) return;                 // not a flick → no inertia
    const glide = () => {
      v *= 0.94;
      if (Math.abs(v) < 1) { momentum = 0; return; }
      feed(v);
      momentum = requestAnimationFrame(glide);
    };
    momentum = requestAnimationFrame(glide);
  };
  termContainer.addEventListener('touchend', onEnd, { capture: true });
  termContainer.addEventListener('touchcancel', () => { scrolling = false; stopMomentum(); }, { capture: true });
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
  closeMachineDetail();
  closeBroadcast();
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
  closeSnipEdit();
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
    markSeen(currentName, s.activity); // viewing it ⇒ caught up on its output
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

async function openCopyView(opts = {}) {
  if (!term) return;
  copyTextEl.value = 'Loading history…';
  copyViewEl.hidden = false;
  resetSearch();
  let text = '';
  if (currentName) {
    try {
      const res = await fetch('/api/capture?name=' + encodeURIComponent(currentName), { cache: 'no-store' });
      if (res.ok) text = await res.text();
    } catch { /* fall back below */ }
  }
  if (!text) text = localBufferText(); // new/unnamed session or capture failed
  copyTextEl.value = text.replace(/\s+$/, '') + '\n';
  if (opts.search) requestAnimationFrame(() => copySearchInput.focus());
  else requestAnimationFrame(() => { copyTextEl.scrollTop = copyTextEl.scrollHeight; });
}
function closeCopyView() {
  copyViewEl.hidden = true;
  if (term) term.focus();
}

// Scrollback search over the captured buffer: find all matches, jump between them
// by selecting + scrolling the textarea to each.
let searchMatches = [], searchIdx = -1;
function resetSearch() { copySearchInput.value = ''; searchMatches = []; searchIdx = -1; copySearchCount.textContent = ''; }
function runSearch() {
  const q = copySearchInput.value;
  const text = copyTextEl.value;
  searchMatches = [];
  if (q) {
    const lc = text.toLowerCase(), ql = q.toLowerCase();
    for (let i = lc.indexOf(ql); i !== -1; i = lc.indexOf(ql, i + ql.length)) searchMatches.push(i);
  }
  searchIdx = searchMatches.length ? 0 : -1;
  if (searchIdx >= 0) gotoMatch(0); else updateSearchCount();
}
function updateSearchCount() {
  copySearchCount.textContent = searchMatches.length
    ? `${searchIdx + 1}/${searchMatches.length}`
    : (copySearchInput.value ? '0' : '');
}
function gotoMatch(idx) {
  if (idx < 0 || idx >= searchMatches.length) return;
  searchIdx = idx;
  const start = searchMatches[idx], end = start + copySearchInput.value.length;
  const line = (copyTextEl.value.slice(0, start).match(/\n/g) || []).length;
  const lh = parseFloat(getComputedStyle(copyTextEl).lineHeight) || 18;
  copyTextEl.scrollTop = Math.max(0, line * lh - copyTextEl.clientHeight / 3);
  try { copyTextEl.focus({ preventScroll: true }); copyTextEl.setSelectionRange(start, end); } catch { /* ignore */ }
  updateSearchCount();
}
function stepSearch(d) {
  if (!searchMatches.length) return;
  gotoMatch((searchIdx + d + searchMatches.length) % searchMatches.length);
}
copySearchInput.addEventListener('input', runSearch);
copySearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); } });
$('copy-search-prev').addEventListener('click', () => stepSearch(-1));
$('copy-search-next').addEventListener('click', () => stepSearch(1));

$('copy').addEventListener('click', () => openCopyView());
$('copy-close').addEventListener('click', closeCopyView);
$('menu-search').addEventListener('click', () => { closeMenu(); openCopyView({ search: true }); });
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

// --- compose bar: reliable mobile text entry with history + undo ----------
// A plain textarea (no IME doubling). It auto-grows, keeps a persisted, navigable
// history of inputs, continuously saves the live draft as the "last" item (so a
// reload never loses it), starts a fresh history item on each Send, and has an
// Undo for accidental big pastes.
let composeOpen = false;
const COMPOSE_HIST_KEY = 'ptw-compose-history';
const COMPOSE_DRAFT_KEY = 'ptw-compose-draft';
const COMPOSE_HISTORY_MAX = 100;
const COMPOSE_UNDO_THRESHOLD = 24; // a one-event length jump this big counts as a paste
function loadComposeEntries() {
  try { const a = JSON.parse(localStorage.getItem(COMPOSE_HIST_KEY)); return Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []; }
  catch { return []; }
}
let composeEntries = loadComposeEntries();
let composeDraft = '';
try { composeDraft = localStorage.getItem(COMPOSE_DRAFT_KEY) || ''; } catch { /* none */ }
let composeNav = composeEntries.length; // == length ⇒ editing the live draft
let composeUndoVal = null;              // toggled value for the Undo button
let composePrev = '';                   // previous field value (to detect big changes)
function saveComposeEntries() {
  try { localStorage.setItem(COMPOSE_HIST_KEY, JSON.stringify(composeEntries.slice(-COMPOSE_HISTORY_MAX))); } catch { /* quota */ }
}
let composeDraftTimer = null;
function saveComposeDraft() {
  clearTimeout(composeDraftTimer);
  composeDraftTimer = setTimeout(() => { try { localStorage.setItem(COMPOSE_DRAFT_KEY, composeDraft); } catch { /* quota */ } }, 250);
}

function focusActiveInput() {
  if (composeOpen) composeInput.focus();
  else if (term) term.focus();
}
function autosizeCompose() {
  composeInput.style.height = 'auto';
  composeInput.style.height = Math.min(composeInput.scrollHeight, 220) + 'px';
}
function setComposeValue(v) {
  composeInput.value = v;
  composePrev = v;       // so the next user edit compares against this, not a stale value
  autosizeCompose();
}
function openCompose() {
  composeOpen = true;
  composeEl.hidden = false;
  $('compose-btn').classList.add('armed');
  composeNav = composeEntries.length;
  composeUndoVal = null;
  setComposeValue(composeDraft || '');
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

function onComposeInput() {
  const nv = composeInput.value;
  // A big one-event change (paste / mass delete) is snapshotted so Undo reverts it.
  if (Math.abs(nv.length - composePrev.length) >= COMPOSE_UNDO_THRESHOLD) composeUndoVal = composePrev;
  composePrev = nv;
  // Editing always lands on the live draft (the last history item).
  composeNav = composeEntries.length;
  composeDraft = nv;
  saveComposeDraft();
  autosizeCompose();
}
function composeUndo() {
  if (composeUndoVal === null) return;
  const cur = composeInput.value;
  setComposeValue(composeUndoVal);
  composeUndoVal = cur; // tap again to redo
  composeNav = composeEntries.length;
  composeDraft = composeInput.value;
  saveComposeDraft();
  composeInput.focus();
}
function composeHistStep(dir) { // -1 older, +1 newer
  const draftPos = composeEntries.length;
  composeNav = Math.max(0, Math.min(draftPos, composeNav + dir));
  composeUndoVal = null;
  setComposeValue(composeNav === draftPos ? composeDraft : composeEntries[composeNav]);
  composeInput.focus();
}
// Push the composed text to the terminal. withEnter also submits the line. Each
// send commits the draft as a new history item and starts a fresh draft.
function sendCompose(withEnter) {
  const text = composeInput.value;
  if (text) {
    ensureBottom(); noteInput(text); sendBytes(text);
    if (composeEntries[composeEntries.length - 1] !== text) composeEntries.push(text);
    if (composeEntries.length > COMPOSE_HISTORY_MAX) composeEntries = composeEntries.slice(-COMPOSE_HISTORY_MAX);
    saveComposeEntries();
  }
  if (withEnter) { ensureBottom(); sendBytes('\r'); lastInput = ''; }
  composeDraft = '';
  composeUndoVal = null;
  composeNav = composeEntries.length;
  setComposeValue('');
  saveComposeDraft();
  composeInput.focus(); // keep the keyboard up for the next line
}

$('compose-btn').addEventListener('click', toggleCompose);
$('compose-send').addEventListener('click', () => sendCompose(false));
$('compose-go').addEventListener('click', () => sendCompose(true));
$('compose-undo').addEventListener('click', composeUndo);
$('compose-prev').addEventListener('click', () => composeHistStep(-1));
$('compose-next').addEventListener('click', () => composeHistStep(1));
// Keep the keyboard up when tapping the action buttons (don't blur the textarea).
for (const id of ['compose-undo', 'compose-prev', 'compose-next', 'compose-send', 'compose-go']) {
  $(id).addEventListener('pointerdown', (e) => e.preventDefault());
}
composeInput.addEventListener('input', onComposeInput);
composeInput.addEventListener('keydown', (e) => {
  // Enter submits (send + Enter); Shift+Enter inserts a newline for multi-line.
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompose(true); }
});

// --- quick-reply snippets -------------------------------------------------
// A toggleable row of chips that each send their text + Enter — for answering
// coding agents (y / continue / approve …) without the keyboard. The list is
// stored server-side and synced across the whole tailnet, so editing it on one
// machine updates all of them; localStorage is just an offline cache.
const SNIP_KEY = 'ptw-snippets';
const SNIP_DEFAULT = ['y', 'n', 'continue', 'approve', '/clear', 'exit'];
let snippetsCache = null; // last list seen from the server (this PC)
function localSnippets() {
  try { const a = JSON.parse(localStorage.getItem(SNIP_KEY)); return Array.isArray(a) ? a : SNIP_DEFAULT; }
  catch { return SNIP_DEFAULT; }
}
function currentSnippets() { return snippetsCache || localSnippets(); }
// Pull the fleet-shared list from this machine's server, then re-render.
async function fetchSnippets() {
  try {
    const r = await fetch('/api/snippets', { cache: 'no-store' });
    if (r.ok) {
      const a = (await r.json()).snippets;
      if (Array.isArray(a)) { snippetsCache = a; try { localStorage.setItem(SNIP_KEY, JSON.stringify(a)); } catch { /* quota */ } }
    }
  } catch { /* offline: keep cache/local */ }
  renderSnippets();
}
// Save edits + push them to every webmux on the tailnet.
async function saveSnippetsToFleet(arr) {
  snippetsCache = arr;
  try { localStorage.setItem(SNIP_KEY, JSON.stringify(arr)); } catch { /* quota */ }
  renderSnippets();
  try { await fetch('/api/snippets?scope=all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snippets: arr }) }); }
  catch { /* offline: stays local until next save */ }
}
function sendSnippet(text) {
  ensureBottom();
  sendBytes(text + '\r');
  lastInput = '';
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* unsupported */ } }
  focusActiveInput();
}
function renderSnippets() {
  snippetsEl.innerHTML = '';
  for (const sn of currentSnippets()) {
    const b = document.createElement('button');
    b.className = 'snip';
    b.textContent = sn;
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus/keyboard
    b.addEventListener('click', () => sendSnippet(sn));
    snippetsEl.append(b);
  }
  const edit = document.createElement('button');
  edit.className = 'snip snip-config';
  edit.textContent = '✎';
  edit.title = 'Edit quick replies';
  edit.addEventListener('pointerdown', (e) => e.preventDefault());
  edit.addEventListener('click', openSnipEdit);
  snippetsEl.append(edit);
}
let snippetsOpen = false;
try { snippetsOpen = JSON.parse(localStorage.getItem('ptw-snippets-open') || 'false'); } catch { /* default off */ }
function applySnippetsVisibility() {
  snippetsEl.hidden = !snippetsOpen;
  $('snip-btn').classList.toggle('armed', snippetsOpen);
  scheduleFit();
}
function toggleSnippets() {
  snippetsOpen = !snippetsOpen;
  try { localStorage.setItem('ptw-snippets-open', JSON.stringify(snippetsOpen)); } catch { /* ignore */ }
  applySnippetsVisibility();
}
function openSnipEdit() {
  const initial = currentSnippets().join('\n');
  snipEditText.value = initial;
  snipEditEl.hidden = false;
  // Refresh from the fleet, but only re-fill if the user hasn't started editing.
  fetchSnippets().then(() => { if (!snipEditEl.hidden && snipEditText.value === initial) snipEditText.value = currentSnippets().join('\n'); });
}
function closeSnipEdit() { snipEditEl.hidden = true; }
$('snip-btn').addEventListener('click', toggleSnippets);
$('menu-snippets').addEventListener('click', () => { closeMenu(); if (!snippetsOpen) toggleSnippets(); openSnipEdit(); });
$('snip-edit-close').addEventListener('click', closeSnipEdit);
snipEditEl.addEventListener('click', (e) => { if (e.target === snipEditEl) closeSnipEdit(); });
$('snip-edit-save').addEventListener('click', () => {
  const arr = snipEditText.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 40);
  saveSnippetsToFleet(arr);
  closeSnipEdit();
});

$('paste')?.addEventListener('click', async () => {
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
function openMenu() { $('font-val').textContent = String(fontSize); updateNotifyLabel(); menuEl.hidden = false; }

// --- push notifications (activity alerts) ---------------------------------
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
async function notifyState() {
  if (!pushSupported()) return 'unsupported';
  try { const reg = await navigator.serviceWorker.ready; return (await reg.pushManager.getSubscription()) ? 'on' : 'off'; }
  catch { return 'off'; }
}
async function enableNotify() {
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return false;
  let keyRes;
  try { keyRes = await (await fetch('/api/push/key')).json(); } catch { return false; }
  if (!keyRes.enabled || !keyRes.key) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(keyRes.key) }));
  await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  return true;
}
async function disableNotify() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch { /* ignore */ }
  try { await sub.unsubscribe(); } catch { /* ignore */ }
}
async function updateNotifyLabel() {
  const st = await notifyState();
  const el = $('menu-notify');
  if (!el) return;
  el.textContent = st === 'on' ? '🔔 Notifications: on' : (st === 'unsupported' ? '🔔 Notifications: n/a' : '🔔 Notifications: off');
  el.classList.toggle('armed', st === 'on');
}
$('menu-notify').addEventListener('click', async () => {
  const st = await notifyState();
  if (st === 'unsupported') { $('menu-notify').textContent = '🔔 not supported here'; return; }
  $('menu-notify').textContent = '🔔 …';
  if (st === 'on') await disableNotify();
  else { const ok = await enableNotify(); if (ok) { try { await fetch('/api/push/test', { method: 'POST' }); } catch { /* ignore */ } } }
  updateNotifyLabel();
});
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
  // Show THIS PC's real version; the coordinator doesn't self-update, so if it's
  // behind the fleet target it needs its own update (the target is remote main HEAD).
  try {
    const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
    const selfVer = (h && h.version) || '';
    if (selfVer && target && selfVer !== target) {
      setRowState(self, 'updating', `on ${selfVer} → ${target}: update THIS PC separately (it stays up to coordinate)`);
    } else {
      self.subEl.textContent = 'version ' + (selfVer || target);
    }
  } catch { self.subEl.textContent = target ? 'version ' + target : ''; }

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
