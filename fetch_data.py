#!/usr/bin/env python3
"""Fetch market data and write data.json.

Per market: price, 30-day history, daily indicators (RSI, SMA, ATR), order flow on 5m bars (port of
Order_Flow_Suite_v2_1_SessionVP.pine), 1m confirmation, and a BACKTEST of every signal (win rate with 95% interval).
* BTC: Binance klines -> REAL aggressor volume (taker buy volume). Falls back to Yahoo if Binance is unreachable.
* Futures (GC, NQ) and others: Yahoo candles, about 10-15 min delayed; delta is an ESTIMATE (up-close = buy volume).
* EURUSD=X has no volume on Yahoo, so it gets no order flow.
"""
import json, sys, time
from datetime import datetime, timezone
import requests

SYMBOLS = {"GC=F": "Gold (GC futures)", "XAUUSD=X": "Gold spot (XAUUSD)", "EURUSD=X": "EUR/USD", "^GSPC": "S&P 500", "NQ=F": "Nasdaq (NQ futures)", "BTC-USD": "Bitcoin", "CL=F": "Crude Oil"}
URLS = [
    "https://query1.finance.yahoo.com/v8/finance/chart/{}",
    "https://query2.finance.yahoo.com/v8/finance/chart/{}",   # second host: used when the first one blocks or rate-limits
]
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ai-control-center/1.0)"}
TF = 300   # order-flow bar = 5 minutes (confirmation uses 1-minute data)
CRYPTO = {"BTC-USD": "BTCUSDT"}
BINANCE = ["https://data-api.binance.vision/api/v3/klines", "https://api.binance.com/api/v3/klines", "https://api.binance.us/api/v3/klines"]
ROWS1M = {}   # 1-minute candles per symbol, used to measure the futures/spot basis
SIG_DIR = {"Pulse BUY breakout": 1, "Pulse SELL breakout": -1, "Trapped sellers": 1, "Trapped buyers": -1, "CVD bullish divergence": 1, "CVD bearish divergence": -1,
           "Bullish engulfing": 1, "Bearish engulfing": -1, "Hammer": 1, "Shooting star": -1, "SSL sweep": 1, "BSL sweep": -1,
           "SSL sweep+reversal": 1, "BSL sweep+reversal": -1}


def get(url, params=None, tries=3):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"  retry {i + 1}/{tries}: {e}")
            time.sleep(2 * (i + 1))
    return None


def chart(sym, params):
    for u in URLS:
        d = get(u.format(sym), params)
        if d:
            return d
    return None


