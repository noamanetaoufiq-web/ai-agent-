Put your XAUUSD history here (1-minute or 5-minute candles, CSV or CSV.GZ), then run the "Update data" workflow.
  XAUUSD_5m.csv.gz   -> spot gold (price-action signals are replayed on it)
  GC_5m.csv.gz       -> gold futures (order flow needs real volume)    NQ_5m.csv.gz -> Nasdaq futures
Timestamps are read as UTC. Other timezone: add it to the file name, e.g. XAUUSD_1m_utc-5.csv (HistData) or _utc+2.
Layouts understood: MetaTrader 5 export, HistData, Dukascopy, TradingView (unix time), or "datetime,open,high,low,close[,volume]".
Daily or hourly files cannot be used (the backtest needs 5-minute or finer candles). Keep each file under 100 MB (gzip it).
