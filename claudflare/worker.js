// Cloudflare Worker: tiny CORS proxy for Yahoo Finance chart data ONLY (free plan is enough).
// Deploy: dash.cloudflare.com > Workers & Pages > Create > paste this > Deploy. Then put the worker URL in "Proxy URL" (Access section of the app).
// Optional: add a variable ALLOW_ORIGIN = https://<user>.github.io so only your site can use it.
const OK = /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\//;
export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET', 'Cache-Control': 'public, max-age=10' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(req.url).searchParams.get('url');
    if (!target || !OK.test(target)) return new Response('forbidden', { status: 403, headers: cors });
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aicc-proxy/1.0)' } });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
