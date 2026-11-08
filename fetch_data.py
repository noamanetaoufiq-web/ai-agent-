#!/usr/bin/env python3
"""Fetch market data from Yahoo Finance's public chart endpoint and write data.json."""
import json, sys, time
from datetime import datetime, timezone
import requests

SYMBOLS = {
    "GC=F": "Gold",
    "EURUSD=X": "EUR/USD",
    "^GSPC": "S&P 500",
    "^IXIC": "Nasdaq",
    "BTC-USD": "Bitcoin",
    "CL=F": "Crude Oil",
}
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ai-control-center/1.0)"}


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


def fetch_symbol(sym, name):
    data = get(URL.format(sym), {"range": "1mo", "interval": "1d"})
    try:
        res = data["chart"]["result"][0]
        closes = res["indicators"]["quote"][0]["close"]
        hist = [
            {"d": datetime.fromtimestamp(t, timezone.utc).strftime("%m-%d"), "c": round(c, 4)}
            for t, c in zip(res["timestamp"], closes) if c is not None
        ]
        price = hist[-1]["c"]
        prev = hist[-2]["c"] if len(hist) > 1 else price
        return {"symbol": sym, "name": name, "price": price,
                "change_pct": round((price - prev) / prev * 100, 2) if prev else 0,
                "history": hist}
    except Exception as e:
        print(f"[x] {sym}: {e}")
        return None


def main():
    markets = []
    for sym, name in SYMBOLS.items():
        print(f"Fetching {sym} ({name})")
        m = fetch_symbol(sym, name)
        if m:
            markets.append(m)
            print(f"  ok: {m['price']} ({m['change_pct']}%)")
    if not markets:
        print("No data fetched; keeping the previous data.json")
        sys.exit(1)
    out = {"updated": datetime.now(timezone.utc).isoformat(), "source": "Yahoo Finance", "markets": markets}
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote data.json with {len(markets)} markets")


if __name__ == "__main__":
    main()
