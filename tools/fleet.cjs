#!/usr/bin/env node
// fleet — see and operate the webmux fleet. Runs two ways from one file:
//   • CLI:  fleet list | run <node> <cmd…> | sessions [node] | wake <node> | ask <node> <prompt…>
//   • MCP:  no args → stdio JSON-RPC server exposing the same as tools for Claude/Codex.
// It talks only to the LOCAL webmux API, which already discovers + proxies to tailnet
// peers. Phone tap/type/screenshot stays loopback-only (not exposed here) by design.
const http = require('http');
const API = process.env.WEBMUX_API || 'http://127.0.0.1:8083';

function api(path, method = 'GET', body) {
  return new Promise((resolve) => {
    const u = new URL(API + path);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: 30000,
    }, (s) => {
      const ch = []; s.on('data', (c) => ch.push(c));
      s.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString()); } catch { /* non-json */ } resolve({ status: s.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); });
    if (data) r.write(data); r.end();
  });
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function tailnet() { return (await api('/api/tailnet')).json || { enabled: false, peers: [] }; }

async function resolveNode(name) {
  const t = await tailnet();
  const n = String(name || '').toLowerCase();
  const self = t.self || {};
  const selfShort = String(self.dns || '').split('.')[0].toLowerCase();
  if (!n || n === 'self' || n === 'local' || n === 'here' || (selfShort && selfShort === n)) {
    return { self: true, name: selfShort || 'self' };
  }
  for (const p of (t.peers || [])) {
    const full = String(p.dns || '').toLowerCase();
    const short = full.split('.')[0];
    const nm = String(p.name || '').toLowerCase();
    if (n === nm || n === short || n === full || n === String(p.ip || '').toLowerCase()) {
      return { self: false, dns: p.dns || '', ip: p.ip || '', name: p.name || short, asleep: !!p.asleep, wakeable: !!p.wakeable };
    }
  }
  return null;
}

async function listNodes() {
  const t = await tailnet();
  if (!t.enabled) return { fleet: 'tailnet discovery off on this node', nodes: [] };
  const nodes = [];
  if (t.self) nodes.push({ name: String(t.self.dns || '').split('.')[0] || 'self', url: t.self.url || '', you_are_here: true });
  for (const p of (t.peers || [])) {
    nodes.push({ name: p.name || (p.dns || '').split('.')[0], url: p.url || '', ip: p.ip || '', dns: p.dns || '',
      ...(p.asleep ? { asleep: true } : {}), ...(p.wakeable ? { wakeable: true } : {}) });
  }
  return { nodes };
}

async function runOn(name, cmd) {
  if (!cmd || !String(cmd).trim()) return { error: 'no command' };
  const node = await resolveNode(name);
  if (!node) return { error: `unknown node "${name}" — see fleet_list` };
  if (node.self) {
    const r = await api('/api/broadcast?scope=self', 'POST', { cmd });
    return (r.json && r.json.results && r.json.results[0]) || { error: 'no result' };
  }
  if (node.asleep) return { error: `${node.name} is asleep — wake it first (fleet_wake)` };
  const r = await api(`/api/peer/broadcast?dns=${encodeURIComponent(node.dns)}&ip=${encodeURIComponent(node.ip)}`, 'POST', { cmd });
  if (r.status === 404) return { error: `${node.name} not reachable right now` };
  return (r.json && r.json.result) || { error: 'no result' };
}

async function sessionsOn(name) {
  const node = await resolveNode(name);
  if (!node) return { error: `unknown node "${name}"` };
  if (node.self) return (await api('/api/sessions')).json || { sessions: [] };
  if (node.asleep) return { error: `${node.name} is asleep (fleet_wake first)` };
  return (await api(`/api/peer/sessions?dns=${encodeURIComponent(node.dns)}&ip=${encodeURIComponent(node.ip)}`)).json || { sessions: [] };
}

async function wake(name) {
  const r = await api(`/api/wake?name=${encodeURIComponent(name)}`, 'POST');
  return r.json || { error: 'wake failed (no endpoint known?)' };
}

// Relay a prompt into a node's interactive `claude` tmux session and read the reply.
// Best-effort: types the prompt, waits, captures the pane.
async function ask(name, prompt, waitMs = 9000) {
  const send = `tmux send-keys -t claude -l -- ${shq(prompt)} && tmux send-keys -t claude Enter`;
  const r1 = await runOn(name, send);
  if (r1.error) return r1;
  if (r1.ok === false) return { error: `couldn't reach a 'claude' session on ${name}: ${r1.output || ''}`.trim() };
  await new Promise((s) => setTimeout(s, waitMs));
  const cap = await runOn(name, 'tmux capture-pane -t claude -p -S -60');
  return { node: name, sent: prompt, reply: cap.output != null ? cap.output : (cap.error || '(no capture)') };
}

// ---- CLI ------------------------------------------------------------------
async function cli(argv) {
  const [c, ...rest] = argv;
  const pr = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  if (c === 'list') pr(await listNodes());
  else if (c === 'run') { const r = await runOn(rest[0], rest.slice(1).join(' ')); pr(r.output ?? r); }
  else if (c === 'sessions') pr((await sessionsOn(rest[0] || 'self')).sessions || []);
  else if (c === 'wake') pr(await wake(rest[0]));
  else if (c === 'ask') pr((await ask(rest[0], rest.slice(1).join(' '))).reply || '');
  else pr('usage: fleet {list | run <node> <cmd…> | sessions [node] | wake <node> | ask <node> <prompt…>}');
}

// ---- MCP (stdio JSON-RPC) -------------------------------------------------
const T = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const TOOLS = [
  { name: 'fleet_list', description: 'List webmux nodes on the tailnet (name, url, whether asleep/wakeable). The node marked you_are_here is the one you run on.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fleet_run', description: 'Run a shell command on a fleet node and get its combined output. node "self" = this box; otherwise a name from fleet_list. ~20s/8KB cap.', inputSchema: { type: 'object', properties: { node: { type: 'string' }, cmd: { type: 'string' } }, required: ['node', 'cmd'] } },
  { name: 'fleet_sessions', description: 'List tmux sessions on a node (default this box).', inputSchema: { type: 'object', properties: { node: { type: 'string' } } } },
  { name: 'fleet_wake', description: 'Wake a sleeping phone node so it becomes reachable.', inputSchema: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] } },
  { name: 'fleet_ask', description: "Relay a prompt into another node's interactive `claude` session and read the reply (Claude-to-Claude across the fleet). Best-effort capture after a short wait.", inputSchema: { type: 'object', properties: { node: { type: 'string' }, prompt: { type: 'string' } }, required: ['node', 'prompt'] } },
];
async function runTool(name, a = {}) {
  if (name === 'fleet_list') return T(await listNodes());
  if (name === 'fleet_run') return T(await runOn(a.node, a.cmd));
  if (name === 'fleet_sessions') return T(await sessionsOn(a.node || 'self'));
  if (name === 'fleet_wake') return T(await wake(a.node));
  if (name === 'fleet_ask') return T(await ask(a.node, a.prompt));
  return T('unknown tool ' + name);
}
function mcp() {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const { id, method, params } = m;
      if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fleet', version: '1.0.0' } } });
      else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      else if (method === 'tools/call') { try { send({ jsonrpc: '2.0', id, result: await runTool(params.name, params.arguments) }); } catch (e) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true } }); } }
      else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
    }
  });
}

if (process.argv.length > 2) cli(process.argv.slice(2)).then(() => process.exit(0));
else mcp();
