// Cloudflare Pages Function: serves /api/mra/* in PRODUCTION (and preview
// deployments) by proxying to MarvelRivalsAPI.com with the API key attached,
// so the key never reaches the browser.
//
// Configuration comes from the Cloudflare project, not from `.env`:
//   Workers & Pages -> <project> -> Settings -> Variables and Secrets
//     MARVELRIVALS_API_KEY   (required; add as a Secret, for Production and/or Preview)
//     MARVELRIVALS_API_BASE  (optional; defaults to https://marvelrivalsapi.com/api)
// Variables apply to the next deployment, so redeploy after adding them.
//
// Without a key this answers 500 with a JSON message, and the page falls back
// to rivalsmeta.com (functions/api/mr) on its own.
//
// Locally, the equivalent proxy lives in vite.config.ts and reads `.env`.

type PagesContext = {
  request: Request;
  env: { MARVELRIVALS_API_KEY?: string; MARVELRIVALS_API_BASE?: string };
  params: { path?: string | string[] };
};

const DEFAULT_UPSTREAM = "https://marvelrivalsapi.com/api";

const jsonError = (status: number, message: string) => Response.json({ message, status }, { status });

export const onRequestGet = async ({ request, env, params }: PagesContext): Promise<Response> => {
  const key = env.MARVELRIVALS_API_KEY?.trim();
  if (!key) {
    return jsonError(
      500,
      "MARVELRIVALS_API_KEY is not configured for this deployment. Add it under the Cloudflare Pages project's Settings -> Variables and Secrets, then redeploy.",
    );
  }

  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const incoming = new URL(request.url);
  const base = (env.MARVELRIVALS_API_BASE?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const upstream = new URL(`${base}/${segments.map(encodeURIComponent).join("/")}`);
  upstream.search = incoming.search;

  const res = await fetch(upstream.toString(), {
    headers: { "x-api-key": key, Accept: "application/json" },
  });

  const headers = new Headers({ "Content-Type": res.headers.get("Content-Type") ?? "application/json" });
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
};