def stamp(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%m-%d %H:%M")


# ------------------------------------------------------------------ daily indicators
def rsi(cl, n=14):
    if len(cl) <= n:
        return None
    g = [max(cl[i] - cl[i - 1], 0) for i in range(1, len(cl))]
    l = [max(cl[i - 1] - cl[i], 0) for i in range(1, len(cl))]
    ag, al = sum(g[:n]) / n, sum(l[:n]) / n
    for i in range(n, len(g)):
        ag, al = (ag * (n - 1) + g[i]) / n, (al * (n - 1) + l[i]) / n
    return 100.0 if al == 0 else round(100 - 100 / (1 + ag / al), 1)


def atr(rows, n=14):
    if len(rows) <= n:
        return None
    tr = [max(rows[i][1] - rows[i][2], abs(rows[i][1] - rows[i - 1][3]), abs(rows[i][2] - rows[i - 1][3])) for i in range(1, len(rows))]
    a = sum(tr[:n]) / n
    for x in tr[n:]:
        a = (a * (n - 1) + x) / n
    return a


def indicators(rows):
    cl = [r[3] for r in rows]
    price = cl[-1]
    sma = lambda n: round(sum(cl[-n:]) / n, 4) if len(cl) >= n else None
    s20, s50, a = sma(20), sma(50), atr(rows)
    last = rows[-30:]
    trend = None
    if s20 and s50:
        trend = "up" if price > s20 > s50 else "down" if price < s20 < s50 else "mixed"
    return {"rsi14": rsi(cl), "sma20": s20, "sma50": s50, "atr14": round(a, 4) if a else None,
            "hi30": round(max(r[1] for r in last), 4), "lo30": round(min(r[2] for r in last), 4),
            "chg5d_pct": round((price / cl[-6] - 1) * 100, 2) if len(cl) > 5 else None, "trend": trend}


# ------------------------------------------------------------------ order flow (port of the Pine script)
def profile(bs, bin_sz, va=0.7):
    """POC / VAH / VAL. Each bar's volume is spread equally over its high-low bins (estimate)."""
    if not bs or bin_sz <= 0:
        return None
    base = min(b["l"] for b in bs)
    nb = min(4000, int((max(b["h"] for b in bs) - base) / bin_sz) + 1)
    vol = [0.0] * nb
    for b in bs:
        r0, r1 = int((b["l"] - base) / bin_sz), min(nb - 1, int((b["h"] - base) / bin_sz))
        for r in range(r0, r1 + 1):
            vol[r] += b["v"] / (r1 - r0 + 1)
    tot = sum(vol)
    if tot <= 0:
        return None
    p = vol.index(max(vol)); up = dn = p; acc = vol[p]
    while acc < tot * va and (up < nb - 1 or dn > 0):
        nu = vol[up + 1] if up < nb - 1 else -1
        nd = vol[dn - 1] if dn > 0 else -1
        if nu >= nd:
            up += 1; acc += nu
        else:
            dn -= 1; acc += nd
    return {"poc": round(base + (p + .5) * bin_sz, 4), "vah": round(base + (up + 1) * bin_sz, 4), "val": round(base + dn * bin_sz, 4)}


def sma_at(a, n, i):
    w = a[max(0, i - n + 1):i + 1]
    return sum(w) / len(w)


def prep(bars):
    vols = [b["v"] for b in bars]
    a20 = [sma_at(vols, 20, i) for i in range(len(bars))]
    a50 = [sma_at(vols, 50, i) for i in range(len(bars))]
    cvd, s = [], 0
    for b in bars:
        b["d"] = b["buy"] - b["sell"]; s += b["d"]; cvd.append(s)
    return a20, a50, cvd


def detect(bars, a20, cvd, L=5, flow=True):   # flow=False: price only (spot has no real volume), the sweep+reversal combo then needs no delta
    """Signals with the bar index where they are CONFIRMED (no look-ahead): Pulse, traps, CVD divergence."""
    n, out = len(bars), []
    for i in range(10, n):
        b = bars[i]; rel = b["d"] / a20[i] if a20[i] else 0
        hh, ll = max(x["h"] for x in bars[i - 10:i]), min(x["l"] for x in bars[i - 10:i])
        bb, sb = rel >= .6 and b["c"] > hh, rel <= -.6 and b["c"] < ll
        for ok, name in ((bb, "Pulse BUY breakout"), (sb, "Pulse SELL breakout"),
                         (rel >= .6 and b["c"] < b["o"] and not bb, "Trapped buyers"), (rel <= -.6 and b["c"] > b["o"] and not sb, "Trapped sellers")):
            if ok: out.append((i, name))
    ph = pc = pl = plc = None
    for j in range(L, n - L):
        w = bars[j - L:j + L + 1]
        if bars[j]["h"] == max(x["h"] for x in w):
            if ph is not None and bars[j]["h"] > ph and cvd[j] < pc: out.append((j + L, "CVD bearish divergence"))
            ph, pc = bars[j]["h"], cvd[j]
        if bars[j]["l"] == min(x["l"] for x in w):
            if pl is not None and bars[j]["l"] < pl and cvd[j] > plc: out.append((j + L, "CVD bullish divergence"))
            pl, plc = bars[j]["l"], cvd[j]
    atr = atr_series(bars)                                      # price action (confirmed on bar close, no look-ahead)
    hi, lo, sw_up, sw_dn = [], [], -99, -99                     # unswept swing highs / lows = resting buy-side / sell-side liquidity
    for i in range(1, n):
        j = i - L
        if j >= L:
            w = bars[j - L:j + L + 1]
            if bars[j]["h"] == max(x["h"] for x in w): hi = (hi + [bars[j]["h"]])[-8:]
            if bars[j]["l"] == min(x["l"] for x in w): lo = (lo + [bars[j]["l"]])[-8:]
        b, pv, a = bars[i], bars[i - 1], atr[i]
        if not a: continue
        body, rng = abs(b["c"] - b["o"]), b["h"] - b["l"]
        up, dn = b["h"] - max(b["o"], b["c"]), min(b["o"], b["c"]) - b["l"]
        eb = pv["c"] < pv["o"] and b["c"] > b["o"] and b["c"] >= pv["o"] and b["o"] <= pv["c"] and body >= .5 * a
        es = pv["c"] > pv["o"] and b["c"] < b["o"] and b["c"] <= pv["o"] and b["o"] >= pv["c"] and body >= .5 * a
        ham = rng >= .8 * a and dn >= 2 * body and dn >= .5 * rng and b["c"] - b["l"] >= .66 * rng
        star = rng >= .8 * a and up >= 2 * body and up >= .5 * rng and b["h"] - b["c"] >= .66 * rng
        bsl = [x for x in hi if b["h"] > x and b["c"] < x]       # wick above a swing high, close back below: buy-side liquidity taken
        ssl = [x for x in lo if b["l"] < x and b["c"] > x]       # wick below a swing low, close back above: sell-side liquidity taken
        hi = [x for x in hi if b["h"] <= x]                      # swept or broken levels are consumed
        lo = [x for x in lo if b["l"] >= x]
        if bsl: sw_up = i
        if ssl: sw_dn = i
        for ok, name in ((eb, "Bullish engulfing"), (es, "Bearish engulfing"), (ham, "Hammer"), (star, "Shooting star"), (bool(ssl), "SSL sweep"), (bool(bsl), "BSL sweep"),
                         (i - sw_dn <= 1 and (b["d"] > 0 or not flow) and (eb or ham or (sw_dn == i - 1 and b["c"] > pv["h"])), "SSL sweep+reversal"),
                         (i - sw_up <= 1 and (b["d"] < 0 or not flow) and (es or star or (sw_up == i - 1 and b["c"] < pv["l"])), "BSL sweep+reversal")):
            if ok: out.append((i, name))
    return sorted(out, key=lambda x: x[0])


def structure(bars, L=5):
    """5m swing structure: unswept buy-side / sell-side liquidity above / below price and the HH+HL / LH+LL read."""
    n, sh, sl = len(bars), [], []
    for j in range(L, n - L):
        w = bars[j - L:j + L + 1]
        if bars[j]["h"] == max(x["h"] for x in w): sh.append((j, bars[j]["h"]))
        if bars[j]["l"] == min(x["l"] for x in w): sl.append((j, bars[j]["l"]))
    live_h = [q for j, q in sh if all(x["h"] <= q for x in bars[j + 1:])]
    live_l = [q for j, q in sl if all(x["l"] >= q for x in bars[j + 1:])]
    last = bars[-1]["c"]
    bsl, ssl = sorted(q for q in live_h if q > last)[:3], sorted((q for q in live_l if q < last), reverse=True)[:3]
    read = "range"
    if len(sh) >= 2 and len(sl) >= 2:
        hh, hl = sh[-1][1] > sh[-2][1], sl[-1][1] > sl[-2][1]
        read = "bullish (HH+HL)" if hh and hl else "bearish (LH+LL)" if not hh and not hl else "range"
    return {"read": read, "swing_high": round(sh[-1][1], 4) if sh else None, "swing_low": round(sl[-1][1], 4) if sl else None,
            "bsl": [round(q, 4) for q in bsl], "ssl": [round(q, 4) for q in ssl]}


def atr_series(bars, n=14):
    out, a, trs = [None] * len(bars), None, []
    for i in range(1, len(bars)):
        pc = bars[i - 1]["c"]; tr = max(bars[i]["h"] - bars[i]["l"], abs(bars[i]["h"] - pc), abs(bars[i]["l"] - pc))
        if i <= n: trs.append(tr)
        if i == n: a = sum(trs) / n
        elif i > n: a = (a * (n - 1) + tr) / n
        out[i] = a
    return out


def wilson(w, n, z=1.96):
    p = w / n; d = 1 + z * z / n; c = p + z * z / (2 * n); m = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** .5)
    return (c - m) / d, (c + m) / d


