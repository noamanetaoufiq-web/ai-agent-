#!/usr/bin/env python3
"""Trades CSV -> 5-minute candles with REAL aggressor volume, for the order-flow backtest of GC / NQ.

Usage:  python flow_import.py trades.csv[.gz] GC      ->  history/GC_5m_flow.csv.gz     (second argument: GC or NQ, becomes the file name)
Input:  a trade-by-trade CSV with a header and the columns ts_event (or ts_recv), price, size, side, e.g. the Databento "trades" schema
        (dataset GLBX.MDP3, continuous symbol like GC.v.0 so the contract roll is handled). Read the cost estimate in the Databento portal
        BEFORE you buy: tick data for a year of gold is large.
side:   B = the BUYER was the aggressor (buy volume), A = the SELLER was the aggressor (sell volume), N / empty = unknown (split 50/50).
        This follows the Databento documentation as I remember it: check it against the schema page and a sample before trusting the output.
Prices written as integers with 9 implied decimals (raw Databento fixed-point) are detected and converted.
Memory use is small: the file is streamed and only one candle per 5 minutes is kept."""
import csv, gzip, sys, os
from calendar import timegm
from datetime import datetime, timezone

TF = 300


def open_text(path):
    return gzip.open(path, "rt", encoding="utf-8-sig", newline="") if path.endswith(".gz") else open(path, "rt", encoding="utf-8-sig", newline="")


def convert(path, name, out_dir="history"):
    bars, last_s, last_t, scale = {}, None, 0, None
    with open_text(path) as f:
        rd = csv.reader(f); head = [h.strip().lower() for h in next(rd)]
        col = lambda *names: next((head.index(n) for n in names if n in head), None)
        it, ip, iz, isd = col("ts_event", "ts_recv", "time", "timestamp"), col("price"), col("size", "volume", "qty"), col("side")
        if None in (it, ip, iz, isd):
            raise SystemExit(f"need columns ts_event, price, size, side; found: {head}")
        for row in rd:
            try:
                ts = row[it].strip()
                if ts[:19] != last_s:
                    last_s = ts[:19]
                    last_t = timegm(datetime.strptime(last_s.replace("T", " "), "%Y-%m-%d %H:%M:%S").timetuple()) if "-" in last_s else int(ts) // 10 ** 9
                px, sz, sd = float(row[ip]), float(row[iz]), row[isd].strip().upper()
            except (ValueError, IndexError):
                continue
            if scale is None:
                scale = 1e9 if px > 1e6 else 1.0                     # raw fixed-point prices carry 9 implied decimals
            px /= scale
            k = last_t - last_t % TF
            b = bars.get(k)
            if b is None:
                bars[k] = [px, px, px, px, sz, sz if sd == "B" else sz / 2 if sd not in ("A", "S") else 0.0]
            else:
                b[1] = max(b[1], px); b[2] = min(b[2], px); b[3] = px; b[4] += sz
                b[5] += sz if sd == "B" else sz / 2 if sd not in ("A", "S") else 0.0
    if not bars:
        raise SystemExit("no readable trades")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{name}_5m_flow.csv.gz")
    with gzip.open(out, "wt", encoding="utf-8") as g:
        g.write("time,open,high,low,close,volume,buy_volume\n")
        for k in sorted(bars):
            o, h, l, c, v, buy = bars[k]
            g.write(f"{datetime.fromtimestamp(k, timezone.utc):%Y-%m-%d %H:%M:%S},{o:.4f},{h:.4f},{l:.4f},{c:.4f},{v:.0f},{buy:.1f}\n")
    print(f"{len(bars)} five-minute candles -> {out}")
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    convert(sys.argv[1], sys.argv[2].upper())
