// Cloudflare Pages Function: POST /api/ai/suggest in PRODUCTION (and preview
// deployments). The handler itself lives in src/server/suggest.ts so the dev
// server can run the same code.
//
// Configuration (Workers & Pages -> <project> -> Settings -> Variables and Secrets):
//   OPENAI_API_KEY  (required; add as a Secret, for Production and/or Preview)
//   OPENAI_MODEL    (optional; defaults to gpt-5.5)
// Variables apply to the next deployment, so redeploy after adding them.

import { handleSuggest, type SuggestEnv } from "../../../src/server/suggest.ts";

type PagesContext = { request: Request; env: SuggestEnv };

export const onRequestPost = async ({ request, env }: PagesContext): Promise<Response> =>
  handleSuggest(await request.text(), env, request.headers.get("cf-connecting-ip") ?? "unknown");