def simulate(bars, hold=24, rr=2.0, flow=True, extra=None, dirs=None):   # extra = more (bar index, name) signals, dirs = their directions
    """Replay every signal: enter at the next bar open, stop 1 ATR, target rr x ATR, max `hold` bars. Stop wins if both are touched.
    Returns [(bar index, signal name, result in R)]. No fees or slippage."""
    n = len(bars)
    if n < 200: return []
    a20, a50, cvd = prep(bars); atrs = atr_series(bars); items = []
    dmap = {**SIG_DIR, **(dirs or {})}
    for i, name in sorted(detect(bars, a20, cvd, flow=flow) + (extra or []), key=lambda x: x[0]):
        if i + 2 >= n or not atrs[i]: continue
        d, e, a = dmap[name], bars[i + 1]["o"], atrs[i]
        stop, tgt, r = e - d * a, e + d * rr * a, None
        for b in bars[i + 1:i + 1 + hold]:
            if (b["l"] <= stop) if d == 1 else (b["h"] >= stop): r = -1.0; break
            if (b["h"] >= tgt) if d == 1 else (b["l"] <= tgt): r = rr; break
        if r is None: r = max(-1.0, min(rr, d * (bars[min(n - 1, i + hold)]["c"] - e) / a))
        items.append((i, name, r))
    return items


