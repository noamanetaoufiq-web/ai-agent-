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
