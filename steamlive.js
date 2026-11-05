// Talks to the running Steam client through its local debug port (only open when Steam was started with
// -cef-enable-debugging, and bound to 127.0.0.1). This gives the same download data Steam's own page shows,
// and its own pause, resume and queue commands. All of it is undocumented, so every caller has a fallback.
const WebSocket = require('ws');

let port = 8080;
let socket = null;
let nextId = 0;
const waiting = new Map();

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to Steam'));
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Steam did not answer')); }, 5000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      const r = msg.result || {};
      if (r.exceptionDetails) reject(new Error(r.exceptionDetails.text || 'Steam command failed'));
      else resolve(r.result ? r.result.value : undefined);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

// Steam pushes updates to these callbacks; they are kept in the page so each poll is one small read
const HOOK = `(() => {
  if (window.__kinetic) return true;
  window.__kinetic = {};
  SteamClient.Downloads.RegisterForDownloadOverview((o) => { window.__kinetic.overview = o; });
  SteamClient.Downloads.RegisterForDownloadItems((_active, items) => { window.__kinetic.items = items; });
  return true;
})()`;

async function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return true;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
    const target = (await res.json()).find((t) => /SharedJSContext/.test(t.title));
    if (!target) return false;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('timed out')); }, 3000);
      ws.on('open', () => { clearTimeout(timer); socket = ws; resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => { if (socket === ws) socket = null; });
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        const done = waiting.get(msg.id);
        if (done) { waiting.delete(msg.id); done(msg); }
      });
    });
    await evaluate(HOOK);
    return true;
  } catch {
    if (socket) { socket.terminate(); socket = null; }
    return false;
  }
}

function snapshot() {
  return evaluate('JSON.stringify(window.__kinetic || {})').then((s) => JSON.parse(s || '{}'));
}

const ACTIONS = { queue: 'QueueAppUpdate', pause: 'PauseAppUpdate', resume: 'ResumeAppUpdate', remove: 'RemoveFromDownloadList' };
function command(action, appid) {
  const id = Number(appid);
  if (!ACTIONS[action] || !Number.isInteger(id)) return Promise.reject(new Error('Unknown Steam command'));
  return evaluate(`SteamClient.Downloads.${ACTIONS[action]}(${id}); true`);
}

// The stages have no names, so they are told apart by size: the manifest gives the total for each
function readOverview(o, appid, downloadTotal, stageTotal) {
  if (!o || Number(o.update_appid) !== Number(appid)) return null;
  const stages = (o.progress || []).filter((p) => Number(p.bytes_total) > 0);
  const find = (total) => stages.find((p) => Number(p.bytes_total) === total);
  const download = find(downloadTotal) || stages[0] || null;
  const files = find(stageTotal) || stages.find((p) => p !== download) || null;
  const pick = (p) => (p ? { got: Number(p.bytes_in_progress) || 0, total: Number(p.bytes_total) || 0 } : null);
  return {
    state: String(o.update_state || ''), paused: !!o.paused,
    network: Number(o.update_network_bytes_per_second) || 0, peak: Number(o.update_peak_network_bytes_per_second) || 0,
    disk: Number(o.update_disc_bytes_per_second) || 0, eta: Number(o.overall_estimated_time_remaining_sec),
    percent: Math.floor(Number(o.overall_percent_complete) || 0), download: pick(download), files: pick(files),
  };
}

const queuedIds = (items) => (items || []).flatMap((c) => c.item_data || []).map((i) => String(i.appid)).filter((id) => /^\d+$/.test(id));

module.exports = { connect, snapshot, command, readOverview, queuedIds, setPort: (p) => { port = p; } };