COST_R = 0.1   # assumed spread + slippage + fees per trade, in R (stop = 1 ATR)


def summarize(items, n_bars, rr=2.0, z=1.96):
    """items = [(bar index, r)]. The edge test uses the AVERAGE R net of COST_R (a timeout with a small gain is not a 'win' for expectancy):
    positive = the interval of the mean R is above 0 AND the last 30% of the data is above 0 too; negative = interval below 0."""
    k = len(items)
    if not k: return None
    xs = [r - COST_R for _, r in items]; m = sum(xs) / k
    se = (sum((x - m) ** 2 for x in xs) / (k - 1)) ** .5 / k ** .5 if k > 1 else 0
    oos = [r - COST_R for i, r in items if i >= 0.7 * n_bars]; om = sum(oos) / len(oos) if oos else 0
    w = sum(1 for _, r in items if r > 0); lo, hi = wilson(w, k, z); ow = sum(1 for i, r in items if i >= 0.7 * n_bars and r > 0) / len(oos) if oos else 0
    edge = "unproven (n<30)" if k < 30 else "positive" if m - z * se > 0 and len(oos) >= 10 and om > 0 else "negative" if m + z * se < 0 else "inconclusive"
    return {"n": k, "win_pct": round(w / k * 100, 1), "ci": [round(lo * 100), round(hi * 100)], "avg_r": round(m, 2), "avg_r_ci": [round(m - z * se, 2), round(m + z * se, 2)],
            "recent_win_pct": round(ow * 100, 1) if oos else None, "recent_n": len(oos), "recent_avg_r": round(om, 2) if oos else None, "edge": edge}


def session_of(t):
    h = (t % 86400) // 3600
    return "asian" if h < 8 else "london" if h < 13 else "ny" if h < 21 else "late"


