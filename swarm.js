/* AI Control Center: Swarm mode. Browser port of the Trading Swarm pipeline.
   Technical -> Macro -> Orchestrator (LLM agents, JSON out) -> Inspector (code) -> Backtest gate (code)
   -> Trade Validator (per-trade Monte Carlo, code) -> Audit (LLM, veto only) -> verdict + sizing.
   Rule of the original swarm kept here: CODE decides, the LLM can only veto. Analysis only: it never sends orders.
   Depends on globals from app.js (state, $, esc, callAIProvider, refreshLive, liveRows, aggBars, SIGDIR, ...). */

const SW = {
  KEY: 'aicc.swarm',
  // contract values are typical CFD values: verify them with your broker and edit them in the Swarm window
  MARKETS: {
    XAUUSD: { label: 'XAUUSD spot (order flow from GC futures)', analysis: 'GC=F', trade: 'XAUUSD=X', spot: true, upp: 100, minLot: 0.01, step: 0.01, spread: 0.35, slip: 0.1 },
    NAS100: { label: 'Nasdaq (NQ futures levels)', analysis: 'NQ=F', trade: 'NQ=F', spot: false, upp: 1, minLot: 0.1, step: 0.1, spread: 1.5, slip: 0.5 },
    BTCUSD: { label: 'Bitcoin (Binance real delta)', analysis: 'BTC-USD', trade: 'BTC-USD', spot: false, upp: 1, minLot: 0.01, step: 0.01, spread: 15, slip: 5 }
  },
  RUNS: [10, 100, 1000, 5000], MAXWAIT: 24, MAXHOLD: 72, BLOCK: 12
};

/* ============================ pure logic (tested in node) ============================ */
const swNum = v => { v = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : v; return Number.isFinite(v) ? v : null; };
const swF = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '-' : Number(x).toFixed(d));

