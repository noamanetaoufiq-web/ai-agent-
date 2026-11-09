#!/usr/bin/env python3
"""Fetch market data (Yahoo Finance public chart endpoint) and write data.json.

Per market: price, 30-day history, daily indicators (RSI, SMA, ATR) and an ORDER-FLOW ESTIMATE
ported from Order_Flow_Suite_v2_1_SessionVP.pine (15m bars built from 1m candles: up-close = buy volume).
It is a proxy, not a real footprint or DOM. FX (EURUSD=X) has no volume on Yahoo, so it gets no order flow.
"""
import json, sys, time
from datetime import datetime, timezone
import requests

SYMBOLS = {"GC=F": "Gold", "EURUSD=X": "EUR/USD", "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "BTC-USD": "Bitcoin", "CL=F": "Crude Oil"}
URLS = [
    "https://query1.finance.yahoo.com/v8/finance/chart/{}",
    "https://query2.finance.yahoo.com/v8/finance/chart/{}",   # second host: used when the first one blocks or rate-limits
]
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ai-control-center/1.0)"}
TF = 900   # order-flow bar = 15 minutes


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


def order_flow(bars, atr_d):
    n = len(bars)
    if n < 60 or sum(b["v"] for b in bars) <= 0:
        return None
    vols = [b["v"] for b in bars]
    a20 = [sma_at(vols, 20, i) for i in range(n)]
    a50 = [sma_at(vols, 50, i) for i in range(n)]
    cvd, s = [], 0
    for b in bars:
        b["d"] = b["buy"] - b["sell"]; s += b["d"]; cvd.append(s)
    ev, L = [], 5
    for i in range(max(10, n - 12), n):                       # 3) Pulse: breakouts and traps
        b = bars[i]; rel = b["d"] / a20[i] if a20[i] else 0
        hh, ll = max(x["h"] for x in bars[i - 10:i]), min(x["l"] for x in bars[i - 10:i])
        bb, sb = rel >= .6 and b["c"] > hh, rel <= -.6 and b["c"] < ll
        for ok, name in ((bb, "Pulse BUY breakout"), (sb, "Pulse SELL breakout"),
                         (rel >= .6 and b["c"] < b["o"] and not bb, "Trapped buyers"), (rel <= -.6 and b["c"] > b["o"] and not sb, "Trapped sellers")):
            if ok:
                ev.append({"t": stamp(b["t"]), "sig": name})
    ph = pc = pl = plc = None                                   # 2) CVD divergence on pivots
    walls = []
    for j in range(L, n - L):
        w = bars[j - L:j + L + 1]
        is_h, is_l = bars[j]["h"] == max(x["h"] for x in w), bars[j]["l"] == min(x["l"] for x in w)
        if is_h:
            if ph is not None and bars[j]["h"] > ph and cvd[j] < pc and j + L >= n - 12:
                ev.append({"t": stamp(bars[j + L]["t"]), "sig": "CVD bearish divergence"})
            ph, pc = bars[j]["h"], cvd[j]
        if is_l:
            if pl is not None and bars[j]["l"] < pl and cvd[j] > plc and j + L >= n - 12:
                ev.append({"t": stamp(bars[j + L]["t"]), "sig": "CVD bullish divergence"})
            pl, plc = bars[j]["l"], cvd[j]
        if bars[j]["v"] > 2 * a50[j]:                          # 5) liquidity walls (volume-spike pivots)
            if is_h: walls.append(("resistance", bars[j]["h"], j))
            if is_l: walls.append(("support", bars[j]["l"], j))
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
    ref = atr_d or (max(b["h"] for b in bars[-96:]) - min(b["l"] for b in bars[-96:]))
    hr = lambda t: (t % 86400) // 3600
    for name, fn, r in (("daily", lambda t: True, ref), ("asian", lambda t: hr(t) < 8, ref * .6),
                        ("london", lambda t: 8 <= hr(t) < 16, ref * .6), ("ny", lambda t: 13 <= hr(t) < 21, ref * .6)):
        g = {}
        for b in bars:
            if fn(b["t"]): g.setdefault(b["t"] // 86400, []).append(b)
        ks = sorted(g)[-2:]
        sessions[name] = {lbl: profile(g[k], r / 40) for lbl, k in zip(("prev", "cur") if len(ks) == 2 else ("cur",), ks)}
    return {"tf": "15m", "bars": n, "last_bar": stamp(bars[-1]["t"]), "delta": round(bars[-1]["d"]), "rel_delta": round(bars[-1]["d"] / a20[-1], 2) if a20[-1] else 0,
            "cvd": round(cvd[-1]), "cvd_chg_12": round(cvd[-1] - cvd[-13]), "signals": ev[-6:],
            "imbalance_zones": [{"side": z[0], "top": round(z[1], 4), "bottom": round(z[2], 4)} for z in zones[-4:]],
            "walls": live_walls, "blocks": blocks, "vp200": profile(v200, (max(b["h"] for b in v200) - min(b["l"] for b in v200)) / 30), "sessions": sessions}


def build_bars(sym):
    d = chart(sym, {"range": "5d", "interval": "1m"})
    res = d["chart"]["result"][0]; q = res["indicators"]["quote"][0]
    bars = {}
    for t, o, h, l, c, v in zip(res["timestamp"], q["open"], q["high"], q["low"], q["close"], q["volume"]):
        if None in (o, h, l, c): continue
        v = v or 0; k = t - t % TF
        b = bars.setdefault(k, {"t": k, "o": o, "h": h, "l": l, "c": c, "v": 0, "buy": 0, "sell": 0})
        b["h"], b["l"], b["c"] = max(b["h"], h), min(b["l"], l), c
        b["v"] += v
        b["buy" if c >= o else "sell"] += v                  # intrabar buy/sell volume, as in the Pine LTF loop
    out = [bars[k] for k in sorted(bars)]
    if out and out[-1]["t"] + TF > time.time():
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


def main():
    markets = []
    for sym, name in SYMBOLS.items():
        print(f"Fetching {sym} ({name})")
        m = fetch_symbol(sym, name)
        if not m:
            continue
        try:
            m["orderflow"] = order_flow(build_bars(sym), m["indicators"]["atr14"])
        except Exception as e:
            print(f"  order flow failed: {e}"); m["orderflow"] = None
        print(f"  ok: {m['price']} ({m['change_pct']}%) order flow: {'yes' if m['orderflow'] else 'no volume/intraday data'}")
        markets.append(m)
    if not markets:
        print("No data fetched; keeping the previous data.json")
        sys.exit(1)
    out = {"updated": datetime.now(timezone.utc).isoformat(), "source": "Yahoo Finance", "markets": markets}
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote data.json with {len(markets)} markets")


if __name__ == "__main__":
    main()
