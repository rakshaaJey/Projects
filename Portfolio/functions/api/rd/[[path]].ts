// Cloudflare Pages Function: serves /api/rd/* in PRODUCTION (and preview
// deployments) by proxying to rivalsdata.com's JSON API, which needs no key.
// Proxying keeps the page same-origin and lets the upstream be swapped without
// a client change.
//
// The host sits behind Cloudflare's bot check, which turns away requests
// without a browser User-Agent (one is attached here) and, from a developer
// machine, also keys on the TLS handshake: Node's HTTPS stack is challenged
// while the system curl passes (see vite.config.ts). Whether the Workers
// runtime's fetch passes that check has NOT been verified yet (2026-10-07):
// check /api/rd/stats/tierlist on a preview deployment. If it answers with a
// 403 challenge page, the page notices and falls back to rivalsmeta.com on
// its own, so nothing breaks, but the better source is lost in production.
//
// Optional configuration (Workers & Pages -> <project> -> Settings -> Variables and Secrets):
//   RIVALSDATA_API_BASE  (defaults to https://api.rivalsdata.com)
//
// Locally, the equivalent proxy lives in vite.config.ts.

type PagesContext = {
  request: Request;
  env: { RIVALSDATA_API_BASE?: string };
  params: { path?: string | string[] };
};

const DEFAULT_UPSTREAM = "https://api.rivalsdata.com";

// Browser-like headers: the upstream is a public website API, not a documented service.
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function proxy({ request, env, params }: PagesContext): Promise<Response> {
  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const incoming = new URL(request.url);
  const base = (env.RIVALSDATA_API_BASE?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const upstream = new URL(`${base}/${segments.map(encodeURIComponent).join("/")}`);
  upstream.search = incoming.search;

  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers["Content-Type"] = contentType;

  const res = await fetch(upstream.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });

  const out = new Headers({ "Content-Type": res.headers.get("Content-Type") ?? "application/json" });
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export const onRequestGet = proxy;
export const onRequestPost = proxy;