def order_flow(bars, atr_d, sma20=None):
    n = len(bars)
    if n < 60 or sum(b["v"] for b in bars) <= 0:
        return None
    a20, a50, cvd = prep(bars)
    sigs = detect(bars, a20, cvd)
    ev = [{"t": stamp(bars[i]["t"]), "sig": nm, "session": session_of(bars[i]["t"]),
           "trend": None if not sma20 else "with" if (SIG_DIR[nm] == 1) == (bars[i]["c"] > sma20) else "against"} for i, nm in sigs if i >= n - 12][-8:]
    L, walls = 5, []
    for j in range(L, n - L):                                   # 5) liquidity walls (volume-spike pivots)
        if bars[j]["v"] > 2 * a50[j]:
            w = bars[j - L:j + L + 1]
            if bars[j]["h"] == max(x["h"] for x in w): walls.append(("resistance", bars[j]["h"], j))
            if bars[j]["l"] == min(x["l"] for x in w): walls.append(("support", bars[j]["l"], j))
    live_walls = [{"side": sd, "price": round(p, 4)} for sd, p, j in walls
                  if not any((x["c"] > p if sd == "resistance" else x["c"] < p) for x in bars[j + L + 1:])][-4:]
    zones = []                                                  # 4) volume imbalance zones
    for i, b in enumerate(bars):
        zones = [z for z in zones if not (b["c"] < z[2] if z[0] == "buy" else b["c"] > z[1])]
        if b["buy"] > 0 and b["buy"] >= 3 * b["sell"] and b["v"] >= a20[i]: zones.append(("buy", b["o"], b["l"]))
        elif b["sell"] > 0 and b["sell"] >= 3 * b["buy"] and b["v"] >= a20[i]: zones.append(("sell", b["h"], b["o"]))
        zones = zones[-20:]
    blocks = [{"t": stamp(b["t"]), "side": "buy" if b["d"] >= 0 else "sell", "vol": round(b["v"]), "price": round(b["c"], 4)}
              for i, b in enumerate(bars) if b["v"] > 2.5 * a50[i]][-4:]                     # 6) block trades
    v200 = bars[-200:]
    sessions = {}                                               # 8) session volume profiles (UTC)
    ref = atr_d or (max(b["h"] for b in bars[-288:]) - min(b["l"] for b in bars[-288:]))
    hr = lambda t: (t % 86400) // 3600
    for name, fn, r in (("daily", lambda t: True, ref), ("asian", lambda t: hr(t) < 8, ref * .6),
                        ("london", lambda t: 8 <= hr(t) < 16, ref * .6), ("ny", lambda t: 13 <= hr(t) < 21, ref * .6)):
        g = {}
        for b in bars:
            if fn(b["t"]): g.setdefault(b["t"] // 86400, []).append(b)
        ks = sorted(g)[-2:]
        sessions[name] = {lbl: profile(g[k], r / 40) for lbl, k in zip(("prev", "cur") if len(ks) == 2 else ("cur",), ks)}
    atr5 = atr_series(bars)[-1]
    return {"tf": "5m", "structure": structure(bars), "bars": n, "last_bar": stamp(bars[-1]["t"]), "atr5": round(atr5, 4) if atr5 else None,
            "delta": round(bars[-1]["d"]), "rel_delta": round(bars[-1]["d"] / a20[-1], 2) if a20[-1] else 0,
            "cvd": round(cvd[-1]), "cvd_chg_12": round(cvd[-1] - cvd[-13]), "signals": ev,
            "imbalance_zones": [{"side": z[0], "top": round(z[1], 4), "bottom": round(z[2], 4)} for z in zones[-4:]],
            "bars5": [[b["t"], round(b["o"], 2), round(b["h"], 2), round(b["l"], 2), round(b["c"], 2)] for b in bars[-300:]],   # real 5m bars for the browser Monte Carlo (not sent to the AI)
            "walls": live_walls, "blocks": blocks, "vp200": profile(v200, (max(b["h"] for b in v200) - min(b["l"] for b in v200)) / 30), "sessions": sessions}


def confirm(m1):
    """1-minute confirmation: who is aggressive right now."""
    l5, l15 = m1[-5:], m1[-15:]
    d5, d15 = sum(b["buy"] - b["sell"] for b in l5), sum(b["buy"] - b["sell"] for b in l15)
    return {"delta_5m": round(d5), "delta_15m": round(d15), "dir": "buy" if d5 > 0 else "sell" if d5 < 0 else "flat",
            "last_close": round(m1[-1]["c"], 4), "last_1m": stamp(m1[-1]["t"])}


# ------------------------------------------------------------------ candles -> bars
def yahoo_rows(sym, interval, rng):
    res = chart(sym, {"range": rng, "interval": interval})["chart"]["result"][0]; q = res["indicators"]["quote"][0]
    return [(t, o, h, l, c, v or 0, None) for t, o, h, l, c, v in zip(res["timestamp"], q["open"], q["high"], q["low"], q["close"], q["volume"]) if None not in (o, h, l, c)]


def binance_rows(pair, interval, n):
    """Klines with REAL taker-buy volume (index 9). Several hosts: api.binance.com is blocked from some countries."""
    out, end = [], None
    while len(out) < n:
        p = {"symbol": pair, "interval": interval, "limit": min(1000, n - len(out))}
        if end: p["endTime"] = end
        d = next((x for x in (get(u, p, tries=2) for u in BINANCE) if x), None)
        if not d: break
        out = d + out; end = d[0][0] - 1
        if len(d) < p["limit"]: break
    return [(k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]), float(k[9])) for k in out[-n:]]


