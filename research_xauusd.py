#!/usr/bin/env python3
"""Walk-forward research on long XAUUSD candle history (15m or finer). Usage: python research_xauusd.py <file.csv> [more files]
Signals: the 8 price-action signals of the engine (price only), previous-day high/low sweeps, and classic strategies decided BEFORE looking (Donchian-20 breakout, RSI14 30/70 re-cross, SMA20/50 cross, Bollinger fade, big-bar continuation, hour-of-day long on 1h), on 15m / 30m / 1h / 4h bars, each with/against the daily trend.
Fixed rule (never tuned): enter next bar open, stop 1 ATR14, target 2 ATR, max 24 bars, cost 0.1R (0.2R shown as stress).
Protocol: TRAIN picks candidates (average R net of cost, 3-sigma lower bound above 0, n>=100), VALIDATION must confirm (mean above 0, n>=30),
FINAL TEST (never used to choose) is the honest estimate. Prices scaled x100 in some exports are detected automatically."""
import json, sys
from datetime import datetime, timezone
import fetch_data as fd, history as hist, backtest as bt

TFS = {"15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
SPLIT_A, SPLIT_B = datetime(2018, 1, 1, tzinfo=timezone.utc).timestamp(), datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
PD_DIR0 = {"PDL sweep": 1, "PDH sweep": -1, "PDL sweep+bias": 1, "PDH sweep+bias": -1}
RR, COST = 2.0, 0.1
PD_DIR = dict(PD_DIR0)


def pd_sweeps(bars):
    """Previous-day high/low sweeps: wick beyond the previous day's extreme and close back inside, once per day and side. +bias = previous day closed in that direction."""
    days = {}
    for b in bars:
        d = days.setdefault(b["t"] // 86400, {"o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"]})
        d["h"], d["l"], d["c"] = max(d["h"], b["h"]), min(d["l"], b["l"]), b["c"]
    order, out, done = sorted(days), [], set()
    prev = {d: order[k - 1] for k, d in enumerate(order) if k}
    for i, b in enumerate(bars):
        d = b["t"] // 86400
        if d not in prev: continue
        pd_ = days[prev[d]]
        if (d, "H") not in done and b["h"] > pd_["h"] and b["c"] < pd_["h"]:
            done.add((d, "H")); out.append((i, "PDH sweep"))
            if pd_["c"] < pd_["o"]: out.append((i, "PDH sweep+bias"))
        if (d, "L") not in done and b["l"] < pd_["l"] and b["c"] > pd_["l"]:
            done.add((d, "L")); out.append((i, "PDL sweep"))
            if pd_["c"] > pd_["o"]: out.append((i, "PDL sweep+bias"))
    return out


CLASSIC_DIR = {"Donchian up": 1, "Donchian down": -1, "RSI30 up": 1, "RSI70 down": -1, "SMA cross up": 1, "SMA cross down": -1,
               "Boll fade up": 1, "Boll fade down": -1, "Big bar up": 1, "Big bar down": -1}
CLASSIC_DIR.update({f"Hour {h:02d} long": 1 for h in range(24)})


def classics(bars, tf):
    """Classic signals on confirmed bars (entry at the next open in the simulation). Hour-of-day only on 1h bars (server time of the export)."""
    n, out = len(bars), []
    cl = [b["c"] for b in bars]; atr = fd.atr_series(bars)
    rsi, ag, al = [None] * n, 0.0, 0.0
    for i in range(1, n):
        g, l = max(cl[i] - cl[i - 1], 0), max(cl[i - 1] - cl[i], 0)
        if i <= 14: ag += g / 14; al += l / 14
        else: ag, al = (ag * 13 + g) / 14, (al * 13 + l) / 14
        if i >= 14: rsi[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    s20 = s50 = 0.0; w20 = []
    sma = lambda k, i: sum(cl[i - k + 1:i + 1]) / k if i >= k - 1 else None
    for i in range(50, n):
        b, a = bars[i], atr[i]
        hh, ll = max(x["h"] for x in bars[i - 20:i]), min(x["l"] for x in bars[i - 20:i])
        if b["c"] > hh: out.append((i, "Donchian up"))
        if b["c"] < ll: out.append((i, "Donchian down"))
        if rsi[i] is not None and rsi[i - 1] is not None:
            if rsi[i - 1] < 30 <= rsi[i]: out.append((i, "RSI30 up"))
            if rsi[i - 1] > 70 >= rsi[i]: out.append((i, "RSI70 down"))
        a20, a50, p20, p50 = sma(20, i), sma(50, i), sma(20, i - 1), sma(50, i - 1)
        if p20 <= p50 and a20 > a50: out.append((i, "SMA cross up"))
        if p20 >= p50 and a20 < a50: out.append((i, "SMA cross down"))
        m, sd = a20, (sum((x - a20) ** 2 for x in cl[i - 19:i + 1]) / 20) ** .5
        mp, sdp = p20, (sum((x - p20) ** 2 for x in cl[i - 20:i]) / 20) ** .5
        if cl[i - 1] < mp - 2 * sdp and b["c"] > m - 2 * sd: out.append((i, "Boll fade up"))
        if cl[i - 1] > mp + 2 * sdp and b["c"] < m + 2 * sd: out.append((i, "Boll fade down"))
        if a and b["c"] - b["o"] > 2 * a: out.append((i, "Big bar up"))
        if a and b["o"] - b["c"] > 2 * a: out.append((i, "Big bar down"))
        if tf == 3600: out.append((i, f"Hour {(b['t'] % 86400) // 3600:02d} long"))
    return out


def mstats(rs, c=COST):
    xs = [r - c for r in rs]; n = len(xs)
    if not n: return None
    m = sum(xs) / n; se = (sum((x - m) ** 2 for x in xs) / (n - 1)) ** .5 / n ** .5 if n > 1 else 0
    return {"n": n, "avg_r": round(m, 3), "se": se, "win_pct": round(sum(1 for r in rs if r > 0) / n * 100, 1)}


def main(paths):
    rows = {}
    for p in paths:
        for r in hist.read_history(p, max_gap=14400): rows[r[0]] = r
    rows = [rows[k] for k in sorted(rows)]
    med = sorted(r[4] for r in rows)[len(rows) // 2]
    if med > 20000: rows = [(t, o / 100, h / 100, l / 100, c / 100, 0, None) for t, o, h, l, c, v, b in rows]; print("prices were x100, scaled back")
    else: rows = [(t, o, h, l, c, 0, None) for t, o, h, l, c, v, b in rows]
    print(f"{len(rows)} candles, {datetime.fromtimestamp(rows[0][0], timezone.utc):%Y-%m-%d} to {datetime.fromtimestamp(rows[-1][0], timezone.utc):%Y-%m-%d}")
    groups, results = {}, {}
    for tf, sec in TFS.items():
        bars = fd.agg(rows, sec); sma = bt.daily_sma20(bars)
        dmap = {**fd.SIG_DIR, **PD_DIR0, **CLASSIC_DIR}
        items = fd.simulate(bars, rr=RR, flow=False, extra=pd_sweeps(bars) + classics(bars, sec), dirs=dmap)
        for i, nm, r in items:
            if nm.startswith(("Pulse", "Trapped", "CVD")): continue
            b = bars[i]; s = sma.get(b["t"] // 86400); per = "train" if b["t"] < SPLIT_A else "valid" if b["t"] < SPLIT_B else "final"
            for tr in ("all",) + (() if s is None else (("with" if (dmap[nm] == 1) == (b["c"] > s) else "against"),)):
                groups.setdefault((tf, nm, tr), {"train": [], "valid": [], "final": []})[per].append(r)
        print(f"{tf}: {len(bars)} bars, {len(items)} signals")
    tested, picked = len(groups), []
    for k, g in sorted(groups.items()):
        tr, va, fi = mstats(g["train"]), mstats(g["valid"]), mstats(g["final"])
        if tr and tr["n"] >= 100 and tr["avg_r"] - 3 * tr["se"] > 0 and va and va["n"] >= 30 and va["avg_r"] > 0:
            picked.append({"tf": k[0], "signal": k[1], "trend": k[2], "train": tr, "valid": va, "final": fi, "final_stress_0.2R": mstats(g["final"], 0.2)})
    train_pass = sum(1 for k, g in groups.items() if (m := mstats(g["train"])) and m["n"] >= 100 and m["avg_r"] - 3 * m["se"] > 0)
    print(f"\ncombinations tested: {tested} | pass TRAIN alone (3 sigma): {train_pass} | pass TRAIN + VALIDATION: {len(picked)}")
    print("FINAL TEST of the survivors (never used to choose):")
    for c in picked:
        f, s = c["final"], c["final_stress_0.2R"]
        print(f"  {c['tf']:>3} {c['signal']:<20} {c['trend']:<7} train n={c['train']['n']} avgR={c['train']['avg_r']:+.2f} | valid n={c['valid']['n']} avgR={c['valid']['avg_r']:+.2f} | FINAL n={f['n'] if f else 0} avgR={f['avg_r'] if f else 0:+.2f} win={f['win_pct'] if f else 0}% (0.2R cost: {s['avg_r'] if s else 0:+.2f})")
    allfin = [(k, mstats(g["final"])) for k, g in groups.items() if mstats(g["final"]) and mstats(g["final"])["n"] >= 100]
    pos = sum(1 for k, m in allfin if m["avg_r"] > 0)
    print(f"for comparison, ALL combinations with n>=100 in the final period: {pos} of {len(allfin)} have average R > 0 (about half would be expected by luck alone)")
    trend_following(rows)
    json.dump({"survivors": picked, "tested": tested, "train_pass": train_pass}, open("research_xauusd.json", "w"), indent=1, default=float)


def trend_following(rows):
    """Daily Donchian trend following with its NATURAL exit (not the fixed 1 ATR / 2 ATR rule): enter next open after a close beyond the 55-day high/low,
    initial stop 2 x ATR20, exit when the close breaks the 20-day opposite channel (or the stop). R = result / (2 x ATR20 at entry), cost 0.1R."""
    bars = fd.agg(rows, 86400); n = len(bars); out = {"train": [], "valid": [], "final": []}
    atr = fd.atr_series(bars, 20)
    pos = None
    for i in range(55, n - 1):
        b = bars[i]
        if pos:
            long = pos["d"] == 1; hit = (b["l"] <= pos["stop"]) if long else (b["h"] >= pos["stop"])
            brk = (b["c"] < min(x["l"] for x in bars[i - 20:i])) if long else (b["c"] > max(x["h"] for x in bars[i - 20:i]))
            if hit or brk:
                px = pos["stop"] if hit else bars[i + 1]["o"]
                r = (px - pos["e"]) * pos["d"] / pos["risk"] - COST
                out["train" if pos["t"] < SPLIT_A else "valid" if pos["t"] < SPLIT_B else "final"].append(r); pos = None
        if not pos and atr[i]:
            up, dn = b["c"] > max(x["h"] for x in bars[i - 55:i]), b["c"] < min(x["l"] for x in bars[i - 55:i])
            if up or dn:
                d, e, risk = (1 if up else -1), bars[i + 1]["o"], 2 * atr[i]
                pos = {"d": d, "e": e, "risk": risk, "stop": e - d * risk, "t": bars[i + 1]["t"]}
    print("\nDaily trend following (Donchian 55 in, 20 out, 2 ATR stop), natural exit:")
    for k, v in out.items():
        if v: print(f"  {k:<5} trades {len(v):>3} | win {sum(1 for r in v if r > 0) / len(v) * 100:4.0f}% | average {sum(v) / len(v):+.2f}R | total {sum(v):+.1f}R")


if __name__ == "__main__":
    main(sys.argv[1:])
