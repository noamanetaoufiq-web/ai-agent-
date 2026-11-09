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