def agg(rows, tf):
    """Aggregate candles into tf-second bars. buy is None (Yahoo): up-close candle = buy volume, down-close = sell volume."""
    bars = {}
    for t, o, h, l, c, v, buy in rows:
        b = bars.setdefault(t - t % tf, {"t": t - t % tf, "o": o, "h": h, "l": l, "c": c, "v": 0, "buy": 0, "sell": 0})
        b["h"], b["l"], b["c"] = max(b["h"], h), min(b["l"], l), c
        b["v"] += v
        if buy is None: b["buy" if c >= o else "sell"] += v
        else: b["buy"] += buy; b["sell"] += v - buy
    out = [bars[k] for k in sorted(bars)]
    if out and out[-1]["t"] + tf > time.time():
        out.pop()                                            # signals only on confirmed bars (no repaint)
    return out


# ------------------------------------------------------------------ main
def fetch_symbol(sym, name):
    data = chart(sym, {"range": "6mo", "interval": "1d"})
    try:
        res = data["chart"]["result"][0]; q = res["indicators"]["quote"][0]
        rows = [(t, h, l, c) for t, h, l, c in zip(res["timestamp"], q["high"], q["low"], q["close"]) if None not in (h, l, c)]
        if len(rows) < 2:
            raise ValueError(f"only {len(rows)} close(s) returned")
        hist = [{"d": datetime.fromtimestamp(t, timezone.utc).strftime("%m-%d"), "c": round(c, 4)} for t, h, l, c in rows[-30:]]
        price, prev = hist[-1]["c"], hist[-2]["c"]
        return {"symbol": sym, "name": name, "price": price, "change_pct": round((price - prev) / prev * 100, 2) if prev else 0,
                "history": hist, "indicators": indicators(rows)}
    except Exception as e:
        print(f"[x] {sym}: {e}")
        return None


def match_stats(sym, signals):
    """Historical stats (from backtest.json, built daily by backtest.py) for the signals that are active NOW:
    same signal + same session + same side of the daily trend. Falls back to all conditions when that cell has n<30."""
    try:
        with open("backtest.json", encoding="utf-8") as f:
            allbt = json.load(f)["markets"]
        bt = allbt[sym]
    except Exception:
        return None
    sp = allbt.get("XAUUSD=X") if sym == "GC=F" else None      # same signal measured on the SPOT candles you trade (price action only)
    out = []
    for e in signals:
        key = f"{e['sig']}|{e['session']}|{e['trend']}"
        row, cell = bt["rows"].get(key), key
        if not row or row["n"] < 30:
            row, cell = bt["overall"].get(e["sig"]), "all conditions"
        if row:
            item = {"sig": e["sig"], "t": e["t"], "cell": cell, **row}
            if sp:
                srow, scell = sp["rows"].get(key), key
                if not srow or srow["n"] < 30:
                    srow, scell = sp["overall"].get(e["sig"]), "all conditions"
                if srow:
                    item["spot"] = {"cell": scell, **srow}
            out.append(item)
    return {"basis": bt["basis"], "days": bt["days"], "stats": out}


