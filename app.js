(() => {
'use strict';
const $ = s => document.querySelector(s);
const LS = { profiles: 'aicc.profiles', primary: 'aicc.primary', system: 'aicc.system' };

const PRESETS = {
  openai:     { label: 'OpenAI',      type: 'openai',    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic:  { label: 'Claude',      type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  gemini:     { label: 'Gemini',      type: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
  deepseek:   { label: 'DeepSeek',    type: 'openai',    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  groq:       { label: 'Groq',        type: 'openai',    baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { label: 'OpenRouter',  type: 'openai',    baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  together:   { label: 'Together AI', type: 'openai',    baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  mistral:    { label: 'Mistral',     type: 'openai',    baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  perplexity: { label: 'Perplexity',  type: 'openai',    baseUrl: 'https://api.perplexity.ai', model: 'sonar' },
  cohere:     { label: 'Cohere',      type: 'openai',    baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'command-r-plus' },
  custom:     { label: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: '', model: '' }
};

const state = { profiles: [], primary: null, history: [], files: [], busy: false, abort: null, chart: null, data: null, symbol: null };

/* ---------- helpers ---------- */
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } };
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raf = fn => requestAnimationFrame(fn);

/* ---------- markdown (minimal, safe) ---------- */
function md(src) {
  return src.split('```').map((s, i) => {
    if (i % 2) {
      const nl = s.indexOf('\n');
      const code = nl > -1 ? s.slice(nl + 1) : s;
      return `<div class="code"><button type="button" data-act="copy-code">Copy</button><pre><code>${esc(code)}</code></pre></div>`;
    }
    return esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }).join('');
}

/* ---------- vault ---------- */
function rowHTML(p) {
  const opts = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${k === p.vendor ? 'selected' : ''}>${v.label}</option>`).join('');
  return `<div class="vault-row" data-id="${p.id}">
    <select data-f="vendor" aria-label="Vendor">${opts}</select>
    <input data-f="name" placeholder="Label" value="${esc(p.name)}" aria-label="Label">
    <input data-f="defaultModel" placeholder="Model ID" value="${esc(p.defaultModel)}" aria-label="Model ID">
    <div class="keywrap"><input data-f="key" type="password" placeholder="API key" value="${esc(p.key)}" autocomplete="off" aria-label="API key"><button type="button" data-act="eye">Show</button></div>
    <input data-f="baseUrl" placeholder="Base URL (optional)" value="${esc(p.baseUrl)}" aria-label="Base URL">
    <label class="primary-opt"><input type="radio" name="primary" value="${p.id}" ${p.id === state.primary ? 'checked' : ''}> Primary</label>
    <button type="button" data-act="del">Delete</button>
  </div>`;
}
function renderVault() { $('#vaultList').innerHTML = state.profiles.map(rowHTML).join(''); }
function readVault() {
  const rows = [...document.querySelectorAll('.vault-row')];
  state.profiles = rows.map(r => {
    const g = f => r.querySelector(`[data-f="${f}"]`).value.trim();
    return { id: r.dataset.id, vendor: g('vendor'), name: g('name') || PRESETS[g('vendor')].label, key: g('key'), baseUrl: g('baseUrl'), defaultModel: g('defaultModel') };
  });
  const checked = document.querySelector('input[name="primary"]:checked');
  state.primary = checked ? checked.value : (state.profiles[0] || {}).id || null;
}
function persist() { save(LS.profiles, state.profiles); save(LS.primary, state.primary); renderModelSelect(); updateStatus(); }
function openVault() { renderVault(); raf(() => $('#vaultModal').classList.add('open')); }
function closeVault() { raf(() => $('#vaultModal').classList.remove('open')); }

$('#vaultModal').addEventListener('click', e => {
  if (e.target.id === 'vaultModal') return closeVault();
  const row = e.target.closest('.vault-row'); const act = e.target.dataset.act;
  if (act === 'eye') { const i = row.querySelector('[data-f="key"]'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Hide' : 'Show'; }
  if (act === 'del') { readVault(); state.profiles = state.profiles.filter(p => p.id !== row.dataset.id); if (state.primary === row.dataset.id) state.primary = (state.profiles[0] || {}).id || null; renderVault(); }
});
$('#vaultModal').addEventListener('change', e => {
  if (e.target.dataset.f !== 'vendor') return;
  const row = e.target.closest('.vault-row'), pre = PRESETS[e.target.value];
  row.querySelector('[data-f="defaultModel"]').value = pre.model;
  row.querySelector('[data-f="baseUrl"]').value = '';
  row.querySelector('[data-f="name"]').value = pre.label;
});
$('#addKey').onclick = () => { readVault(); const pre = PRESETS.openai; state.profiles.push({ id: uid(), vendor: 'openai', name: pre.label, key: '', baseUrl: '', defaultModel: pre.model }); if (!state.primary) state.primary = state.profiles[0].id; renderVault(); };
$('#saveVault').onclick = () => { readVault(); persist(); closeVault(); sysMsg('Credentials saved.'); };
$('#closeVault').onclick = closeVault;
$('#openVault').onclick = openVault;
$('#exportCfg').onclick = () => {
  readVault();
  const blob = new Blob([JSON.stringify({ profiles: state.profiles, primary: state.primary }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'ai-control-center-config.json' });
  a.click(); URL.revokeObjectURL(a.href);
};
$('#importCfg').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  try {
    const cfg = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(cfg.profiles)) throw new Error('bad file');
    state.profiles = cfg.profiles.map(p => ({ id: p.id || uid(), vendor: PRESETS[p.vendor] ? p.vendor : 'custom', name: p.name || '', key: p.key || '', baseUrl: p.baseUrl || '', defaultModel: p.defaultModel || '' }));
    state.primary = cfg.primary || (state.profiles[0] || {}).id; renderVault();
  } catch { sysMsg('Import failed: not a valid config file.'); }
  e.target.value = '';
};

function renderModelSelect() {
  const sel = $('#modelSelect');
  sel.innerHTML = state.profiles.length
    ? state.profiles.map(p => `<option value="${p.id}" ${p.id === state.primary ? 'selected' : ''}>${esc(p.name)} · ${esc(p.defaultModel || PRESETS[p.vendor].model)}</option>`).join('')
    : '<option>No keys yet</option>';
}
$('#modelSelect').onchange = e => { state.primary = e.target.value; save(LS.primary, state.primary); };
function updateStatus() {
  const n = state.profiles.filter(p => p.key).length, b = $('#statusBadge');
  b.textContent = n ? `Online · ${n} API${n > 1 ? 's' : ''} ready` : 'No API key';
  b.classList.toggle('ok', n > 0);
}

/* ---------- provider layer ---------- */
function normalizeBase(b) {
  b = (b || '').trim();
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;           // "api.deepseek.com" -> absolute URL
  return b.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/i, '').replace(/\/models\/[^/]*$/i, '');
}
async function streamFrom(p, msgs, system, onToken, signal) {
  const pre = PRESETS[p.vendor] || PRESETS.custom;
  const base = normalizeBase(p.baseUrl || pre.baseUrl);
  const model = p.defaultModel || pre.model;
  const headers = { 'Content-Type': 'application/json' };
  let url, body, extract;
  if (pre.type === 'gemini') {
    url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(p.key)}`;
    body = { contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    extract = j => (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  } else if (pre.type === 'anthropic') {
    url = `${base}/messages`;
    Object.assign(headers, { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    body = { model, max_tokens: 4096, stream: true, messages: msgs };
    if (system) body.system = system;
    extract = j => (j.type === 'content_block_delta' ? j.delta?.text || '' : '');
  } else {
    if (!base) throw new Error('Base URL is required for custom providers');
    url = `${base}/chat/completions`; headers.Authorization = `Bearer ${p.key}`;
    body = { model, stream: true, messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs };
    extract = j => j.choices?.[0]?.delta?.content || '';
  }
  const u = new URL(url, location.href);
  let r;
  try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error(`cannot reach ${u.host} (network, CORS, adblock or VPN)`); }
  if (!r.ok) {
    const t = await r.text().catch(() => ''); let msg = t;
    try { const j = JSON.parse(t); msg = j.error?.message || j.error || j.message || t; } catch { /* not JSON */ }
    msg = String(typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const e = new Error(`${r.status} from ${u.host}${u.pathname}: ${msg || 'empty response'}`); e.status = r.status; throw e;
  }
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      if (!ln.startsWith('data:')) continue;
      const d = ln.slice(5).trim(); if (!d || d === '[DONE]') continue;
      try { const t = extract(JSON.parse(d)); if (t) onToken(t); } catch { /* partial chunk */ }
    }
  }
}

/* unified entry point with automatic fallback */
async function callAIProvider(prompt, { history = [], system = '', onToken, onFallback, signal } = {}) {
  const usable = state.profiles.filter(p => p.key);
  const order = [...usable.filter(p => p.id === state.primary), ...usable.filter(p => p.id !== state.primary)];
  if (!order.length) throw new Error('No API key configured');
  const msgs = [...history, { role: 'user', content: prompt }];
  let lastErr;
  for (const p of order) {
    let emitted = false;
    try {
      await streamFrom(p, msgs, system, t => { emitted = true; onToken(t); }, signal);
      return p;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      if (emitted) throw e;                       // already streaming: do not mix providers
      onFallback && onFallback(p, e);
    }
  }
  throw lastErr;
}

/* ---------- chat ---------- */
function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role; el.innerHTML = md(text);
  $('#messages').appendChild(el); scrollDown(); return el;
}
const sysMsg = t => addMsg('sys', t);
const scrollDown = () => raf(() => { const m = $('#messages'); m.scrollTop = m.scrollHeight; });
function updateTokens() { const chars = state.history.reduce((n, m) => n + m.content.length, 0); $('#tokenCount').textContent = `~${Math.ceil(chars / 4)} tokens`; }
function setBusy(b) { state.busy = b; $('#sendBtn').hidden = b; $('#stopBtn').hidden = !b; }

async function send() {
  if (state.busy) return;
  const input = $('#prompt'), text = input.value.trim();
  if (!text && !state.files.length) return;
  if (!state.profiles.some(p => p.key)) return openVault();
  const attach = state.files.map(f => `\n\n[File: ${f.name}]\n${f.text}`).join('');
  const full = text + attach;
  addMsg('user', text + (state.files.length ? `\n(+${state.files.length} file${state.files.length > 1 ? 's' : ''})` : ''));
  input.value = ''; state.files = []; renderFiles();
  const ai = addMsg('ai', '…'); let out = '', pending = false;
  const t0 = performance.now(); let tFirst = 0;
  state.abort = new AbortController(); setBusy(true);
  try {
    const p = await callAIProvider(full, {
      history: state.history, system: $('#systemPrompt').value.trim(), signal: state.abort.signal,
      onToken: t => { if (!tFirst) tFirst = performance.now() - t0; out += t; if (!pending) { pending = true; raf(() => { ai.innerHTML = md(out); pending = false; scrollDown(); }); } },
      onFallback: (p, e) => sysMsg(`${p.name} failed (${e.message.slice(0, 80)}). Trying next key…`)
    });
    ai.innerHTML = md(out);
    state.history.push({ role: 'user', content: full }, { role: 'assistant', content: out });
    $('#latency').textContent = `${p.name} · first token ${Math.round(tFirst)} ms · total ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  } catch (e) {
    if (e.name === 'AbortError') { ai.innerHTML = md(out || 'Stopped.'); if (out) state.history.push({ role: 'user', content: full }, { role: 'assistant', content: out }); }
    else ai.innerHTML = md(`**Error:** ${e.message}`);
  } finally { setBusy(false); updateTokens(); }
}
$('#sendBtn').onclick = send;
$('#stopBtn').onclick = () => state.abort && state.abort.abort();
$('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#clearBtn').onclick = () => { state.history = []; $('#messages').innerHTML = ''; updateTokens(); $('#latency').textContent = '–'; };
$('#copyBtn').onclick = () => navigator.clipboard.writeText(state.history.map(m => `${m.role}: ${m.content}`).join('\n\n')).then(() => sysMsg('Chat copied.'));
$('#systemPrompt').value = load(LS.system, '');
$('#systemPrompt').addEventListener('input', e => save(LS.system, e.target.value));
$('#messages').addEventListener('click', e => {
  if (e.target.dataset.act !== 'copy-code') return;
  navigator.clipboard.writeText(e.target.parentElement.querySelector('code').textContent);
  e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

/* ---------- file dropzone ---------- */
function renderFiles() { $('#fileList').textContent = state.files.map(f => f.name).join(', '); }
async function addFiles(list) {
  for (const f of list) { if (f.size > 500000) { sysMsg(`${f.name} is over 500 KB and was skipped.`); continue; } state.files.push({ name: f.name, text: await f.text() }); }
  renderFiles();
}
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
$('#fileInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

/* ---------- data.json ---------- */
async function loadData() {
  try {
    const r = await fetch('./data.json?t=' + Date.now()); if (!r.ok) throw new Error(r.status);
    state.data = await r.json();
  } catch { $('#metrics').innerHTML = '<p class="mut">No data.json yet. Run the GitHub Action once.</p>'; return; }
  const d = state.data;
  $('#updatedAt').textContent = d.updated ? 'Updated ' + new Date(d.updated).toLocaleString() : '';
  $('#jsonView').textContent = JSON.stringify(d, null, 1).slice(0, 4000);
  state.symbol = state.symbol || d.markets?.[0]?.symbol;
  renderMetrics(); drawChart();
}
function renderMetrics() {
  $('#metrics').innerHTML = (state.data.markets || []).map(m => {
    const up = m.change_pct >= 0;
    return `<button class="metric ${m.symbol === state.symbol ? 'active' : ''}" data-sym="${esc(m.symbol)}"><span class="mut">${esc(m.name)}</span><b>${m.price ?? '–'}</b><span class="${up ? 'up' : 'down'}">${up ? '+' : ''}${m.change_pct ?? 0}%</span></button>`;
  }).join('');
}
$('#metrics').addEventListener('click', e => { const b = e.target.closest('.metric'); if (!b) return; state.symbol = b.dataset.sym; renderMetrics(); drawChart(); });
function drawChart() {
  const m = (state.data.markets || []).find(x => x.symbol === state.symbol);
  if (!m || typeof Chart === 'undefined') return;
  const cfg = { labels: m.history.map(h => h.d), data: m.history.map(h => h.c) };
  if (state.chart) state.chart.destroy();
  state.chart = new Chart($('#mainChart'), {
    type: 'line',
    data: { labels: cfg.labels, datasets: [{ label: m.name, data: cfg.data, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.12)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b8b95', maxTicksLimit: 6 }, grid: { display: false } }, y: { ticks: { color: '#8b8b95' }, grid: { color: 'rgba(255,255,255,.05)' } } } }
  });
}

/* ---------- init ---------- */
window.addEventListener('load', () => {
  state.profiles = load(LS.profiles, []); state.primary = load(LS.primary, null);
  renderModelSelect(); updateStatus(); loadData();
  if (!state.profiles.some(p => p.key)) { if (!state.profiles.length) state.profiles.push({ id: uid(), vendor: 'deepseek', name: 'DeepSeek', key: '', baseUrl: '', defaultModel: 'deepseek-chat' }); state.primary = state.primary || state.profiles[0].id; openVault(); }
});
})();
