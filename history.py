"""Local candle history for the backtest.

Put 1-minute or 5-minute candle exports in the `history/` folder (CSV or CSV.GZ). The file name decides the market:
  XAUUSD*.csv -> spot gold (price action only: spot has no real volume)     GC*.csv -> gold futures     NQ*.csv -> Nasdaq futures
Timestamps are read as UTC. If your file is in another timezone add it to the name: XAUUSD_5m_utc-5.csv (HistData is UTC-5, "utc+2" etc.).
Understood layouts (delimiter , ; or tab, header optional): MT5 export (<DATE> <TIME> O H L C ...), HistData (20240102 090000;O;H;L;C;V),
Dukascopy (01.01.2024 00:00:00.000,O,H,L,C,V), TradingView / unix time (seconds or ms), and any "datetime,open,high,low,close[,volume]".
"""
import glob, gzip, os, re
from calendar import timegm
from datetime import datetime

HIST_DIR = "history"
FILE_SYMBOL = {"XAUUSD": "XAUUSD=X", "GC": "GC=F", "NQ": "NQ=F"}
_FMTS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M", "%Y.%m.%d %H:%M:%S", "%Y.%m.%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M",
         "%Y%m%d %H%M%S", "%Y%m%d %H:%M:%S", "%d.%m.%Y %H:%M:%S.%f", "%d.%m.%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M"]
_fmt = [None]


def _time(s):
    s = s.strip().strip('"')
    if re.fullmatch(r"\d{9,13}", s):
        v = int(s)
        return v // 1000 if v > 10 ** 11 else v
    for f in ([_fmt[0]] if _fmt[0] else []) + _FMTS:
        try:
            t = timegm(datetime.strptime(s, f).timetuple()); _fmt[0] = f
            return t
        except ValueError:
            continue
    return None


def _row(parts, flow=False):
    p = [x.strip().strip('"') for x in parts]
    if len(p) < 5:
        return None
    k = 1
    if len(p) >= 6 and re.fullmatch(r"\d{4}[./-]\d{2}[./-]\d{2}", p[0]) and re.fullmatch(r"\d{2}:\d{2}(:\d{2})?", p[1]):
        t, k = _time(p[0] + " " + p[1]), 2                  # date and time in two columns (MT5)
    else:
        t = _time(p[0])
    if t is None:
        return None
    try:
        o, h, l, c = (float(x) for x in p[k:k + 4])
    except ValueError:
        return None
    try:
        v = float(p[k + 4]) if len(p) > k + 4 else 0.0
    except ValueError:
        v = 0.0
    buy = None
    if flow and len(p) > k + 5:                              # flow file: ..., volume, buy_volume (REAL aggressor buy volume)
        try: buy = float(p[k + 5])
        except ValueError: buy = None
    return (t, o, h, l, c, v, buy)


def read_history(path, utc_offset=0, max_gap=300):
    """-> [(t, o, h, l, c, v, buy or None)] sorted by time in UTC, duplicates removed. Raises ValueError when the file is not usable."""
    m = re.search(r"utc([+-]\d+)", os.path.basename(path), re.I)
    off = int(m.group(1)) if m else utc_offset
    opener = gzip.open if path.endswith(".gz") else open
    rows, delim, flow, _fmt[0] = {}, None, False, None
    with opener(path, "rt", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            if not line.strip():
                continue
            if delim is None:
                delim = ";" if ";" in line else "\t" if "\t" in line else ","
                flow = "buy" in line.lower()                 # header like: time,open,high,low,close,volume,buy_volume
            r = _row(line.rstrip("\r\n").split(delim), flow)
            if r:
                rows[r[0] - off * 3600] = (r[0] - off * 3600,) + r[1:]
    out = [rows[k] for k in sorted(rows)]
    if len(out) < 500:
        raise ValueError(f"{os.path.basename(path)}: only {len(out)} readable candles (check the column order: time, open, high, low, close)")
    gaps = sorted(out[i + 1][0] - out[i][0] for i in range(min(len(out) - 1, 2000)))
    if gaps[len(gaps) // 2] > max_gap:
        raise ValueError(f"{os.path.basename(path)}: candles are {gaps[len(gaps) // 2]} s apart, the backtest needs 1-minute or 5-minute data")
    return out


def files(base=HIST_DIR):
    return sorted(glob.glob(os.path.join(base, "*.csv")) + glob.glob(os.path.join(base, "*.csv.gz")))


def symbol_of(path):
    m = re.match(r"(XAUUSD|GC|NQ)", os.path.basename(path), re.I)
    return FILE_SYMBOL[m.group(1).upper()] if m else None


def signature(base=HIST_DIR):
    """Changes when a history file is added, removed or replaced, so the backtest is rebuilt."""
    return ";".join(f"{os.path.basename(p)}:{os.path.getsize(p)}" for p in files(base))


def history_rows(symbol, base=HIST_DIR):
    out = {}
    for p in files(base):
        if symbol_of(p) != symbol:
            continue
        try:
            for r in read_history(p):
                out[r[0]] = r
        except ValueError as e:
            print("  history skipped:", e)
    return [out[k] for k in sorted(out)]