def process(sym, name):
    m = fetch_symbol(sym, name)
    if not m:
        return None
    m["orderflow"] = None
    try:
        pair, real, rows = CRYPTO.get(sym), False, []
        if pair:
            rows = binance_rows(pair, "1m", 7200); real = bool(rows)
        if not rows:
            rows = yahoo_rows(sym, "1m", "5d")
        ROWS1M[sym] = rows
        of = order_flow(agg(rows, TF), m["indicators"]["atr14"], m["indicators"]["sma20"])
        if of:
            of["real_delta"], of["age_min"], of["m1"] = real, round((time.time() - rows[-1][0]) / 60), confirm(agg(rows, 60))
            of["match"] = match_stats(sym, of["signals"])
        m["orderflow"] = of
    except Exception as e:
        print(f"  order flow failed: {e}")
    return m


def basis_from_rows(fut, spot, k=30):
    """Futures minus spot, measured on the SAME minutes (median of the last k overlapping 1m closes). Never compare prices of different times."""
    sp = {t - t % 60: c for t, o, h, l, c, v, b in spot}
    d = [c - sp[t - t % 60] for t, o, h, l, c, v, b in fut[-240:] if t - t % 60 in sp][-k:]
    if len(d) < 10:
        return None
    s = sorted(d)
    return {"basis": s[len(s) // 2], "n": len(d), "spread": round(max(d) - min(d), 2)}


def attach_spot(markets):
    """Order flow comes from GC futures, but you trade spot XAUUSD: give every GC level already converted to spot (level - basis)."""
    by = {m["symbol"]: m for m in markets}
    gc = by.get("GC=F")
    if not gc or not gc.get("orderflow") or "XAUUSD=X" not in by:
        return
    bs = basis_from_rows(ROWS1M.get("GC=F", []), ROWS1M.get("XAUUSD=X", []))
    if not bs:
        print("  spot basis: not enough overlapping minutes"); return
    of, b = gc["orderflow"], bs["basis"]
    r = lambda x: None if x is None else round(x - b, 2)
    prof = lambda p: p and {k: r(v) for k, v in p.items()}
    of["spot"] = {"note": "XAUUSD spot level = GC futures level minus basis. Use these for spot trades.", "basis": round(b, 2), "basis_samples": bs["n"], "basis_spread": bs["spread"],
                  "vp200": prof(of["vp200"]), "sessions": {n: {k: prof(v) for k, v in d.items()} for n, d in of["sessions"].items()},
                  "imbalance_zones": [{**z, "top": r(z["top"]), "bottom": r(z["bottom"])} for z in of["imbalance_zones"]],
                  "walls": [{**w, "price": r(w["price"])} for w in of["walls"]], "blocks": [{**x, "price": r(x["price"])} for x in of["blocks"]],
                  "structure": {**of["structure"], "swing_high": r(of["structure"]["swing_high"]), "swing_low": r(of["structure"]["swing_low"]),
                                "bsl": [r(x) for x in of["structure"]["bsl"]], "ssl": [r(x) for x in of["structure"]["ssl"]]}}
    print(f"  spot basis GC - XAUUSD = {b:.2f} ({bs['n']} minutes, spread {bs['spread']})")


def main():
    markets = []
    for sym, name in SYMBOLS.items():
        print(f"Fetching {sym} ({name})")
        m = process(sym, name)
        if not m:
            continue
        of = m["orderflow"]
        print(f"  ok: {m['price']} ({m['change_pct']}%) order flow: " + (f"yes, real_delta={of['real_delta']}, age {of['age_min']} min" if of else "no volume/intraday data"))
        markets.append(m)
    attach_spot(markets)
    if not markets:
        print("No data fetched; keeping the previous data.json")
        sys.exit(1)
    out = {"updated": datetime.now(timezone.utc).isoformat(), "source": "Binance (BTC) + Yahoo Finance", "markets": markets}
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote data.json with {len(markets)} markets")


if __name__ == "__main__":
    main()
