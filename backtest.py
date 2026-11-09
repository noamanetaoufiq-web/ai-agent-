#!/usr/bin/env python3
"""Daily backtest -> backtest.json. Replays every order-flow signal on the longest history available:
BTC: up to 365 days of Binance 5m klines (REAL taker delta). Others: Yahoo 5m, about 60 days (Yahoo's limit; delta is an estimate).
Stats are grouped by signal, and by signal + session (UTC) + with/against the daily trend (price vs SMA20 of daily closes)."""
import json
from datetime import datetime, timezone
import fetch_data as fd

RR = 2.0


def daily_sma20(bars):
    closes = {}
    for b in bars:
        closes[b["t"] // 86400] = b["c"]            # last close of each UTC day
    ds = sorted(closes)
    return {d: sum(closes[x] for x in ds[k - 20:k]) / 20 for k, d in enumerate(ds) if k >= 20}   # previous 20 completed days


def run():
    markets = {}
    for sym, name in fd.SYMBOLS.items():
        try:
            pair, rows, real = fd.CRYPTO.get(sym), [], False
            if pair:
                rows = fd.binance_rows(pair, "5m", 105120); real = bool(rows)
            if not rows:
                rows = fd.yahoo_rows(sym, "5m", "60d")
            bars = fd.agg(rows, fd.TF)
            if len(bars) < 500 or sum(b["v"] for b in bars) <= 0:
                print(f"{sym}: no usable volume, skipped"); continue
            n, sma, items = len(bars), daily_sma20(bars), fd.simulate(bars, rr=RR)
            overall, cells = {}, {}
            for nm in fd.SIG_DIR:
                st = fd.summarize([(i, r) for i, x, r in items if x == nm], n, RR)
                if st: overall[nm] = st
            for i, nm, r in items:                      # many cells -> stricter 99.9% interval
                s = sma.get(bars[i]["t"] // 86400)
                if s is None: continue
                tr = "with" if (fd.SIG_DIR[nm] == 1) == (bars[i]["c"] > s) else "against"
                cells.setdefault(f"{nm}|{fd.session_of(bars[i]['t'])}|{tr}", []).append((i, r))
            rows_out = {k: st for k, v in cells.items() if len(v) >= 30 and (st := fd.summarize(v, n, RR, z=3.29))}
            markets[sym] = {"name": name, "basis": "real taker delta, Binance 5m" if real else "candle-direction delta, Yahoo 5m",
                            "bars": n, "days": round((bars[-1]["t"] - bars[0]["t"]) / 86400), "signals_tested": len(items), "overall": overall, "rows": rows_out}
            print(f"{sym}: {n} bars, {markets[sym]['days']} days, {len(items)} signals, {len(rows_out)} cells with n>=30")
        except Exception as e:
            print(f"{sym}: failed: {e}")
    if not markets:
        raise SystemExit("nothing computed; keeping the previous backtest.json")
    out = {"generated": datetime.now(timezone.utc).isoformat(), "rule": {"entry": "next bar open", "stop": "1 x ATR14(5m)", "target": f"{RR} x ATR", "max_bars": 24, "fees": "none", "breakeven_win_pct": round(100 / (1 + RR), 1)}, "markets": markets}
    with open("backtest.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("Wrote backtest.json")


if __name__ == "__main__":
    run()