function swWilson(w, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
function swRR(dir, e, s, t) {
  if ([e, s, t].some(v => v === null || v === undefined)) return null;
  if (dir === 'LONG' && s < e && e < t) return (t - e) / (e - s);
  if (dir === 'SHORT' && t < e && e < s) return (e - t) / (s - e);
  return null;
}
function swSize(cfg, mk, entry, sl, mult = 1) {   // lots so that the loss at the stop, spread and slippage included, stays in the risk budget
  const dist = Math.abs(entry - sl), per = (dist + mk.spread + mk.slip) * mk.upp, risk = cfg.equity * cfg.riskPct / 100 * mult;
  if (!(dist > 0) || !(per > 0)) return { lots: 0, risk_usd: 0, risk_pct: 0, note: 'invalid stop distance' };
  const lots = Math.round(Math.floor(risk / per / mk.step + 1e-9) * mk.step * 1e4) / 1e4;
  if (lots < mk.minLot) return { lots: 0, risk_usd: 0, risk_pct: 0, note: `risk budget $${risk.toFixed(2)} is too small for the minimum lot ${mk.minLot} (needs $${(mk.minLot * per).toFixed(2)})` };
  return { lots, risk_usd: Math.round(lots * per * 100) / 100, risk_pct: Math.round(lots * per / cfg.equity * 1e4) / 100, note: '' };
}

function swNormalizePlan(p) {   // coerce whatever the LLM returned into the schema; unknown values become safe defaults
  const pick = (v, list, d) => (list.includes(String(v).toUpperCase()) ? String(v).toUpperCase() : d);
  const arr = v => (Array.isArray(v) ? v.slice(0, 6).map(String) : []);
  return { decision: pick(p.decision, ['TRADE', 'WAIT', 'NO_TRADE'], 'WAIT'), direction: pick(p.direction, ['LONG', 'SHORT', 'NONE'], 'NONE'), entry: swNum(p.entry), stop_loss: swNum(p.stop_loss), take_profit: swNum(p.take_profit),
    confidence: Math.max(0, Math.min(100, Math.round(swNum(p.confidence) ?? 0))), thesis: String(p.thesis || ''), conflicts_resolved: arr(p.conflicts_resolved), invalidation: String(p.invalidation || '') };
}

function swInspect(plan, ctx, cfg, mk, macro) {   // hard rules, all in code
  const bad = [], warn = [], atr = ctx.atr5, price = ctx.price;
  if (plan.decision !== 'TRADE' || !['LONG', 'SHORT'].includes(plan.direction)) bad.push(`orchestrator decision is ${plan.decision}: nothing to approve`);
  const rr = swRR(plan.direction, plan.entry, plan.stop_loss, plan.take_profit);
  if (plan.decision === 'TRADE') {
    if (rr === null) bad.push('levels are not coherent (LONG needs SL < entry < TP, SHORT needs TP < entry < SL)');
    else if (rr < cfg.minRR) bad.push(`R:R ${swF(rr)} is below the minimum ${cfg.minRR}`);
    if (plan.confidence < cfg.conf) bad.push(`confidence ${plan.confidence} is below ${cfg.conf}`);
    if (rr !== null) {
      const dist = Math.abs(plan.entry - plan.stop_loss);
      if (atr) { const k = dist / atr; if (k < 0.5 || k > 4) bad.push(`stop distance is ${swF(k)} x ATR5 (allowed 0.5-4)`); }
      if ((mk.spread + mk.slip) / dist > 0.2) bad.push('spread + slippage is more than 20% of the stop distance');
    }
    if (atr && price) {
      for (const [n, v] of [['entry', plan.entry], ['stop', plan.stop_loss], ['target', plan.take_profit]]) {
        if (v !== null && Math.abs(v - price) > 30 * atr) bad.push(`${n} ${v} is ${swF(Math.abs(v - price) / atr, 0)} x ATR5 away from the live price ${swF(price)}: not grounded in the data`);
      }
      if (plan.entry !== null && Math.abs(plan.entry - price) > 6 * atr) bad.push(`entry is ${swF(Math.abs(plan.entry - price) / atr, 1)} x ATR5 from the live price (max 6)`);
    }
  }
  if (!ctx.hasFlow) bad.push('no order-flow data for this market');
  if (mk.spot && !ctx.hasSpot) bad.push('futures/spot basis is unavailable, so spot levels cannot be trusted');
  if (ctx.age > cfg.maxAge) bad.push(`order-flow data is ${ctx.age} min old (max ${cfg.maxAge})`);
  else if (ctx.age > 5) warn.push(`delayed feed (${ctx.age} min): use a LIMIT order at the level, price may have moved`);
  if (macro && macro.freeze_trading) bad.push('macro/news agent asks to freeze trading (high-impact event)');
  if (macro && plan.direction === 'LONG' && macro.asset_bias === 'BEARISH') bad.push('macro bias is BEARISH against a LONG');
  if (macro && plan.direction === 'SHORT' && macro.asset_bias === 'BULLISH') bad.push('macro bias is BULLISH against a SHORT');
  return { approved: bad.length === 0, reasons: bad, warnings: warn, rr };
}

function swLevels(P) {   // every named level the agents could use, in the trade instrument's price terms
  const out = [], add = (v, name) => { v = swNum(v); if (v !== null) out.push({ v, name }); }, L = P.levels || {}, S = P.structure || {};
  const prof = (p, n) => p && ['poc', 'vah', 'val'].forEach(k => add(p[k], `${n} ${k.toUpperCase()}`));
  prof(L.vp200, 'VP200');
  Object.entries(L.sessions || {}).forEach(([n, d]) => Object.entries(d || {}).forEach(([w, p]) => prof(p, `${n} ${w}`)));
  (L.imbalance_zones || []).forEach(z => { add(z.top, `${z.side} imbalance top`); add(z.bottom, `${z.side} imbalance bottom`); });
  (L.walls || []).forEach(w => add(w.price, `${w.side} wall`)); (L.blocks || []).forEach(b => add(b.price, 'block'));
  add(S.swing_high, 'swing high'); add(S.swing_low, 'swing low'); (S.bsl || []).forEach(x => add(x, 'BSL')); (S.ssl || []).forEach(x => add(x, 'SSL'));
  return out;
}
function swConfirm(ctx, plan, cfg) {   // price-action + order-flow confirmation checklist (code). Needs a TRIGGER (sweep or reversal candle) and enough checks.
  const P = ctx.payload, long = plan.direction === 'LONG', dir = long ? 1 : -1, names = (P.signals || []).map(s => s.sig), has = l => names.some(n => l.includes(n));
  const sweep = has(long ? ['SSL sweep', 'SSL sweep+reversal'] : ['BSL sweep', 'BSL sweep+reversal']);
  const candle = has(long ? ['Bullish engulfing', 'Hammer', 'SSL sweep+reversal'] : ['Bearish engulfing', 'Shooting star', 'BSL sweep+reversal']);
  const oppDiv = names.includes(long ? 'CVD bearish divergence' : 'CVD bullish divergence'), read = String((P.structure || {}).read || '');
  const near = swLevels(P).map(x => ({ ...x, d: Math.abs(plan.entry - x.v) })).sort((a, b) => a.d - b.d)[0];
  const checks = [
    { name: `Liquidity sweep (${long ? 'SSL taken, bullish' : 'BSL taken, bearish'})`, pass: sweep, detail: sweep ? 'sweep in the last 12 bars' : 'no sweep in this direction' },
    { name: 'Reversal candle (engulfing / pin bar)', pass: candle, detail: candle ? 'present' : 'none in this direction' },
    { name: 'Order flow agrees (CVD, no opposing divergence)', pass: Math.sign(P.cvd_chg_12 || 0) === dir && !oppDiv, detail: `CVD change 12 bars ${P.cvd_chg_12}${oppDiv ? ', opposing divergence' : ''}` },
    { name: '1-minute confirmation', pass: !!P.m1 && P.m1.dir === (long ? 'buy' : 'sell'), detail: P.m1 ? `1m aggressor ${P.m1.dir}, delta 5m ${P.m1.delta_5m}` : 'no 1m data' },
    { name: '5m structure (or counter-trend with a sweep)', pass: read.startsWith(long ? 'bullish' : 'bearish') || sweep, detail: read || 'unknown' },
    { name: 'Daily trend agrees', pass: !!P.ind && P.ind.trend === (long ? 'up' : 'down'), detail: `daily trend ${P.ind && P.ind.trend}` },
    { name: 'Entry at a key level (within 0.5 x ATR5)', pass: !!near && near.d <= 0.5 * ctx.atr5, detail: near ? `nearest: ${near.name} ${swF(near.v)} (${swF(near.d / ctx.atr5, 2)} x ATR5)` : 'no levels' }];
  const score = checks.filter(c => c.pass).length, trigger = sweep || candle, min = cfg.minConfirm ?? 4;
  return { score, total: checks.length, min, trigger, checks, passed: trigger && score >= min };
}

function swGate(match, dir, preferSpot) {   // backtest gate from the daily backtest (of.match): stats of the ACTIVE signals in the plan's direction
  const want = dir === 'LONG' ? 1 : -1, rank = { positive: 3, inconclusive: 2, 'unproven (n<30)': 1, negative: 0 };
  const stats = ((match && match.stats) || []).filter(s => SIGDIR[s.sig] === want).map(s => (preferSpot && s.spot ? { sig: s.sig, t: s.t, ...s.spot, cell: s.spot.cell + ' [XAUUSD spot candles]' } : s));
  if (!stats.length) return { verdict: 'INSUFFICIENT_DATA', best: null, reasons: ['no active order-flow signal in this direction, so there is no historical evidence for this setup'] };
  const best = [...stats].sort((a, b) => (rank[b.edge] - rank[a.edge]) || (b.n - a.n))[0];
  const v = best.edge === 'positive' ? 'GOOD' : best.edge === 'negative' ? 'BAD' : best.edge === 'inconclusive' && best.avg_r > 0 ? 'MARGINAL' : best.edge === 'unproven (n<30)' ? 'INSUFFICIENT_DATA' : 'BAD';
  return { verdict: v, best, reasons: [`${best.sig} (${best.cell}): n=${best.n}, win ${best.win_pct}% (interval ${best.ci[0]}-${best.ci[1]}%), avg ${best.avg_r}R net of cost, edge ${best.edge}`] };
}

function swSimulate(bars, plan, price, mk, runs = 5000, rnd = Math.random) {
  /* Block bootstrap of the real 5m bars (12-bar blocks keep volatility clustering), drift removed, so the win rate is what LUCK gives
     this entry/SL/TP after costs. Fills on touch, same candle SL + TP counts as SL, spread + slippage charged in R, time-out after MAXHOLD bars. */
  const off = [];
  for (let i = 1; i < bars.length; i++) { const pc = bars[i - 1].c; off.push([bars[i].o - pc, bars[i].h - pc, bars[i].l - pc, bars[i].c - pc]); }
  const mu = off.reduce((s, x) => s + x[3], 0) / off.length;
  off.forEach(x => { for (let k = 0; k < 4; k++) x[k] -= mu; });
  const long = plan.direction === 'LONG', e = plan.entry, sl = plan.stop_loss, tp = plan.take_profit, dist = Math.abs(e - sl), rr = Math.abs(tp - e) / dist, costR = (mk.spread + mk.slip) / dist;
  const kind = long ? (e < price ? 'limit' : 'stop') : (e > price ? 'limit' : 'stop'), res = [];
  for (let r = 0; r < runs; r++) {
    let P = price, st = 'wait', blk = 0, pos = 0, held = 0, out = null, code = 'none';
    for (let t = 0; t < SW.MAXWAIT + SW.MAXHOLD; t++) {
      if (blk === 0) { pos = Math.floor(rnd() * Math.max(1, off.length - SW.BLOCK)); blk = SW.BLOCK; }
      const d = off[pos++]; blk--;
      const h = P + d[1], l = P + d[2], c = P + d[3]; P = c;
      if (st === 'wait') {
        if (t >= SW.MAXWAIT) break;
        if (!(long ? (kind === 'limit' ? l <= e : h >= e) : (kind === 'limit' ? h >= e : l <= e))) continue;
        st = 'open';
      }
      held++;
      if (long ? l <= sl : h >= sl) { out = -1 - costR; code = 'sl'; break; }
      if (long ? h >= tp : l <= tp) { out = rr - costR; code = 'tp'; break; }
      if (held >= SW.MAXHOLD) { out = Math.max(-1, Math.min(rr, (long ? c - e : e - c) / dist)) - costR; code = 'timeout'; break; }
    }
    res.push({ r: out, code });
  }
  const ladder = SW.RUNS.filter(n => n <= runs).map(n => {   // nested prefixes of the same paths: shows the estimate converging
    const f = res.slice(0, n).filter(x => x.r !== null), w = f.filter(x => x.r > 0).length, ci = swWilson(w, f.length);
    return { runs: n, fill_pct: Math.round(f.length / n * 1000) / 10, win_pct: f.length ? Math.round(w / f.length * 1000) / 10 : 0, ci: [Math.round(ci[0] * 100), Math.round(ci[1] * 100)],
      expectancy_r: f.length ? Math.round(f.reduce((s, x) => s + x.r, 0) / f.length * 100) / 100 : 0, tp: f.filter(x => x.code === 'tp').length, sl: f.filter(x => x.code === 'sl').length, timeout: f.filter(x => x.code === 'timeout').length };
  });
  return { kind, rr, costR, ladder, luck: ladder[ladder.length - 1].win_pct / 100, fill_pct: ladder[ladder.length - 1].fill_pct, breakeven: (1 + costR) / (rr + 1), breakeven_x2: (1 + 2 * costR) / (rr + 1) };
}

function swValidate(sim, gate) {   // verdict in code: GOOD = historical edge beats luck AND break-even with confidence, also with costs x2
  if (!gate.best) return { verdict: 'BAD', reasons: ['no historical evidence to compare with the luck baseline'] };
  const h = gate.best, lo = h.ci[0] / 100, wp = h.win_pct / 100, base = Math.max(sim.luck, sim.breakeven), fillOk = sim.fill_pct >= (sim.kind === 'limit' ? 40 : 90);
  const reasons = [`luck baseline ${swF(sim.luck * 100, 1)}%, break-even ${swF(sim.breakeven * 100, 1)}% (costs x2: ${swF(sim.breakeven_x2 * 100, 1)}%), fill ${sim.fill_pct}%`];
  if (Math.abs(sim.rr - 2) > 0.5) reasons.push(`planned R:R ${swF(sim.rr)} differs from the 2R rule of the backtest: the comparison is approximate`);
  let v = 'BAD';
  if (!fillOk) reasons.push('the entry fills too rarely');
  else if (gate.verdict === 'GOOD' && lo > base && lo > sim.breakeven_x2 && Math.abs(sim.rr - 2) <= 0.5) v = 'GOOD';
  else if (gate.verdict !== 'BAD' && wp > base) v = 'MARGINAL';
  else reasons.push(`historical win rate ${h.win_pct}% does not clearly beat ${swF(base * 100, 1)}%`);
  return { verdict: v, reasons };
}

function swFinal({ plan, insp, conf, gate, val, audit, cfg, mk }) {
  const why = [...insp.reasons];
  if (conf && !conf.passed) why.push(`confirmation ${conf.score}/${conf.total} (need ${conf.min})${conf.trigger ? '' : ', and no liquidity sweep or reversal candle in this direction'}`);
  if (gate && !['GOOD', 'MARGINAL'].includes(gate.verdict)) why.push(`backtest gate ${gate.verdict}: ${gate.reasons.join('; ')}`);
  if (val && val.verdict === 'BAD') why.push(`trade validator BAD: ${val.reasons.join('; ')}`);
  if (audit && audit.veto) why.push('LLM audit vetoed: ' + (audit.concerns || []).slice(0, 3).join('; '));
  if (plan.decision !== 'TRADE') return { verdict: plan.decision === 'WAIT' ? 'WAIT' : 'NO_TRADE', reasons: why, sizing: null };
  if (why.length) return { verdict: 'REJECTED', reasons: why, sizing: null };
  const mult = val.verdict === 'MARGINAL' ? 0.5 : 1, sizing = swSize(cfg, mk, plan.entry, plan.stop_loss, mult);
  if (!sizing.lots) return { verdict: 'REJECTED', reasons: [sizing.note], sizing };
  return { verdict: mult === 1 ? 'APPROVED' : 'APPROVED_REDUCED', reasons: [], sizing, risk_mult: mult };
}

/* ============================ agents (LLM) ============================ */
const SW_TECH = `You are the Technical agent of a trading swarm. Use ONLY the data given. Every price you output must be in the trade instrument's own price terms and close to the live price (within 30 x atr5). Never invent levels: take entry, stop and target from the given levels (levels.vp200, levels.sessions, levels.imbalance_zones, levels.walls, levels.blocks, ind.hi30/lo30) or from the live price +/- multiples of atr5. Stop distance 0.5-4 x atr5. Reward:risk at least 2. A valid setup needs a TRIGGER in the plan's direction: a liquidity sweep (SSL sweep for longs, BSL sweep for shorts) and/or a reversal candle (engulfing, hammer / shooting star), ideally the sweep+reversal signal, plus order-flow agreement. Entry near a level (swept level, POC/VAH/VAL, imbalance edge); stop beyond the swept liquidity or swing (structure.swing_high / swing_low); target the next UNSWEPT liquidity (structure.bsl for longs, structure.ssl for shorts) or VAH/VAL/POC. Order flow: use signals, delta, cvd_chg_12, m1 (1-minute confirmation) and match (historical stats of the active signals). If signals has no trigger in your direction, answer setup NONE. Delta is an estimate unless real_delta is true. If there is no clean setup, answer setup NONE.
Return ONLY this JSON: {"bias":"BULLISH|BEARISH|NEUTRAL","htf_bias":"BULLISH|BEARISH|NEUTRAL","setup":"LONG|SHORT|NONE","entry":number|null,"stop_loss":number|null,"take_profit":number|null,"confidence":0-100,"zone_type":"POC|VAH|VAL|IMBALANCE|WALL|BLOCK|OTHER","reasoning":["..."],"invalidation":"..."}`;
const SW_MACRO = `You are the Macro and News agent of a trading swarm. If you can search the web, check today's high-impact events (CPI, FOMC, NFP, central banks, geopolitics) for the next 2 hours and the dominant driver of this instrument; set freeze_trading true when a high-impact event is imminent. If you cannot search, say so in summary and base the read on cross_markets only. Never invent events.
Return ONLY this JSON: {"regime":"RISK_ON|RISK_OFF|NEUTRAL","asset_bias":"BULLISH|BEARISH|NEUTRAL","freeze_trading":true|false,"key_events":["..."],"summary":"..."}`;
const SW_ORCH = `You are the Orchestrator (CIO) of a trading swarm. Merge the technical and macro reports into one decision. Do not change the technical numbers and do not invent new levels. If the reports conflict, lower the confidence or answer WAIT. Only answer TRADE when the technical setup is LONG or SHORT with complete levels.
Return ONLY this JSON: {"decision":"TRADE|WAIT|NO_TRADE","direction":"LONG|SHORT|NONE","entry":number|null,"stop_loss":number|null,"take_profit":number|null,"confidence":0-100,"thesis":"...","conflicts_resolved":["..."],"invalidation":"..."}`;
const SW_AUDIT = `You are the false-signal auditor (devil's advocate). The numeric rules, the historical backtest and the Monte Carlo were already checked by code. Look for what code cannot see: a thesis built on one weak confluence, chasing a move, entering into an obvious liquidity grab, ignoring a conflicting report, stale data. You can only VETO; you cannot approve. When in doubt about a real risk, veto.
Return ONLY this JSON: {"veto":true|false,"false_signal_risk":0-100,"concerns":["..."],"summary":"..."}`;

async function swAsk(system, payload, search = false) {
  let out = '';
  const p = await callAIProvider(typeof payload === 'string' ? payload : JSON.stringify(payload), { system, search, onToken: t => { out += t; } });
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${p.name} returned no JSON`);
  try { return { data: JSON.parse(m[0]), provider: p.name }; } catch { throw new Error(`${p.name} returned invalid JSON`); }
}

function swContext(key, cfg) {   // everything the agents may see, in the TRADE instrument's price terms
  const mk = swMarket(cfg, key), ms = state.data ? state.data.markets : [];
  const A = ms.find(m => m.symbol === mk.analysis), T = ms.find(m => m.symbol === mk.trade) || A;
  if (!A || !A.orderflow) return { error: `no order-flow data for ${mk.analysis} yet (run "Update data" and wait for it)` };
  const of = A.orderflow, sp = mk.spot ? of.spot : null, lv = sp || of, m1 = of.m1 ? { ...of.m1 } : null;
  if (m1 && sp && m1.last_close_spot !== undefined) m1.last_close = m1.last_close_spot;
  const ctx = { instrument: key, price: T.price, atr5: of.atr5, age: of.age_min, hasFlow: true, hasSpot: !!sp || !mk.spot, real_delta: of.real_delta };
  ctx.payload = { instrument: key, quote_currency: 'USD', live_price: T.price, atr5: of.atr5, data_age_min: of.age_min, real_delta: of.real_delta, ind: (T.indicators || A.indicators), signals: of.signals, delta: of.delta, rel_delta: of.rel_delta, cvd_chg_12: of.cvd_chg_12,
    m1, structure: lv.structure, levels: { vp200: lv.vp200, sessions: lv.sessions, imbalance_zones: lv.imbalance_zones, walls: lv.walls, blocks: lv.blocks }, match: of.match,
    cross_markets: ms.filter(m => m.symbol !== mk.analysis && m.symbol !== mk.trade).map(m => ({ name: m.name, price: m.price, change_pct: m.change_pct, rsi14: m.indicators && m.indicators.rsi14, trend: m.indicators && m.indicators.trend })) };
  ctx.match = of.match; ctx.mk = mk;
  return ctx;
}
async function swBars(mk, key) {   // real 5m bars for the Monte Carlo: live if reachable, else the copy stored in data.json
  const A = state.data.markets.find(m => m.symbol === mk.analysis);
  try { const rows = await liveRows(mk.analysis); if (rows && rows.length) { const b = aggBars(rows, 300); if (b.length >= 100) return b.slice(-1000); } } catch { /* use the stored copy */ }
  const s = A && A.orderflow && A.orderflow.bars5;
  return s && s.length >= 100 ? s.map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] })) : null;
}

async function swRun(cfg, key, ui) {
  const mk = swMarket(cfg, key), S = (id, title, status, detail, data) => ui.step(id, title, status, detail, data), res = { key, mk, cfg };
  S('data', 'Data', 'run', 'refreshing prices and order flow...');
  await Promise.race([refreshLive(true), new Promise(r => setTimeout(r, 8000))]);
  const ctx = swContext(key, cfg);
  if (ctx.error) { S('data', 'Data', 'bad', ctx.error); res.final = { verdict: 'NO_TRADE', reasons: [ctx.error] }; return res; }
  S('data', 'Data', 'ok', `${key} live ${swF(ctx.price)}, ATR5 ${swF(ctx.atr5)}, flow age ${ctx.age} min, ${ctx.real_delta ? 'REAL' : 'estimated'} delta`);
  res.ctx = ctx;
  try {
    S('macro', 'Macro / News agent', 'run', 'asking...');
    const mr = await swAsk(SW_MACRO, { instrument: key, now_utc: new Date().toISOString(), search_available: $('#accSearch').checked, cross_markets: ctx.payload.cross_markets }, $('#accSearch').checked);
    res.macro = mr.data; S('macro', 'Macro / News agent', 'ok', `${mr.data.regime || '?'} / bias ${mr.data.asset_bias || '?'}${mr.data.freeze_trading ? ' / FREEZE' : ''} (${mr.provider})`, mr.data);
    S('tech', 'Technical agent', 'run', 'asking...');
    const tr = await swAsk(SW_TECH, ctx.payload);
    res.tech = tr.data; S('tech', 'Technical agent', 'ok', `${tr.data.setup || 'NONE'}, confidence ${tr.data.confidence ?? '-'} (${tr.provider})`, tr.data);
    S('orch', 'Orchestrator', 'run', 'asking...');
    const orr = await swAsk(SW_ORCH, { technical: res.tech, macro: res.macro, live_price: ctx.price, atr5: ctx.atr5 });
    res.plan = swNormalizePlan(orr.data); const P = res.plan;
    S('orch', 'Orchestrator', 'ok', `${P.decision} ${P.direction} entry ${swF(P.entry)} SL ${swF(P.stop_loss)} TP ${swF(P.take_profit)} conf ${P.confidence} (${orr.provider})`, P);
  } catch (e) { S('error', 'Agent error', 'bad', e.message); res.final = { verdict: 'ERROR', reasons: [e.message] }; return res; }
  const P = res.plan;
  res.insp = swInspect(P, ctx, cfg, mk, res.macro);
  S('insp', 'Inspector (code)', res.insp.approved ? 'ok' : 'bad', res.insp.approved ? `all hard rules passed, R:R ${swF(res.insp.rr)}${res.insp.warnings.length ? ' | ' + res.insp.warnings.join('; ') : ''}` : res.insp.reasons.join(' | '));
  if (P.decision === 'TRADE' && res.insp.approved) {
    res.conf = swConfirm(ctx, P, cfg);
    S('conf', 'Confirmation (code)', res.conf.passed ? 'ok' : 'bad', `${res.conf.score}/${res.conf.total} checks (need ${res.conf.min}${res.conf.trigger ? '' : ', no sweep/reversal trigger'}): ` + res.conf.checks.map(c => (c.pass ? '✓ ' : '✗ ') + c.name).join(' | '), res.conf.checks);
  }
  if (res.conf && res.conf.passed) {
    res.gate = swGate(ctx.match, P.direction, mk.spot);
    S('gate', 'Backtest gate (code)', ['GOOD', 'MARGINAL'].includes(res.gate.verdict) ? 'ok' : 'bad', `${res.gate.verdict}: ${res.gate.reasons.join('; ')}`, res.gate.best);
    if (['GOOD', 'MARGINAL'].includes(res.gate.verdict)) {
      S('val', 'Trade validator (Monte Carlo)', 'run', 'simulating 5000 paths...');
      const bars = await swBars(mk, key);
      if (!bars) { res.val = { verdict: 'BAD', reasons: ['no 5m price history available for the simulation'] }; S('val', 'Trade validator (Monte Carlo)', 'bad', res.val.reasons[0]); }
      else {
        await new Promise(r => setTimeout(r, 30));
        res.sim = swSimulate(bars, P, ctx.price, mk); res.val = swValidate(res.sim, res.gate);
        S('val', 'Trade validator (Monte Carlo)', res.val.verdict === 'BAD' ? 'bad' : 'ok', `${res.val.verdict}: ${res.val.reasons.join('; ')}`, res.sim.ladder);
      }
      if (cfg.audit && res.val.verdict !== 'BAD') {
        try { S('audit', 'Audit (LLM, veto only)', 'run', 'asking...'); const ar = await swAsk(SW_AUDIT, { plan: P, technical: res.tech, macro: res.macro, gate: res.gate.best, validator: res.sim && res.sim.ladder, warnings: res.insp.warnings });
          res.audit = ar.data; S('audit', 'Audit (LLM, veto only)', ar.data.veto ? 'bad' : 'ok', `${ar.data.veto ? 'VETO' : 'no veto'}, false-signal risk ${ar.data.false_signal_risk ?? '-'} (${ar.provider})`, ar.data);
        } catch (e) { S('audit', 'Audit (LLM, veto only)', 'bad', 'audit failed: ' + e.message); res.audit = { veto: true, concerns: ['audit could not run: ' + e.message] }; }
      }
    }
  }
  res.final = swFinal({ plan: P, insp: res.insp, conf: res.conf, gate: res.gate, val: res.val, audit: res.audit, cfg, mk });
  return res;
}

function swReport(r) {   // built by code, not by the LLM
  const f = r.final, P = r.plan, L = [`**Swarm report: ${r.key}**  (${new Date().toLocaleString()})`, '', `**Verdict: ${f.verdict}**`];
  if (P) L.push(`Plan: ${P.direction} entry ${swF(P.entry)}, stop ${swF(P.stop_loss)}, target ${swF(P.take_profit)}, R:R ${swF(r.insp && r.insp.rr)}, confidence ${P.confidence}`);
  if (f.sizing && f.sizing.lots) L.push(`Size: ${f.sizing.lots} lots, risk $${f.sizing.risk_usd} (${f.sizing.risk_pct}% of $${r.cfg.equity})${f.risk_mult === 0.5 ? ', REDUCED risk (marginal evidence)' : ''}`);
  if (f.reasons.length) { L.push('', '**Why not:**'); f.reasons.forEach(x => L.push('- ' + x)); }
  if (r.conf) { L.push('', `**Confirmation ${r.conf.score}/${r.conf.total}:**`); r.conf.checks.forEach(c => L.push(`${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`)); }
  if (r.gate && r.gate.best) L.push('', `**History:** ${r.gate.reasons[0]}`);
  if (r.sim) { L.push('', '**Monte Carlo (luck baseline, costs in):**'); r.sim.ladder.forEach(x => L.push(`${x.runs} runs: fill ${x.fill_pct}%, win ${x.win_pct}% (${x.ci[0]}-${x.ci[1]}%), expectancy ${x.expectancy_r}R`)); }
  if (r.insp && r.insp.warnings.length) L.push('', '**Warnings:** ' + r.insp.warnings.join('; '));
  if (P && P.thesis) L.push('', '**Thesis:** ' + P.thesis);
  L.push('', 'Analysis only, paper mode: nothing is sent to a broker. Not financial advice.');
  return L.join('\n');
}

/* ---- paper journal: forward test with live candles ---- */
const SWJ = 'aicc.journal';
function swResolve(t, candles) {
  /* Same rules as the Monte Carlo, on real 1-minute candles after the save: pending until the entry is touched (limit/stop), then SL / TP,
     same candle touching both counts as SL, time-out after MAXHOLD x 5 min at the close. R is net of spread + slippage. */
  const long = t.dir === 'LONG', dist = Math.abs(t.entry - t.sl), rr = Math.abs(t.tp - t.entry) / dist, e = { ...t };
  for (const k of candles) {
    if (k.t < e.created) continue;
    if (e.status === 'pending') {
      if (k.t - e.created > SW.MAXWAIT * 300) { e.status = 'expired'; e.closed = k.t; return e; }
      if (!(long ? (e.kind === 'limit' ? k.l <= e.entry : k.h >= e.entry) : (e.kind === 'limit' ? k.h >= e.entry : k.l <= e.entry))) continue;
      e.status = 'open'; e.opened = k.t;
    }
    if (long ? k.l <= e.sl : k.h >= e.sl) { e.status = 'sl'; e.r = -1 - e.costR; e.closed = k.t; return e; }
    if (long ? k.h >= e.tp : k.l <= e.tp) { e.status = 'tp'; e.r = rr - e.costR; e.closed = k.t; return e; }
    if (k.t - e.opened >= SW.MAXHOLD * 300) { e.status = 'timeout'; e.r = Math.max(-1, Math.min(rr, (long ? k.c - e.entry : e.entry - k.c) / dist)) - e.costR; e.closed = k.t; return e; }
  }
  return e;
}
function swJEntry(res, price) {   // journal entry from an approved swarm result
  const P = res.plan, mk = res.mk, dist = Math.abs(P.entry - P.stop_loss), long = P.direction === 'LONG';
  return { id: Date.now().toString(36), key: res.key, symbol: mk.trade, dir: P.direction, entry: P.entry, sl: P.stop_loss, tp: P.take_profit, lots: res.final.sizing.lots, risk_usd: res.final.sizing.risk_usd,
    rr: Math.abs(P.take_profit - P.entry) / dist, costR: (mk.spread + mk.slip) / dist, kind: long ? (P.entry < price ? 'limit' : 'stop') : (P.entry > price ? 'limit' : 'stop'),
    verdict: res.final.verdict, confirm: res.conf ? `${res.conf.score}/${res.conf.total}` : null, evidence: res.gate && res.gate.best ? `${res.gate.best.sig} n=${res.gate.best.n} avg ${res.gate.best.avg_r}R` : null,
    saved: new Date().toISOString(), created: Math.ceil(Date.now() / 60000) * 60, status: 'pending' };
}
function swJStats(j) {
  const closed = j.filter(t => ['tp', 'sl', 'timeout'].includes(t.status)), rs = closed.map(t => t.r), n = rs.length, tot = rs.reduce((a, b) => a + b, 0);
  return { closed: n, open: j.filter(t => t.status === 'open').length, pending: j.filter(t => t.status === 'pending').length, expired: j.filter(t => t.status === 'expired').length,
    win_pct: n ? Math.round(rs.filter(r => r > 0).length / n * 1000) / 10 : null, avg_r: n ? Math.round(tot / n * 100) / 100 : null, total_r: Math.round(tot * 100) / 100,
    pnl_usd: Math.round(closed.reduce((a, t) => a + t.r * t.risk_usd, 0) * 100) / 100 };
}

/* ---- UI ---- */
function swCfg() {
  const d = { equity: 10000, riskPct: 1, minRR: 2, conf: 60, minConfirm: 4, maxAge: 30, audit: true, markets: {} };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SW.KEY) || '{}') }; } catch { return d; }
}
const swSave = c => { try { localStorage.setItem(SW.KEY, JSON.stringify(c)); } catch { /* ignore */ } };
const swMarket = (cfg, key) => ({ ...SW.MARKETS[key], ...((cfg.markets || {})[key] || {}) });

function swInitUI() {
  const el = document.createElement('div');
  el.id = 'swarmModal'; el.className = 'modal'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'swTitle');
  el.innerHTML = `<div class="modal-card glass">
    <div class="row-head"><h2 id="swTitle">Swarm: trade validation</h2><button id="swClose" class="btn sm" type="button">Close</button></div>
    <p class="mut">Technical, Macro and Orchestrator agents propose a plan; code then checks the hard rules, the historical backtest and a per-trade Monte Carlo. The LLM can only veto. Nothing is sent to a broker.</p>
    <div class="sw-form">
      <label>Market <select id="swMarket">${Object.entries(SW.MARKETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label>
      <label>Equity $ <input id="swEquity" type="number" min="1" step="100"></label>
      <label>Risk % <input id="swRisk" type="number" min="0.05" max="5" step="0.05"></label>
      <label>Min R:R <input id="swRR" type="number" min="1" step="0.1"></label>
      <label>Min confidence <input id="swConf" type="number" min="0" max="100" step="5"></label>
      <label>Min confirmations (of 7) <input id="swConfirm" type="number" min="1" max="7" step="1"></label>
      <label class="sw-chk"><input id="swAudit" type="checkbox"> LLM audit</label>
    </div>
    <details><summary>Instrument specs (check with your broker)</summary>
      <div class="sw-form">
        <label>USD per 1.0 move per lot <input id="swUpp" type="number" step="any"></label>
        <label>Spread (price) <input id="swSpread" type="number" step="any"></label>
        <label>Slippage (price) <input id="swSlip" type="number" step="any"></label>
        <label>Min lot <input id="swMin" type="number" step="any"></label>
        <label>Lot step <input id="swStep" type="number" step="any"></label>
      </div></details>
    <div class="toolbar"><button id="swRun" class="btn primary" type="button">Run swarm</button><span class="spacer"></span><button id="swPost" class="btn" type="button" hidden>Send report to chat</button></div>
    <div id="swSteps" role="status"></div><div id="swOut"></div>
    <div class="toolbar"><button id="swSave" class="btn" type="button" hidden>Save as paper trade</button></div>
    <details id="swJ" open><summary>Paper journal <span id="swJn"></span></summary><p class="mut">Forward test: approved plans are followed with real 1-minute candles (the page must be open; it catches up to 5 days later). Judge the system on 30+ closed trades, not before.</p>
      <div id="swJStats"></div><div id="swJList"></div>
      <div class="toolbar"><button id="swJExport" class="btn sm" type="button">Export JSON</button><button id="swJClear" class="btn sm" type="button">Clear journal</button></div></details></div>`;
  document.body.appendChild(el);
  const g = id => $('#' + id), btn = document.createElement('button');
  btn.id = 'openSwarm'; btn.type = 'button'; btn.className = 'btn'; btn.textContent = '🐝 Swarm';
  $('#openVault').before(btn);
  const fill = () => {
    const cfg = swCfg(), mk = swMarket(cfg, g('swMarket').value);
    g('swEquity').value = cfg.equity; g('swRisk').value = cfg.riskPct; g('swRR').value = cfg.minRR; g('swConf').value = cfg.conf; g('swConfirm').value = cfg.minConfirm; g('swAudit').checked = cfg.audit;
    g('swUpp').value = mk.upp; g('swSpread').value = mk.spread; g('swSlip').value = mk.slip; g('swMin').value = mk.minLot; g('swStep').value = mk.step;
  };
  const read = () => {
    const cfg = swCfg(), key = g('swMarket').value, n = (id, d) => swNum(g(id).value) ?? d;
    Object.assign(cfg, { equity: n('swEquity', 10000), riskPct: n('swRisk', 1), minRR: n('swRR', 2), conf: n('swConf', 60), minConfirm: n('swConfirm', 4), audit: g('swAudit').checked });
    cfg.markets = { ...cfg.markets, [key]: { upp: n('swUpp', 1), spread: n('swSpread', 0), slip: n('swSlip', 0), minLot: n('swMin', 0.01), step: n('swStep', 0.01) } };
    swSave(cfg); return cfg;
  };
  let last = null;
  const jsave = j => { try { localStorage.setItem(SWJ, JSON.stringify(j.slice(-500))); } catch { /* ignore */ } };
  const jload = () => { try { const j = JSON.parse(localStorage.getItem(SWJ) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
  const jrender = () => {
    const j = jload(), st = swJStats(j);
    g('swJn').textContent = `(${j.length})`;
    g('swJStats').innerHTML = `<div class="sw-step ${st.avg_r > 0 ? 'ok' : st.closed ? 'bad' : 'run'}"><b>${st.closed} closed</b> <span>win ${st.win_pct ?? '-'}% | average ${st.avg_r ?? '-'}R | total ${st.total_r}R | $${st.pnl_usd} | open ${st.open}, pending ${st.pending}, expired ${st.expired}${st.closed < 30 ? ' | too few trades to conclude anything' : ''}</span></div>`;
    g('swJList').innerHTML = j.slice().reverse().slice(0, 30).map(t => `<div class="sw-step ${t.status === 'tp' ? 'ok' : t.status === 'sl' ? 'bad' : 'run'}">${esc(t.saved.slice(5, 16).replace('T', ' '))} <b>${esc(t.key)} ${esc(t.dir)}</b> <span>${t.kind} ${swF(t.entry)} / SL ${swF(t.sl)} / TP ${swF(t.tp)} / ${t.lots} lots | <b>${esc(t.status)}</b>${t.r !== undefined ? ` ${t.r > 0 ? '+' : ''}${swF(t.r)}R` : ''}</span></div>`).join('');
  };
  let ticking = false;
  const tick = async () => {
    if (ticking || document.hidden) return; ticking = true;
    try {
      const j = jload(), live = j.filter(t => t.status === 'pending' || t.status === 'open'); if (!live.length) return;
      const rows = {}; for (const t of live) if (!(t.symbol in rows)) rows[t.symbol] = await liveRows(t.symbol).catch(() => null);
      let changed = false;
      j.forEach((t, i) => { const r = rows[t.symbol]; if (!r || !(t.status === 'pending' || t.status === 'open')) return; const n = swResolve(t, r.map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] }))); if (n.status !== t.status) { j[i] = n; changed = true; } });
      if (changed) { jsave(j); jrender(); }
    } finally { ticking = false; }
  };
  setInterval(tick, 60000); setTimeout(tick, 6000); jrender();
  g('swSave').onclick = () => { if (!last || !last.final.sizing) return; const j = jload(); j.push(swJEntry(last, last.ctx.price)); jsave(j); g('swSave').hidden = true; jrender(); setTimeout(tick, 100); };
  g('swJClear').onclick = () => { if (confirm('Delete the whole paper journal?')) { jsave([]); jrender(); } };
  g('swJExport').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(jload(), null, 1)], { type: 'application/json' })); a.download = 'paper-journal.json'; a.click(); };
  btn.onclick = () => { fill(); jrender(); el.classList.add('open'); };
  g('swClose').onclick = () => el.classList.remove('open');
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
  g('swMarket').onchange = fill;
  g('swPost').onclick = () => {
    if (!last) return;
    const md = swReport(last); ensureChat('Swarm ' + last.key); state.view.push({ role: 'ai', text: md }); addMsg('ai', md); saveCurrent(); el.classList.remove('open');
  };
  g('swRun').onclick = async () => {
    if (!state.profiles.some(p => p.key)) return openVault();
    const cfg = read(), key = g('swMarket').value, box = g('swSteps'), rows = {};
    g('swRun').disabled = true; g('swPost').hidden = true; g('swSave').hidden = true; g('swOut').innerHTML = ''; box.innerHTML = '';
    const icon = { run: '⏳', ok: '✅', bad: '⛔' };
    const ui = { step(id, title, status, detail, data) {
      let r = rows[id]; if (!r) { r = rows[id] = document.createElement('div'); box.appendChild(r); }
      r.className = 'sw-step ' + status;
      r.innerHTML = `<b>${icon[status]} ${esc(title)}</b> <span>${esc(detail || '')}</span>${data ? `<details><summary>details</summary><pre>${esc(JSON.stringify(data, null, 1))}</pre></details>` : ''}`;
    } };
    try {
      last = await swRun(cfg, key, ui);
      const f = last.final, good = f.verdict.startsWith('APPROVED');
      g('swOut').innerHTML = `<div class="sw-final ${good ? 'ok' : 'bad'}"><b>${esc(f.verdict)}</b>${f.sizing && f.sizing.lots ? ` · ${f.sizing.lots} lots · risk $${f.sizing.risk_usd}` : ''}<br>${esc(f.reasons.join(' | '))}</div>`;
      g('swPost').hidden = false; g('swSave').hidden = !good;
    } catch (e) { g('swOut').innerHTML = `<div class="sw-final bad">${esc(e.message)}</div>`; }
    g('swRun').disabled = false;
  };
}
if (typeof document !== 'undefined' && document.getElementById) window.addEventListener('load', () => { try { swInitUI(); } catch (e) { console.error('swarm UI', e); } });
