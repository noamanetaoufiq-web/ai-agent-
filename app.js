(() => {
'use strict';
const $ = s => document.querySelector(s);
const LS = { profiles: 'aicc.profiles', primary: 'aicc.primary', system: 'aicc.system' };

const PRESETS = {
  openai:     { label: 'OpenAI',      type: 'openai',    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic:  { label: 'Claude',      type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  gemini:     { label: 'Gemini',      type: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-latest' },
  deepseek:   { label: 'DeepSeek',    type: 'openai',    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  groq:       { label: 'Groq',        type: 'openai',    baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { label: 'OpenRouter',  type: 'openai',    baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
  together:   { label: 'Together AI', type: 'openai',    baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  mistral:    { label: 'Mistral',     type: 'openai',    baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  perplexity: { label: 'Perplexity',  type: 'openai',    baseUrl: 'https://api.perplexity.ai', model: 'sonar' },
  cohere:     { label: 'Cohere',      type: 'openai',    baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'command-r-plus' },
  custom:     { label: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: '', model: '' }
};

const TAGS = { gemini: 'free tier', groq: 'free tier', openrouter: 'free models', mistral: 'free tier', cohere: 'trial key', deepseek: 'paid', openai: 'paid', anthropic: 'paid', perplexity: 'paid', together: 'paid' };
/* starting suggestions only: names change often, so "Check key" in the vault lists what your key really supports */
const MODELS = {
  gemini: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  openrouter: ['openrouter/free', 'meta-llama/llama-3.3-70b-instruct:free'],
  mistral: ['mistral-small-latest', 'open-mistral-nemo', 'mistral-large-latest'],
  cohere: ['command-r', 'command-r-plus'], deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini'], anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
  perplexity: ['sonar', 'sonar-pro'], together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo']
};
const modelOpts = v => (MODELS[v] || []).map(m => `<option value="${esc(m)}">`).join('');

const state = { chats: [], chatId: null, view: [], profiles: [], primary: null, history: [], files: [], busy: false, abort: null, chart: null, data: null, symbol: null };

/* ---------- helpers ---------- */
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } };
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raf = fn => requestAnimationFrame(fn);

/* ---------- markdown (minimal, safe) ---------- */
function md(src) {
  return String(src ?? '').split('```').map((s, i) => {
    if (i % 2) {
      const nl = s.indexOf('\n');
      const code = nl > -1 ? s.slice(nl + 1) : s;
      return `<div class="code"><button type="button" data-act="copy-code">Copy</button><pre><code>${esc(code)}</code></pre></div>`;
    }
    const codes = [];   // inline code is lifted out as RAW text, escaped once when put back
    const t = s.replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, c) => '\u0000' + (codes.push(c) - 1) + '\u0000');
    return esc(t)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
      .replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
  }).join('');
}

/* ---------- vault ---------- */
function rowHTML(p) {
  const opts = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${k === p.vendor ? 'selected' : ''}>${v.label}${TAGS[k] ? ' · ' + TAGS[k] : ''}</option>`).join('');
  return `<div class="vault-row" data-id="${p.id}">
    <select data-f="vendor" aria-label="Vendor">${opts}</select>
    <input data-f="name" placeholder="Label" value="${esc(p.name)}" aria-label="Label">
    <input data-f="defaultModel" list="dl-${p.id}" placeholder="Model ID" value="${esc(p.defaultModel)}" aria-label="Model ID" autocomplete="off"><datalist id="dl-${p.id}">${modelOpts(p.vendor)}</datalist>
    <div class="keywrap"><input data-f="key" type="password" placeholder="API key" value="${esc(p.key)}" autocomplete="off" aria-label="API key"><button type="button" data-act="eye">Show</button></div>
    <input data-f="baseUrl" placeholder="Base URL (optional)" value="${esc(p.baseUrl)}" aria-label="Base URL">
    <label class="primary-opt"><input type="radio" name="primary" value="${p.id}" ${p.id === state.primary ? 'checked' : ''}> Primary</label>
    <button type="button" data-act="test">Check key</button>
    <button type="button" data-act="del">Delete</button>
    <div class="vstat" role="status"></div>
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
  if (act === 'test') return testKey(row);
  if (act === 'pick') { row.querySelector('[data-f="defaultModel"]').value = e.target.dataset.model; row.querySelector('.vstat').textContent = 'Model set. Press "Save credentials".'; return; }
  if (act === 'del') { readVault(); state.profiles = state.profiles.filter(p => p.id !== row.dataset.id); if (state.primary === row.dataset.id) state.primary = (state.profiles[0] || {}).id || null; renderVault(); }
});
$('#vaultModal').addEventListener('change', e => {
  if (e.target.dataset.f !== 'vendor') return;
  const row = e.target.closest('.vault-row'), pre = PRESETS[e.target.value];
  row.querySelector('[data-f="defaultModel"]').value = pre.model;
  row.querySelector('[data-f="baseUrl"]').value = '';
  row.querySelector('[data-f="name"]').value = pre.label;
  row.querySelector('datalist').innerHTML = modelOpts(e.target.value); row.querySelector('.vstat').textContent = '';
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

async function httpError(r, u) {
  const t = await r.text().catch(() => ''); let msg = t;
  try { const j = JSON.parse(t); msg = j.error?.message || j.error || j.message || t; } catch { /* not JSON */ }
  msg = String(typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const hint = r.status === 429 ? ' (free-tier rate limit: wait a minute or add another key)'
    : r.status === 401 || r.status === 403 ? ' (check the API key)'
    : r.status === 404 || (r.status === 400 && /model/i.test(msg)) ? ' (wrong model? API Vault > Check key lists the valid ones)' : '';
  const e = new Error(`${r.status} from ${u.host}${u.pathname}: ${msg || 'empty response'}${hint}`); e.status = r.status; return e;
}
async function listModels(p) {
  const pre = PRESETS[p.vendor] || PRESETS.custom, base = normalizeBase(p.baseUrl || pre.baseUrl), headers = {};
  if (!base) throw new Error('Base URL is required');
  let url;
  if (pre.type === 'gemini') url = `${base}/models?pageSize=200&key=${encodeURIComponent(p.key)}`;
  else if (pre.type === 'anthropic') { url = `${base}/models?limit=100`; Object.assign(headers, { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }); }
  else { url = `${base}/models`; headers.Authorization = `Bearer ${p.key}`; }
  const u = new URL(url); let r;
  try { r = await fetch(url, { headers }); } catch { throw new Error(`cannot reach ${u.host} (network, CORS, adblock or VPN)`); }
  if (!r.ok) throw await httpError(r, u);
  const j = await r.json();
  let ids = pre.type === 'gemini'
    ? (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''))
    : (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
  ids = [...new Set(ids)].sort();
  return p.vendor === 'openrouter' ? ids.sort((a, b) => (b.endsWith(':free') - a.endsWith(':free')) || a.localeCompare(b)) : ids;
}
const bestPick = (v, ids) => (MODELS[v] || []).find(m => ids.includes(m)) || ids.find(m => /flash.*latest/.test(m)) || ids.find(m => /free/.test(m)) || ids[0];
async function testKey(row) {
  const g = f => row.querySelector(`[data-f="${f}"]`), st = row.querySelector('.vstat');
  const p = { vendor: g('vendor').value, key: g('key').value.trim(), baseUrl: g('baseUrl').value.trim(), defaultModel: g('defaultModel').value.trim() };
  if (!p.key) { st.textContent = 'Paste the API key first.'; return; }
  st.textContent = 'Checking…';
  try {
    const ids = await listModels(p);
    row.querySelector('datalist').innerHTML = ids.map(m => `<option value="${esc(m)}">`).join('');
    if (!ids.length) st.textContent = 'Key accepted, but the provider returned no model list.';
    else if (ids.includes(p.defaultModel)) st.textContent = `✓ Key works · ${ids.length} models · "${p.defaultModel}" is available.`;
    else { const b = bestPick(p.vendor, ids); st.innerHTML = `✓ Key works · ${ids.length} models · but "${esc(p.defaultModel)}" is not available for it. Use: <button type="button" class="pick" data-act="pick" data-model="${esc(b)}">${esc(b)}</button>`; }
  } catch (e) { st.textContent = (e.status === 404 ? 'This provider has no model list; pick one from the suggestions. ' : '✗ ') + e.message; }
}

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
function supports(p, media) {
  if (!media.length) return true;
  const t = (PRESETS[p.vendor] || PRESETS.custom).type;
  if (t === 'gemini') return true;
  if (['deepseek', 'perplexity', 'cohere'].includes(p.vendor)) return false;
  if (t === 'anthropic') return media.every(m => m.mime.startsWith('image/') || m.mime === 'application/pdf');
  return media.every(m => m.mime.startsWith('image/'));
}
async function streamFrom(p, msgs, system, onToken, signal, search) {
  const pre = PRESETS[p.vendor] || PRESETS.custom;
  const base = normalizeBase(p.baseUrl || pre.baseUrl);
  const model = p.defaultModel || pre.model;
  const headers = { 'Content-Type': 'application/json' };
  let url, body, extract;
  if (pre.type === 'gemini') {
    url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(p.key)}`;
    body = { contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [...(m.media || []).map(x => ({ inlineData: { mimeType: x.mime, data: x.b64 } })), { text: m.content }] })) };
    if (search) body.tools = [{ google_search: {} }];
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    extract = j => (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  } else if (pre.type === 'anthropic') {
    url = `${base}/messages`;
    Object.assign(headers, { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    body = { model, max_tokens: 4096, stream: true, messages: msgs.map(m => m.media?.length ? { role: m.role, content: [...m.media.map(x => ({ type: x.mime === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: x.mime, data: x.b64 } })), { type: 'text', text: m.content }] } : { role: m.role, content: m.content }) };
    if (system) body.system = system;
    extract = j => (j.type === 'content_block_delta' ? j.delta?.text || '' : '');
  } else {
    if (!base) throw new Error('Base URL is required for custom providers');
    url = `${base}/chat/completions`; headers.Authorization = `Bearer ${p.key}`;
    const om = msgs.map(m => m.media?.length ? { role: m.role, content: [...m.media.map(x => ({ type: 'image_url', image_url: { url: `data:${x.mime};base64,${x.b64}` } })), { type: 'text', text: m.content }] } : { role: m.role, content: m.content });
    body = { model, stream: true, messages: system ? [{ role: 'system', content: system }, ...om] : om };
    extract = j => j.choices?.[0]?.delta?.content || '';
  }
  const u = new URL(url, location.href);
  let r;
  try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error(`cannot reach ${u.host} (network, CORS, adblock or VPN)`); }
  if (!r.ok) throw await httpError(r, u);
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

const FIRST_TOKEN_MS = 30000, IDLE_MS = 60000;
/* unified entry point with automatic fallback */
async function callAIProvider(prompt, { history = [], media = [], search = false, system = '', onToken, onFallback, signal } = {}) {
  const usable = state.profiles.filter(p => p.key);
  const order = [...usable.filter(p => p.id === state.primary), ...usable.filter(p => p.id !== state.primary)];
  if (!order.length) throw new Error('No API key configured');
  const capable = order.filter(p => supports(p, media));
  if (!capable.length) throw new Error('Video, audio and PDF need a Gemini key. Images also work with OpenAI, Claude, Groq, OpenRouter, Together or Mistral.');
  const msgs = [...history, { role: 'user', content: prompt, media }];
  let lastErr;
  for (const p of capable) {
    let emitted = false, timedOut = false, timer;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms); };
    arm(FIRST_TOKEN_MS);
    try {
      await streamFrom(p, msgs, system, t => { emitted = true; arm(IDLE_MS); onToken(t); }, ctl.signal, search);
      return p;
    } catch (e) {
      if (timedOut) e = new Error(emitted ? `${p.name} stalled for ${IDLE_MS / 1000} s` : `${p.name} gave no answer within ${FIRST_TOKEN_MS / 1000} s`);
      else if (e.name === 'AbortError') throw e;
      lastErr = e;
      if (emitted) throw e;                       // already streaming: do not mix providers
      onFallback && onFallback(p, e);
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
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
  const textFiles = state.files.filter(f => f.kind === 'text'), media = state.files.filter(f => f.kind === 'media');
  const full = (text || 'Describe the attached file(s).') + textFiles.map(f => `\n\n[File: ${f.name}]\n${f.text}`).join('');
  const note = media.length ? `\n[attached: ${media.map(m => m.name).join(', ')}]` : '';
  ensureChat(text || (media[0] && media[0].name) || 'New chat');
  const shown = text + (textFiles.length ? `\n(+${textFiles.length} text file${textFiles.length > 1 ? 's' : ''})` : '');
  const userEl = addMsg('user', shown);
  state.view.push({ role: 'user', text: shown + note });
  media.forEach(m => userEl.appendChild(mediaEl(m)));
  input.value = ''; input.style.height = 'auto'; state.files = []; renderFiles();
  const aiView = { role: 'ai', text: '' }; state.view.push(aiView); saveCurrent();   // the question is on disk before the request starts
  let system = $('#systemPrompt').value.trim();
  if ($('#accData').checked && state.data) {
    await Promise.race([refreshLive(true), new Promise(r => setTimeout(r, 8000))]);   // fresh prices + order flow at the moment you send
    system += '\n\nLive market data:\n' + dataDigest();
  }
  const ai = addMsg('ai', '…'); let out = '', pending = false, finalText = '';
  const t0 = performance.now(); let tFirst = 0;
  state.abort = new AbortController(); setBusy(true);
  const tick = setInterval(() => { if (!out) ai.textContent = `Waiting for a reply… ${Math.round((performance.now() - t0) / 1000)} s`; }, 1000);
  try {
    const p = await callAIProvider(full, {
      history: state.history, media, system, search: $('#accSearch').checked, signal: state.abort.signal,
      onToken: t => { if (!tFirst) tFirst = performance.now() - t0; out += t; aiView.text = out; saveSoon(); if (!pending) { pending = true; raf(() => { ai.innerHTML = md(out); pending = false; scrollDown(); }); } },
      onFallback: (p, e) => sysMsg(`${p.name} failed (${e.message.slice(0, 80)}). Trying next key…`)
    });
    ai.innerHTML = md(out); finalText = out;
    state.history.push({ role: 'user', content: full + note }, { role: 'assistant', content: out });
    $('#latency').textContent = `${p.name} · first token ${Math.round(tFirst)} ms · total ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  } catch (e) {
    if (e.name === 'AbortError') { finalText = out || 'Stopped.'; ai.innerHTML = md(finalText); if (out) state.history.push({ role: 'user', content: full + note }, { role: 'assistant', content: out }); }
    else { finalText = `**Error:** ${e.message}`; ai.innerHTML = md(finalText); }
  } finally { clearInterval(tick); setBusy(false); updateTokens(); aiView.text = finalText; clearTimeout(saveTimer); saveTimer = 0; saveCurrent(); }
}
$('#sendBtn').onclick = send;
$('#prompt').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; });
$('#stopBtn').onclick = () => state.abort && state.abort.abort();
$('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#clearBtn').onclick = () => { if (state.busy) return; state.history = []; state.view = []; $('#messages').innerHTML = ''; updateTokens(); $('#latency').textContent = '–'; saveCurrent(); };
$('#copyBtn').onclick = () => navigator.clipboard.writeText(state.history.map(m => `${m.role}: ${m.content}`).join('\n\n')).then(() => sysMsg('Chat copied.'));
$('#systemPrompt').value = load(LS.system, '');
$('#systemPrompt').addEventListener('input', e => save(LS.system, e.target.value));
$('#messages').addEventListener('click', e => {
  if (e.target.dataset.act !== 'copy-code') return;
  navigator.clipboard.writeText(e.target.parentElement.querySelector('code').textContent);
  e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

/* ---------- attachments ---------- */
const TEXT_RE = /\.(txt|md|csv|json|py|js|ts|html|css|xml|ya?ml|log)$/i;
const MEDIA_LIMIT = 14 * 1024 * 1024;   // inline request limit is ~20 MB after base64
const toB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
function renderFiles() { $('#fileList').innerHTML = state.files.map((f, i) => `<span class="chip">${esc(f.name)} <button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join(''); }
async function addFiles(list) {
  for (const f of list) {
    if (/^(image|video|audio)\//.test(f.type) || f.type === 'application/pdf') {
      const used = state.files.filter(x => x.kind === 'media').reduce((n, x) => n + x.size, 0);
      if (used + f.size > MEDIA_LIMIT) { sysMsg(`${f.name} skipped: attachments are limited to 14 MB in total.`); continue; }
      state.files.push({ kind: 'media', name: f.name || 'pasted-file', mime: f.type, size: f.size, b64: await toB64(f), url: URL.createObjectURL(f) });
    } else if (f.type.startsWith('text/') || TEXT_RE.test(f.name)) {
      if (f.size > 500000) { sysMsg(`${f.name} is over 500 KB and was skipped.`); continue; }
      state.files.push({ kind: 'text', name: f.name, size: f.size, text: await f.text() });
    } else sysMsg(`${f.name}: unsupported file type.`);
  }
  renderFiles();
}
function mediaEl(m) {
  const tag = m.mime.startsWith('image/') ? 'img' : m.mime.startsWith('video/') ? 'video' : m.mime.startsWith('audio/') ? 'audio' : 'a';
  const el = document.createElement(tag);
  if (tag === 'a') Object.assign(el, { textContent: m.name, href: m.url, target: '_blank' });
  else { el.src = m.url; if (tag !== 'img') el.controls = true; else el.alt = m.name; el.addEventListener('load', scrollDown); }
  return el;
}
$('#fileList').addEventListener('click', e => { const i = e.target.dataset.rm; if (i === undefined) return; state.files.splice(+i, 1); renderFiles(); });
$('#prompt').addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });

/* ---------- access toggles ---------- */
const acc = load('aicc.access', { data: false, search: false });
$('#accData').checked = !!acc.data; $('#accSearch').checked = !!acc.search;
$('#accessWrap').addEventListener('change', () => save('aicc.access', { data: $('#accData').checked, search: $('#accSearch').checked }));
const dataDigest = () => JSON.stringify({ meta: { now: new Date().toISOString(), data_json_updated: state.data.updated || null, browser_refresh: state.liveAt ? new Date(state.liveAt).toISOString() : null, backtest_generated: state.bt ? state.bt.generated : 'MISSING' }, markets: (state.data.markets || []).map(m => ({ name: m.name, symbol: m.symbol, price: m.price, change_pct: m.change_pct, last7: m.history.slice(-7).map(h => h.c), ind: m.indicators || undefined, of: m.orderflow || undefined })) });

const dz = $('#chatPanel');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
$('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#attachBtn').onclick = () => $('#fileInput').click();

/* ---------- data.json ---------- */
const num = v => { v = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(v) ? v : null; };
function normalize(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.markets)) throw new Error('data.json has no "markets" array');
  d.markets = d.markets.filter(m => m && m.symbol).map(m => {
    const h = (Array.isArray(m.history) ? m.history : []).map(x => typeof x === 'number' ? { d: '', c: x } : { d: String(x?.d ?? x?.date ?? ''), c: num(x?.c ?? x?.close) }).filter(x => x.c !== null);
    return { ...m, name: m.name || m.symbol, price: num(m.price) ?? (h.length ? h[h.length - 1].c : null), change_pct: num(m.change_pct) ?? 0, history: h };
  });
  return d;
}
async function loadData() {
  const box = $('#metrics'), tk = $('#tickerTrack');
  const fail = why => {
    box.innerHTML = `<p class="mut">No market data (${esc(why)}). Run the "Update data" GitHub Action once, then <button type="button" class="linkbtn" data-act="retry-data">retry</button>.</p>`;
    tk.classList.remove('live'); tk.innerHTML = '<span class="tk-empty">Market data unavailable</span>';
  };
  try {
    if (location.protocol === 'file:') throw new Error('page opened from file://, use GitHub Pages or a local web server');
    let r; try { r = await fetch('./data.json?t=' + Date.now(), { cache: 'no-store' }); } catch { throw new Error('network error while loading data.json'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 404 ? ', data.json not found' : ''}`);
    let j; try { j = await r.json(); } catch { throw new Error('data.json is not valid JSON'); }
    state.data = normalize(j);
  } catch (e) { state.data = null; return fail(e.message); }
  const d = state.data;
  $('#updatedAt').textContent = d.updated ? 'Updated ' + new Date(d.updated).toLocaleString() : '';
  if (!d.markets.length) { box.innerHTML = '<p class="mut">data.json has no markets yet. Run the "Update data" GitHub Action.</p>'; tk.classList.remove('live'); tk.innerHTML = '<span class="tk-empty">No market data yet</span>'; return; }
  try { $('#jsonView').textContent = JSON.stringify(d, null, 1).slice(0, 4000); } catch (e) { console.error(e); }
  if (!d.markets.some(m => m.symbol === state.symbol)) state.symbol = d.markets[0].symbol;
  [renderMetrics, renderTicker, drawChart].forEach(fn => { try { fn(); } catch (e) { console.error(fn.name, e); } });
  await loadBacktest();
  startLive();
}
function renderTicker() {
  const ms = state.data.markets, track = $('#tickerTrack');
  const item = m => { const up = m.change_pct >= 0; return `<span class="tk"><span class="nm">${esc(m.name)}</span><b>${m.price ?? '–'}</b><span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(m.change_pct ?? 0)}%</span></span>`; };
  const html = ms.map(item).join('');
  track.innerHTML = html + html + html + html;
  track.style.setProperty('--dur', ms.length * 7 + 's'); track.classList.add('live');
}
function renderMetrics() {
  $('#metrics').innerHTML = (state.data.markets || []).map(m => {
    const up = m.change_pct >= 0;
    return `<button class="metric ${m.symbol === state.symbol ? 'active' : ''}" data-sym="${esc(m.symbol)}"><span class="mut">${esc(m.name)}</span><b>${m.price ?? '–'}</b><span class="${up ? 'up' : 'down'}">${up ? '+' : ''}${m.change_pct ?? 0}%</span></button>`;
  }).join('');
}
$('#metrics').addEventListener('click', e => { if (e.target.dataset.act === 'retry-data') return loadData(); const b = e.target.closest('.metric'); if (!b) return; state.symbol = b.dataset.sym; renderMetrics(); drawChart(); });
function drawChart() {
  const msg = $('#chartMsg'), cv = $('#mainChart');
  const m = (state.data?.markets || []).find(x => x.symbol === state.symbol);
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  const show = t => { msg.textContent = t; msg.hidden = !t; cv.style.visibility = t ? 'hidden' : 'visible'; };
  if (!m) return show('Select a market.');
  if (m.history.length < 2) return show(`No history for ${m.name} yet. Run the "Update data" GitHub Action again.`);
  if (typeof Chart === 'undefined') return show(`Chart.js did not load (adblock or offline). Last close: ${m.history[m.history.length - 1].c}`);
  show('');
  state.chart = new Chart(cv, {
    type: 'line',
    data: { labels: m.history.map(h => h.d), datasets: [{ label: m.name, data: m.history.map(h => h.c), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.12)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b8b95', maxTicksLimit: 6 }, grid: { display: false } }, y: { ticks: { color: '#8b8b95' }, grid: { color: 'rgba(255,255,255,.05)' } } } }
  });
}

/* ---------- live prices + order flow: recomputed in the browser every 60 s and right before every message ---------- */
const LIVE_MS = 60000; let liveTimer = 0, livePromise = null;
const SIGDIR = { 'Pulse BUY breakout': 1, 'Pulse SELL breakout': -1, 'Trapped sellers': 1, 'Trapped buyers': -1, 'CVD bullish divergence': 1, 'CVD bearish divergence': -1 };
const YF = s => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}`;
const PROXY = u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u);   // public CORS proxy, fallback only
async function getJSON(urls) {
  for (const u of urls) { try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* try next route */ } }
  return null;
}
async function liveQuote(sym) {
  const u = `${YF(sym)}?range=1d&interval=1m`, j = await getJSON([u, PROXY(u)]);
  try {
    const meta = j.chart.result[0].meta, price = num(meta.regularMarketPrice), prev = num(meta.chartPreviousClose ?? meta.previousClose);
    return price === null ? null : { price, change_pct: prev ? Math.round((price - prev) / prev * 10000) / 100 : 0 };
  } catch { return null; }
}
async function liveRows(sym) {   // 1-minute candles [t, o, h, l, c, volume, realBuyVolume|null]
  if (sym === 'BTC-USD') {
    for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      const j = await getJSON([`${host}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000`]);
      if (Array.isArray(j) && j.length) return j.map(k => [Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5], +k[9]]);   // k[9] = REAL taker buy volume
    }
  }
  const u = `${YF(sym)}?range=5d&interval=1m`, j = await getJSON([u, PROXY(u)]);
  try {
    const r = j.chart.result[0], q = r.indicators.quote[0], rows = [];
    r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0, null]); });
    return rows;
  } catch { return null; }
}
function aggBars(rows, tf) {   // same rule as fetch_data.py: no real buy volume = up-close candle counts as buy
  const m = new Map();
  for (const [t, o, h, l, c, v, buy] of rows) {
    const k = t - t % tf; let b = m.get(k);
    if (!b) { b = { t: k, o, h, l, c, v: 0, buy: 0, sell: 0 }; m.set(k, b); }
    b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; b.v += v;
    if (buy == null) { if (c >= o) b.buy += v; else b.sell += v; } else { b.buy += buy; b.sell += v - buy; }
  }
  const out = [...m.values()].sort((x, y) => x.t - y.t);
  if (out.length && out[out.length - 1].t + tf > Date.now() / 1000) out.pop();   // confirmed bars only
  return out;
}
const sessionOf = t => { const h = Math.floor((t % 86400) / 3600); return h < 8 ? 'asian' : h < 13 ? 'london' : h < 21 ? 'ny' : 'late'; };
function detectSigs(bars) {
  const n = bars.length, out = [], L = 5, cv = [], avg = []; let cvd = 0;
  bars.forEach((b, i) => { b.d = b.buy - b.sell; cvd += b.d; cv.push(cvd); const w = bars.slice(Math.max(0, i - 19), i + 1); avg.push(w.reduce((s, x) => s + x.v, 0) / w.length); });
  for (let i = 10; i < n; i++) {
    const b = bars[i], rel = avg[i] ? b.d / avg[i] : 0, prev = bars.slice(i - 10, i);
    const bb = rel >= .6 && b.c > Math.max(...prev.map(x => x.h)), sb = rel <= -.6 && b.c < Math.min(...prev.map(x => x.l));
    if (bb) out.push([i, 'Pulse BUY breakout']);
    if (sb) out.push([i, 'Pulse SELL breakout']);
    if (rel >= .6 && b.c < b.o && !bb) out.push([i, 'Trapped buyers']);
    if (rel <= -.6 && b.c > b.o && !sb) out.push([i, 'Trapped sellers']);
  }
  let ph = null, pc = 0, pl = null, plc = 0;
  for (let j = L; j < n - L; j++) {
    const w = bars.slice(j - L, j + L + 1);
    if (bars[j].h === Math.max(...w.map(x => x.h))) { if (ph !== null && bars[j].h > ph && cv[j] < pc) out.push([j + L, 'CVD bearish divergence']); ph = bars[j].h; pc = cv[j]; }
    if (bars[j].l === Math.min(...w.map(x => x.l))) { if (pl !== null && bars[j].l < pl && cv[j] > plc) out.push([j + L, 'CVD bullish divergence']); pl = bars[j].l; plc = cv[j]; }
  }
  return { sigs: out.sort((x, y) => x[0] - y[0]), cvd: cv, avg };
}
function atrLast(bars, n = 14) {
  if (bars.length <= n) return null;
  const tr = i => Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  let a = 0; for (let i = 1; i <= n; i++) a += tr(i); a /= n;
  for (let i = n + 1; i < bars.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a;
}
function computeFlow(m, rows) {
  const bars = aggBars(rows, 300), n = bars.length;
  if (n < 60 || !bars.some(b => b.v > 0)) return null;
  const { sigs, cvd, avg } = detectSigs(bars), sma = m.indicators && m.indicators.sma20, st = t => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');
  const signals = sigs.filter(([i]) => i >= n - 12).slice(-6).map(([i, nm]) => ({ t: st(bars[i].t), sig: nm, session: sessionOf(bars[i].t), trend: !sma ? null : ((SIGDIR[nm] === 1) === (bars[i].c > sma) ? 'with' : 'against') }));
  const m1 = aggBars(rows, 60), sum = a => a.reduce((s, b) => s + b.buy - b.sell, 0), d5 = sum(m1.slice(-5)), last = bars[n - 1], a = atrLast(bars);
  return { signals, delta: Math.round(last.d), rel_delta: avg[n - 1] ? Math.round(last.d / avg[n - 1] * 100) / 100 : 0, cvd: Math.round(cvd[n - 1]), cvd_chg_12: Math.round(cvd[n - 1] - cvd[n - 13]),
    atr5: a ? Math.round(a * 1e4) / 1e4 : null, last_bar: st(last.t), real_delta: rows[rows.length - 1][6] != null, age_min: Math.round((Date.now() / 1000 - rows[rows.length - 1][0]) / 60),
    m1: { delta_5m: Math.round(d5), delta_15m: Math.round(sum(m1.slice(-15))), dir: d5 > 0 ? 'buy' : d5 < 0 ? 'sell' : 'flat', last_close: m1[m1.length - 1].c, last_1m: st(m1[m1.length - 1].t) } };
}
function matchStats(sym, signals) {   // historical stats (backtest.json) of the signals active now; same cell rule as fetch_data.py
  const bt = state.bt && state.bt.markets && state.bt.markets[sym]; if (!bt) return null;
  const stats = signals.map(e => {
    const key = `${e.sig}|${e.session}|${e.trend}`; let row = bt.rows[key], cell = key;
    if (!row || row.n < 30) { row = bt.overall[e.sig]; cell = 'all conditions'; }
    return row ? { sig: e.sig, t: e.t, cell, ...row } : null;
  }).filter(Boolean);
  return { basis: bt.basis, days: bt.days, stats };
}
async function doRefresh(force) {
  if ((document.hidden && !force) || !state.data || !state.data.markets.length) return;
  let ok = 0, flow = 0;
  await Promise.all(state.data.markets.map(async m => {
    const [q, rows] = await Promise.all([liveQuote(m.symbol), m.orderflow ? liveRows(m.symbol) : null]);
    if (q) {
      ok++; m.price = q.price; m.change_pct = q.change_pct;
      const d = new Date().toISOString().slice(5, 10), last = m.history[m.history.length - 1];
      if (last && last.d === d) last.c = q.price; else m.history.push({ d, c: q.price });
    }
    const f = rows && m.orderflow ? computeFlow(m, rows) : null;
    if (f) { Object.assign(m.orderflow, f, { live: true }); m.orderflow.match = matchStats(m.symbol, f.signals); flow++; }
  }));
  if (!ok && !flow) return;   // keep what data.json shows
  state.liveAt = Date.now();
  $('#updatedAt').textContent = 'Live ' + new Date().toLocaleTimeString() + (flow ? ` · flow ${flow}` : '');
  const tk = $('#tickerTrack'), anim = tk.getAnimations ? tk.getAnimations()[0] : null, t = anim ? anim.currentTime : null;
  [renderMetrics, renderTicker, drawChart].forEach(fn => { try { fn(); } catch (e) { console.error(fn.name, e); } });
  const a2 = tk.getAnimations ? tk.getAnimations()[0] : null; if (a2 && t != null) a2.currentTime = t;   // marquee does not jump
}
function refreshLive(force) { if (!livePromise) livePromise = doRefresh(force).catch(e => console.error('live refresh', e)).finally(() => { livePromise = null; }); return livePromise; }
async function loadBacktest() {
  try { const r = await fetch('./backtest.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); state.bt = await r.json(); }
  catch (e) { state.bt = null; if (!state.btWarned) { state.btWarned = true; sysMsg(`Historical stats missing (backtest.json: ${e.message}). Win rates stay unknown until you run the "Daily backtest" GitHub Action.`); } }
}
function startLive() {
  if (liveTimer) return;
  refreshLive(); liveTimer = setInterval(() => refreshLive(), LIVE_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(); });
}

/* ---------- chat history ---------- */
const CH = 'aicc.chats', MAXMSG = 30000;
let corruptNote = false, fullWarned = false, saveTimer = 0;
const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; saveCurrent(); }, 1500); };
function readChats() {
  let raw = null;
  try { raw = localStorage.getItem(CH); } catch { return []; }
  if (!raw) return [];
  try {
    const a = JSON.parse(raw); if (!Array.isArray(a)) throw new Error('not an array');
    return a.filter(c => c && c.id).map(c => ({ id: String(c.id), title: String(c.title || 'New chat'), updated: +c.updated || 0, history: Array.isArray(c.history) ? c.history : [], view: Array.isArray(c.view) ? c.view : [] }));
  } catch {
    try { localStorage.setItem(CH + '.bak', raw); } catch { /* ignore */ }   // never overwrite unreadable data without a copy
    corruptNote = true; return [];
  }
}
const clip = s => (typeof s === 'string' && s.length > MAXMSG ? s.slice(0, MAXMSG) + '\n…[truncated to save space]' : s);
const slim = c => ({ ...c, history: c.history.map(m => ({ ...m, content: clip(m.content) })), view: c.view.map(m => ({ ...m, text: clip(m.text) })) });
function writeChats(list) {
  const l = list.map(slim); let dropped = 0;
  for (;;) {
    try {
      localStorage.setItem(CH, JSON.stringify(l)); fullWarned = false;
      if (dropped) { const keep = new Set(l.map(c => c.id)); state.chats = state.chats.filter(c => keep.has(c.id)); sysMsg(`Storage full: the ${dropped} oldest chat(s) were removed so new ones can be saved.`); }
      return true;
    } catch {
      let i = l.length - 1; while (i >= 0 && l[i].id === state.chatId) i--;   // drop the oldest chat that is not open
      if (i < 0) { if (!fullWarned) { fullWarned = true; sysMsg('Chat not saved: browser storage is full. Delete old chats.'); } return false; }
      l.splice(i, 1); dropped++;
    }
  }
}
function ensureChat(title) {
  if (state.chatId) return;
  const c = { id: uid(), title: title.slice(0, 40), updated: Date.now(), history: state.history, view: state.view };
  state.chats.unshift(c); state.chatId = c.id; renderChatList();
}
function saveCurrent() {
  const cur = state.chats.find(x => x.id === state.chatId); if (!cur) return;
  cur.history = state.history; cur.view = state.view; cur.updated = Date.now();
  const others = readChats().filter(c => c.id !== cur.id);   // keep chats saved meanwhile by another tab
  state.chats = [cur, ...others].sort((a, b) => b.updated - a.updated);
  writeChats(state.chats); renderChatList();
}
function renderChatList() {
  $('#chatList').innerHTML = state.chats.map(c => `<div class="chat-item ${c.id === state.chatId ? 'active' : ''}" data-id="${c.id}"><button type="button" class="chat-open" data-act="open" title="${esc(c.title)}">${esc(c.title || 'New chat')}</button><button type="button" class="chat-del" data-act="del" aria-label="Delete chat">×</button></div>`).join('') || '<p class="mut">No chats yet.</p>';
}
function showChat(c) {
  state.chatId = c ? c.id : null; state.history = c ? c.history : []; state.view = c ? c.view : [];
  $('#messages').innerHTML = ''; state.view.forEach(m => addMsg(m.role, m.text || '(no reply was saved: the page was closed while waiting)'));
  updateTokens(); $('#latency').textContent = '–'; renderChatList();
}
const side = $('#histPanel'), closeSide = () => side.classList.remove('show');
$('#toggleSide').onclick = () => {
  if (matchMedia('(max-width:800px)').matches) side.classList.toggle('show');
  else { const off = $('#app').classList.toggle('side-off'); save('aicc.sideoff', off); }
};
$('#newChat').onclick = () => { if (state.busy) return; showChat(null); closeSide(); };
$('#chatList').addEventListener('click', e => {
  const item = e.target.closest('.chat-item'); if (!item || state.busy) return;
  if (e.target.dataset.act === 'del') {
    state.chats = readChats().filter(c => c.id !== item.dataset.id); writeChats(state.chats);
    if (state.chatId === item.dataset.id) showChat(null); else renderChatList();
  } else { showChat(state.chats.find(c => c.id === item.dataset.id)); closeSide(); }
});

function checkAssets() {
  if (getComputedStyle(document.documentElement).getPropertyValue('--v').trim() !== '5') sysMsg('styles.css is outdated. Upload the latest styles.css and press Ctrl+F5.');
}

const flush = () => { if (state.chatId) saveCurrent(); };
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* ---------- agent modes (system prompt presets) ---------- */
const DATA_GUIDE = `Market data fields: price, change_pct (vs previous close), last7 (last 7 daily closes). ind = daily indicators (rsi14, sma20, sma50, atr14, hi30/lo30 = 30-day range, chg5d_pct, trend).
of = order flow on 5-minute bars (tf). real_delta=true means buy/sell volume is REAL aggressor volume from the exchange (Binance taker volume, BTC). real_delta=false means an ESTIMATE from candles (up-close candle = buy volume), a proxy and NOT a footprint or DOM. age_min = minutes since the last candle: futures from Yahoo (Gold GC, Nasdaq NQ) are about 10-15 min late, so give levels, zones and conditional plans, not instant entries. atr5 = 5m ATR. delta = buy minus sell volume of the last bar; rel_delta = delta / 20-bar average volume; cvd = cumulative delta; cvd_chg_12 = CVD change over 12 bars. signals = recent Pulse breakouts/traps and CVD divergences (confirmed bars only). imbalance_zones = unmitigated 3x buy/sell zones. walls = volume-spike swing highs/lows not yet broken (liquidity proxy). blocks = recent high-volume bars. vp200 = POC/VAH/VAL of the last 200 bars. sessions = POC/VAH/VAL of previous (prev) and current (cur) Daily, Asian (00-08 UTC), London (08-16) and New York (13-21).
m1 = 1-MINUTE CONFIRMATION: delta_5m and delta_15m = sum of 1-minute delta over the last 5/15 minutes, dir = who is aggressive now, last_close.
match = HISTORICAL STATS of the signals active now (from a daily backtest of every signal: Binance 5m for about 1 year on BTC, Yahoo 5m for about 60 days on the others; see basis and days). Each entry: sig, t, cell (same signal + same session + with/against the daily trend, or "all conditions" when that cell has fewer than 30 cases), n samples, win_pct, ci (interval: 99.9% for cells, 95% for all conditions), avg_r, recent_win_pct (last 30% of the data), edge = positive / inconclusive / negative / unproven (n<30). Rule: enter at next bar open, stop 1 x atr5, target 2 x atr5, max 24 bars, no fees or slippage, so breakeven win rate is 33%. Signals cluster in time and the past may not repeat, so "positive" is weak evidence, never proof. Each signal in of.signals also has session (asian/london/ny/late, UTC) and trend (with/against the daily SMA20).
meta = freshness. data_json_updated = the 15-minute file (ind, walls, imbalance_zones, blocks, vp200, sessions come from it). browser_refresh = recomputed in the browser each minute and right before this message (price, change_pct, and of.delta, rel_delta, cvd, cvd_chg_12, atr5, signals, m1, match). backtest_generated = when the historical stats were built; "MISSING" means NO historical stats exist: say win rates are unknown, never rate a setup above Low, and tell the user to run the "Daily backtest" GitHub Action. Mention the data age you rely on.
A market without "of" has no usable volume (for example EUR/USD).`;
const COMMON = `Rules: base every answer on the market data in this chat and quote exact numbers. Never invent prices, news, indicators or win rates: the only win rates you may quote are the ones in of.match, with n and the interval. If there is no match entry or n<30, say the win rate is unknown. Never promise profit. Give the main risk and the invalidation. Answer in the user's language (Darija, Arabic, French or English), short and structured. End with: Not financial advice.`;
const SCORECARD = `Setup scorecard (use it for every setup, show the 5 checks as yes/no):
1) Daily trend agrees (ind.trend and price vs sma20/sma50). 2) A recent 5m signal in of.signals points the same way. 3) 1-minute confirmation: of.m1.dir and delta_5m agree with the direction. 4) Price is within 0.5 x atr5 of a key level (session POC/VAH/VAL, vp200, an unmitigated imbalance zone, or a wall). 5) The matching of.match entry has edge "positive" (n>=30).
Confidence: 4-5 = High, 3 = Medium, 0-2 = Low (say "no trade"). Then give entry zone, stop (about 1 x atr5), target (2R), and quote the signal's historical win_pct with n and ci. If of.real_delta is false or age_min is above 5, lower your confidence one step and say why.`;
const MODES = {
  trading: { label: 'Trading analyst', data: true, prompt: `You are a disciplined day-trading assistant for BTC, Gold (GC), Nasdaq (NQ), S&P 500, EUR/USD and crude oil. Timeframe: 5 minutes and above, 1-minute data only to confirm.\n${SCORECARD}\n${DATA_GUIDE}\n${COMMON}` },
  validator: { label: 'Setup validator', data: true, prompt: `You validate a trade setup the user describes (market, direction, entry, stop, target). Run the scorecard, say which checks pass or fail, compute the risk/reward, compare the user's stop with 1 x atr5, quote the historical stats of the matching signal from of.match (cell, n, win_pct, ci), and give a verdict: take it, wait for confirmation (say exactly what to wait for), or skip.\n${SCORECARD}\n${DATA_GUIDE}\n${COMMON}` },
  orderflow: { label: 'Order flow', data: true, prompt: `You are an order-flow analyst. Read the "of" block: delta, rel_delta, CVD trend and divergences, Pulse breakouts/traps, imbalance zones, liquidity walls, blocks, Volume Profile levels and the 1-minute confirmation (m1). Look for confluence (for example price at a session POC with a CVD divergence, an unmitigated imbalance zone and m1 agreeing) and say which levels matter and why. State whether the delta is real (BTC) or an estimate.\n${DATA_GUIDE}\n${COMMON}` },
  technical: { label: 'Technical analysis', data: true, prompt: `You are a technical analyst. Use the daily data: price versus SMA20/SMA50, RSI14 (overbought above 70, oversold below 30), ATR14, the 30-day range and the last 7 closes. Describe trend, momentum, support and resistance and give a scenario for each direction.\n${DATA_GUIDE}\n${COMMON}` },
  risk: { label: 'Risk manager', data: true, prompt: `You are a risk manager. Ask for account size, risk per trade (default 1%), entry and stop if missing. Compute position size, risk amount and reward/risk. Suggest stops from atr5 (about 1 x) or ATR14 for swing trades. Warn about oversized positions, correlated trades (S&P and Nasdaq, gold and EUR/USD), trading into high volatility and stale (delayed) prices.\n${DATA_GUIDE}\n${COMMON}` },
  general: { label: 'General assistant', data: false, prompt: '' }
};
function applyMode(key, force) {
  const m = MODES[key]; if (!m) return;
  save('aicc.mode', key);
  if (!force) return;
  $('#systemPrompt').value = m.prompt; save(LS.system, m.prompt);
  $('#accData').checked = m.data; save('aicc.access', { data: $('#accData').checked, search: $('#accSearch').checked });
}
function initModes() {
  const sel = $('#modeSelect');
  sel.innerHTML = Object.entries(MODES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  sel.value = MODES[load('aicc.mode', 'trading')] ? load('aicc.mode', 'trading') : 'trading';
  if (!$('#systemPrompt').value.trim() || load('aicc.modeVer', '') !== '5') { applyMode(sel.value, true); save('aicc.modeVer', '5'); }   // first visit: preload the prompt, never overwrite your own text
  sel.onchange = () => applyMode(sel.value, true);
}

/* ---------- init ---------- */
window.addEventListener('load', () => {
  state.profiles = load(LS.profiles, []); state.primary = load(LS.primary, null);
  state.profiles.forEach(p => { if (p.vendor === 'gemini' && /^gemini-2\.0-flash(-lite)?(-001)?$/.test(p.defaultModel)) p.defaultModel = 'gemini-flash-latest'; });   // 2.0 models are retired
  save(LS.profiles, state.profiles);
  const steps = [renderModelSelect, updateStatus, loadData, checkAssets, initModes, () => {
    if (load('aicc.sideoff', false)) $('#app').classList.add('side-off');
    state.chats = readChats(); renderChatList(); if (state.chats.length) showChat(state.chats[0]);
    if (corruptNote) sysMsg('Saved chats could not be read. A backup copy was kept in localStorage (aicc.chats.bak).');
  }];
  steps.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  if (!state.profiles.some(p => p.key)) { if (!state.profiles.length) state.profiles.push({ id: uid(), vendor: 'deepseek', name: 'DeepSeek', key: '', baseUrl: '', defaultModel: 'deepseek-chat' }); state.primary = state.primary || state.profiles[0].id; openVault(); }
});
})();
