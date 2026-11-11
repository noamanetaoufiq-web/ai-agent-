# AI Control Center

Static dashboard for GitHub Pages: multi-provider AI chat (with automatic fallback) plus market data refreshed by GitHub Actions.

## Deploy
1. Create a GitHub repo and push all these files to `main`.
2. Settings > Pages > Deploy from branch > `main` / root.
3. Settings > Actions > General > Workflow permissions > Read and write.
4. Actions tab > "Update data" > Run workflow (creates `data.json`).
5. Open your Pages URL. The API Vault opens on first visit; paste your keys.

## Notes
- Keys live only in your browser's localStorage. Use a private device and do not paste keys on shared computers.
- Fallback order: Primary key first, then the other saved keys.
- Browser-direct calls need provider CORS support (OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter work). If one is blocked, use OpenRouter.

## Free API keys: which models work
Model names change often, so do not guess. In **API Vault**, paste the key and press **Check key**: the app asks the provider which models that key can use, fills the Model ID list, and offers a one-click fix if your model is not available.

| Provider | Free? | Safe starting model |
|---|---|---|
| Gemini (aistudio.google.com) | Free tier, rate-limited | `gemini-flash-latest`, `gemini-flash-lite-latest` |
| Groq (console.groq.com) | Free tier, no card | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-20b` |
| OpenRouter | Free models only (`:free`), about 20 req/min, 50/day | `openrouter/free` |
| Mistral | Free "Experiment" plan | `mistral-small-latest` |
| Cohere | Trial key, limited | `command-r` |
| OpenAI, Claude, DeepSeek, Perplexity, Together | Paid / credits | see Check key |

## Chats
Saved in localStorage (`aicc.chats`): your question is saved before the request starts, the answer while it streams, and again when you leave the page. Tabs merge instead of overwriting each other, and unreadable data is copied to `aicc.chats.bak`.

## Refresh rate
Prices refresh in the browser every 60 s (Yahoo direct, public CORS proxy as fallback; if both fail, data.json values stay). The GitHub Action runs every 15 min to rebuild the 30-day history; Actions cannot run every minute (5 min minimum, often delayed).

## Trading agent
- **Modes** (System prompt > Mode): Trading analyst, Order flow, Technical analysis, Risk manager, General. Picking a mode loads its prompt and switches on "read the market data" (General switches it off). You can edit the prompt afterwards.
- `fetch_data.py` adds, per market: RSI14, SMA20/50, ATR14, 30-day high/low, and an **order-flow estimate** ported from `tradingview/Order_Flow_Suite_v2_1_SessionVP.pine` (15m bars from 1m candles: delta, CVD and divergences, Pulse breakouts/traps, imbalance zones, liquidity walls, block trades, Volume Profile POC/VAH/VAL, Daily/Asian/London/NY session profiles).
- It is a **proxy**: an up-close candle counts as buy volume. It is not a footprint or DOM. Yahoo gives no volume for EUR/USD, so that market has no order flow. Yahoo keeps only about 5-7 days of 1m data.
- The Pine script is included for TradingView; it needs a plan that allows lower-timeframe data.

## Setups, confirmation and win rate
- **BTC**: Binance klines give REAL taker (aggressor) volume, so delta and CVD are real. Needs `data-api.binance.vision` to be reachable from GitHub Actions; if not, it falls back to Yahoo and `real_delta` becomes false.
- **Gold (GC) and Nasdaq (NQ) futures**: Yahoo candles, about 10-15 min late (`age_min` shows it). Delta is an estimate. Real CME aggressor data needs a paid feed (e.g. Databento).
- **5m bars** for signals, **1m** only for confirmation (`m1`).
- **Win rate = backtest, never a guess.** `backtest.py` (workflow "Daily backtest": run it once by hand) replays every signal: BTC about 365 days of Binance 5m (real delta), Gold GC / Nasdaq NQ / others about 60 days of Yahoo 5m (Yahoo's limit for 5m). It writes `backtest.json` (stop 1 ATR, target 2 ATR, max 2 h, no fees). Every 15 min `fetch_data.py` attaches to each ACTIVE signal the stats of the same signal + session + with/against the daily trend (`of.match`). "positive" is weak evidence: random data produces some by chance.
- Mode **Setup validator** scores a setup with a 5-check scorecard. After updating, the system prompt is replaced once by the new preset.

## Fresh data at every message
- While the page is open, prices and order flow are recomputed **in the browser every 60 s and again right before each message** (BTC from Binance 1m klines with real taker volume, the others from Yahoo 1m, direct or through a public CORS proxy). If a source fails, the 15-minute `data.json` values stay and `meta` tells the agent how old they are.
- Historical stats (`backtest.json`) are loaded by the page too and matched to the live signals. If the file is missing the agent is told, and the chat shows a warning: run the "Daily backtest" workflow.
- Browser access to Binance/Yahoo (CORS) was not tested here: open the console if `flow` never appears next to "Live".

## Speed and history on first run
- BTC price streams live over a Binance websocket (about every 3 s on screen). Other prices refresh every 15 s, order flow every 60 s and before each message. Gold (GC) and Nasdaq (NQ) from Yahoo stay about 10-15 min behind: that is Yahoo's delay, polling faster cannot fix it.
- "Update data" now builds `backtest.json` by itself when it is missing or older than 24 h (BTC needs a few minutes the first time). After pushing the repo, run "Update data" once and wait for it to finish: from then on the history is already there.

## Gold: analyse GC futures, trade XAUUSD spot
- Order flow, volume profile and the backtest come from **GC futures** (spot has no volume). The workflow also fetches **XAUUSD=X** (spot) and measures the **basis** (GC minus spot) on the same 1-minute candles, then converts every GC level to spot: `of.spot` in the GC market, `of.m1.last_close_spot` live.
- Spot daily history (RSI, SMA, ATR, 30-day range) comes from XAUUSD=X itself (Yahoo has it from 2003).
- Basis jumps when the futures contract rolls (every ~2 months) and moves with interest rates. Check `basis_spread` and do not trade spot levels converted across a roll.

## Swarm (button "Swarm" in the header)
Browser port of the Trading Swarm pipeline (the zip you sent): Macro/News -> Technical -> Orchestrator (LLM agents, JSON out) -> **Inspector** (code: R:R, confidence, stop 0.5-4 ATR, spread/stop, levels within 30 ATR of the live price, data age, news freeze, macro alignment, lot sizing with costs) -> **Backtest gate** (`of.match`) -> **Trade validator** (block-bootstrap Monte Carlo of real 5m bars, 10/100/1000/5000 runs, vs luck and break-even) -> LLM audit (veto only). Code decides; the LLM can only veto. Output: APPROVED / APPROVED_REDUCED / REJECTED / WAIT with lots and risk, and a button to post the report in the chat. Analysis only: it sends nothing to a broker.
- Lot values (USD per 1.0 move per lot, spread, min lot) are typical CFD numbers: check them with your broker in the "Instrument specs" box.
- It needs `backtest.json` (history) to approve anything: no historical evidence = no trade.
- Optional Cloudflare Worker (`cloudflare/worker.js`) as a faster, more reliable Yahoo proxy for the browser: paste its URL in Access > Proxy URL.

## Price-action confirmation (v2)
- New signals, computed on confirmed 5m bars in `fetch_data.py` and, with identical results, in the browser: **Bullish/Bearish engulfing**, **Hammer / Shooting star**, **SSL sweep / BSL sweep** (liquidity taken beyond a swing low / high, closed back inside), **SSL/BSL sweep+reversal** (sweep + reversal candle + order-flow delta in that direction). `of.structure` gives the 5m swing read (HH+HL / LH+LL), the last swing high/low and the nearest unswept BSL / SSL (converted to spot for XAUUSD).
- All of them are replayed by `backtest.py` (BTC ~365 days of 5m, others ~60 days), so each has its own win rate, 95% interval and last-30% check.
- Swarm now has a **Confirmation (code)** step: 7 checks (sweep, reversal candle, order flow, 1-minute confirmation, 5m structure, daily trend, entry at a key level). A trade needs a trigger (sweep or reversal candle) and at least "Min confirmations" (default 4/7) before the backtest gate and the Monte Carlo run.

## How the edge is judged (important)
`edge` = **positive** only when the interval of the average R per trade, net of an assumed 0.1R cost, is above 0 **and** the last 30% of the data is also above 0. Tested on random-walk data: 0 of 86 signals came out positive in 3 runs (the first version, which counted small timeout gains as wins, gave false positives, so it was replaced). Real markets can still fool any backtest: signals cluster in time, spreads vary, and the past may not repeat.

## XAUUSD spot backtest and your own history (history/ folder)
- Spot gold has no real volume, so on **XAUUSD=X** the backtest replays only the **price-action signals** (engulfing, hammer / shooting star, SSL / BSL sweeps, sweep+reversal without the delta condition) on the spot candles you trade. Yahoo gives about 60 days of 5m; for more, drop your own export in `history/` (see `history/README.txt`). The workflow rebuilds the backtest when a history file is added or changed.
- Gold order flow still comes from GC futures. Each active GC signal in `of.match` carries a `spot` entry with the same signal measured on spot; Swarm uses it for XAUUSD.
- Tested: 5 file layouts parse to identical candles; 3 years of 5m (315k candles) -> 91k signals, all 8 spot signals above 1000 samples, 10 s.

## Research on 10 years of real XAUUSD (research_xauusd.py)
`python research_xauusd.py XAUUSDm15.csv` (the m15 file of the `historical-data` repo: 2012-05 to 2022-03, prices x100, tick volume only; scaling is detected). Walk-forward: TRAIN 2012-2017 picks, VALIDATION 2018-2019 confirms, FINAL 2020-2022 is the honest estimate. Fixed rule, never tuned: stop 1 ATR, target 2 ATR, 24 bars, cost 0.1R.
Result on 144 combinations (8 price-action signals + previous-day high/low sweeps, on 15m/30m/1h/4h, with/against the daily trend): **1 passed train + validation and it lost -0.35R per trade in the final test; only 8 of 92 combinations were positive after costs in the final period.** On spot gold these signals alone had no edge. The `xauusd-backtest` repo's "70% win rate" is not an edge either: run on the same data its own recorded trades make +1.6 USD over 4714 trades before spread (average win +0.43 USD, average loss -1.52 USD).
