// Cloudflare Pages Function: serves /api/mr/* in PRODUCTION (and preview
// deployments) by proxying to rivalsmeta.com's JSON API, which needs no key.
// Proxying keeps the page same-origin and lets the upstream be swapped
// without a client change.
//
// Optional configuration (Workers & Pages -> <project> -> Settings -> Variables and Secrets):
//   MARVELRIVALS_API_BASE  (defaults to https://rivalsmeta.com/api;
//                           https://api.rivalstracker.com/api serves the same data)
//
// Locally, the equivalent proxy lives in vite.config.ts.

type PagesContext = {
  request: Request;
  env: { MARVELRIVALS_API_BASE?: string };
  params: { path?: string | string[] };
};

const DEFAULT_UPSTREAM = "https://rivalsmeta.com/api";

// Browser-like headers: the upstream is a public website API, not a documented service.
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function proxy({ request, env, params }: PagesContext): Promise<Response> {
  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const incoming = new URL(request.url);
  const base = (env.MARVELRIVALS_API_BASE?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, "");
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
