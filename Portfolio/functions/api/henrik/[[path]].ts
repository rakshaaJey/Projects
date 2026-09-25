// Cloudflare Pages Function: serves /api/henrik/* in PRODUCTION (and preview
// deployments) by proxying to the HenrikDev API with the key attached, so the
// key never reaches the browser.
//
// Configuration comes from the Cloudflare project, not from `.env`:
//   Workers & Pages -> <project> -> Settings -> Variables and Secrets
//     HENRIKDEV_API_KEY   (required; add as a Secret, for Production and/or Preview)
//     HENRIKDEV_API_BASE  (optional; defaults to https://api.henrikdev.xyz)
// Variables apply to the next deployment, so redeploy after adding them.
//
// Locally, the equivalent proxy lives in vite.config.ts and reads `.env`.

type PagesContext = {
  request: Request;
  env: { HENRIKDEV_API_KEY?: string; HENRIKDEV_API_BASE?: string };
  params: { path?: string | string[] };
};

const DEFAULT_UPSTREAM = "https://api.henrikdev.xyz";

const jsonError = (status: number, message: string) =>
  Response.json({ errors: [{ code: 0, message, status, details: null }] }, { status });

export const onRequestGet = async ({ request, env, params }: PagesContext): Promise<Response> => {
  const key = env.HENRIKDEV_API_KEY?.trim();
  if (!key) {
    return jsonError(
      500,
      "HENRIKDEV_API_KEY is not configured for this deployment. Add it under the Cloudflare Pages project's Settings -> Variables and Secrets, then redeploy.",
    );
  }

  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const incoming = new URL(request.url);
  const base = (env.HENRIKDEV_API_BASE?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const upstream = new URL(`${base}/${segments.map(encodeURIComponent).join("/")}`);
  upstream.search = incoming.search;

  const res = await fetch(upstream.toString(), {
    headers: { Authorization: key, Accept: "application/json" },
  });

  const headers = new Headers({ "Content-Type": res.headers.get("Content-Type") ?? "application/json" });
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
};
