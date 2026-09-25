// Cloudflare Pages Function: proxies /api/henrik/* to the HenrikDev API and
// attaches the API key from the HENRIKDEV_API_KEY environment variable, so the
// key never reaches the browser. Mirrors the Vite dev/preview proxy in
// vite.config.ts.
//
// Set HENRIKDEV_API_KEY under the Pages project's Settings -> Environment variables.

type PagesContext = {
  request: Request;
  env: { HENRIKDEV_API_KEY?: string };
  params: { path?: string | string[] };
};

const UPSTREAM = "https://api.henrikdev.xyz";

export const onRequestGet = async ({ request, env, params }: PagesContext): Promise<Response> => {
  if (!env.HENRIKDEV_API_KEY) {
    return Response.json(
      { errors: [{ code: 0, message: "HENRIKDEV_API_KEY is not configured on the server.", status: 500 }] },
      { status: 500 },
    );
  }

  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const incoming = new URL(request.url);
  const upstream = new URL(`${UPSTREAM}/${segments.map(encodeURIComponent).join("/")}`);
  upstream.search = incoming.search;

  const res = await fetch(upstream.toString(), {
    headers: { Authorization: env.HENRIKDEV_API_KEY, Accept: "application/json" },
  });

  const headers = new Headers({ "Content-Type": res.headers.get("Content-Type") ?? "application/json" });
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
};
