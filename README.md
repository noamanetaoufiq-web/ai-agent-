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
