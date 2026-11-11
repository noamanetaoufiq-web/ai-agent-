#!/usr/bin/env python3
"""Walk-forward research on long XAUUSD candle history (15m or finer). Usage: python research_xauusd.py <file.csv> [more files]
Signals: the 8 price-action signals of the engine (price only) + previous-day high/low sweeps, on 15m / 30m / 1h / 4h bars, each with/against the daily trend.
Fixed rule (never tuned): enter next bar open, stop 1 ATR14, target 2 ATR, max 24 bars, cost 0.1R (0.2R shown as stress).
Protocol: TRAIN picks candidates (average R net of cost, 3-sigma lower bound above 0, n>=100), VALIDATION must confirm (mean above 0, n>=30),
FINAL TEST (never used to choose) is the honest estimate. Prices scaled x100 in some exports are detected automatically."""
import json, sys
from datetime import datetime, timezone
import fetch_data as fd, history as hist, backtest as bt

TFS = {"15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
SPLIT_A, SPLIT_B = datetime(2018, 1, 1, tzinfo=timezone.utc).timestamp(), datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
PD_DIR = {"PDL sweep": 1, "PDH sweep": -1, "PDL sweep+bias": 1, "PDH sweep+bias": -1}
RR, COST = 2.0, 0.1


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
        items = fd.simulate(bars, rr=RR, flow=False, extra=pd_sweeps(bars), dirs=PD_DIR)
        dmap = {**fd.SIG_DIR, **PD_DIR}
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
    json.dump({"survivors": picked, "tested": tested, "train_pass": train_pass}, open("research_xauusd.json", "w"), indent=1, default=float)


if __name__ == "__main__":
    main(sys.argv[1:])
