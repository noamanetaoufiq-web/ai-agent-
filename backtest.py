#!/usr/bin/env python3
"""Daily backtest -> backtest.json. Replays every order-flow signal on the longest history available:
BTC: up to 365 days of Binance 5m klines (REAL taker delta). Others: Yahoo 5m, about 60 days (Yahoo's limit; delta is an estimate).
Stats are grouped by signal, and by signal + session (UTC) + with/against the daily trend (price vs SMA20 of daily closes)."""
import json, sys
from datetime import datetime, timezone
import fetch_data as fd
import history as hist

RR = 2.0
PRICE_ONLY = {"XAUUSD=X"}   # spot gold has no real volume: only price-action signals are tested on it


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
            flow, older = sym not in PRICE_ONLY, hist.history_rows(sym)
            if older:                                           # your own longer history + the recent Yahoo candles
                rows = [r for r in older if r[0] < rows[0][0]] + rows
                print(f"{sym}: {len(older)} candles from the history folder merged")
            if not flow:
                rows = [(t, o, h, l, c, 0, None) for t, o, h, l, c, v, b in rows]   # no pretend volume on spot
            bars = fd.agg(rows, fd.TF)
            if len(bars) < 500 or (flow and sum(b["v"] for b in bars) <= 0):
                print(f"{sym}: no usable volume, skipped"); continue
            n, sma, items = len(bars), daily_sma20(bars), fd.simulate(bars, rr=RR, flow=flow)
            overall, cells = {}, {}
            for nm in (fd.SIG_DIR if flow else [x for x in fd.SIG_DIR if not x.startswith(("Pulse", "Trapped", "CVD"))]):
                st = fd.summarize([(i, r) for i, x, r in items if x == nm], n, RR, z=2.58)
                if st: overall[nm] = st
            for i, nm, r in items:                      # many cells -> stricter 99.9% interval
                s = sma.get(bars[i]["t"] // 86400)
                if s is None: continue
                tr = "with" if (fd.SIG_DIR[nm] == 1) == (bars[i]["c"] > s) else "against"
                cells.setdefault(f"{nm}|{fd.session_of(bars[i]['t'])}|{tr}", []).append((i, r))
            rows_out = {k: st for k, v in cells.items() if len(v) >= 30 and (st := fd.summarize(v, n, RR, z=3.29))}
            markets[sym] = {"name": name, "basis": "price action only (spot has no volume), 5m" if not flow else "real taker delta, Binance 5m" if real else "candle-direction delta, Yahoo 5m",
                            "history_candles": len(older) if older else 0, "history_real_flow": any(r[6] is not None for r in older[:2000]),
                            "bars": n, "days": round((bars[-1]["t"] - bars[0]["t"]) / 86400), "signals_tested": len(items), "overall": overall, "rows": rows_out}
            print(f"{sym}: {n} bars, {markets[sym]['days']} days, {len(items)} signals, {len(rows_out)} cells with n>=30")
        except Exception as e:
            print(f"{sym}: failed: {e}")
    if not markets:
        raise SystemExit("nothing computed; keeping the previous backtest.json")
    out = {"generated": datetime.now(timezone.utc).isoformat(), "history_sig": hist.signature(), "rule": {"entry": "next bar open", "stop": "1 x ATR14(5m)", "target": f"{RR} x ATR", "max_bars": 24, "cost_r": fd.COST_R, "edge_test": "mean R net of cost, interval above 0 and last 30% of the data above 0 (99% for each signal, 99.9% for each cell)"}, "markets": markets}
    with open("backtest.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("Wrote backtest.json")


def fresh(hours=24):
    try:
        with open("backtest.json", encoding="utf-8") as f:
            d = json.load(f)
            age = datetime.now(timezone.utc) - datetime.fromisoformat(d["generated"])
        return age.total_seconds() < hours * 3600 and d.get("history_sig", "") == hist.signature()   # a new history file triggers a rebuild
    except Exception:
        return False


if __name__ == "__main__":
    if "--if-stale" in sys.argv and fresh():
        print("backtest.json is less than 24 h old, skipped")
    else:
        run()
