// Team suggestion handler, shared by the Cloudflare Pages Function
// (functions/api/ai/suggest.ts, production) and the Vite dev middleware
// (vite.config.ts, local). It holds the only call to the OpenAI API, so the
// key never leaves the server. Runs on both Node and the Workers runtime.

import OpenAI from "openai";
import type { SuggestRequest, SuggestResponse } from "./suggest-types.ts";

export type SuggestEnv = { OPENAI_API_KEY?: string; OPENAI_MODEL?: string };

const DEFAULT_MODEL = "gpt-5.5";
const MAX_SUGGESTIONS = 3;

// Simple per-address limiter. In-memory, so on Cloudflare it is per isolate:
// enough to blunt a runaway tab, not a substitute for Turnstile on a busy site.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 10;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Kept stable and first in the prompt so OpenAI's automatic prompt caching can reuse it across users.
const SYSTEM_PROMPT = `You are a Pokémon competitive team-building coach for Generation 9 (Scarlet/Violet with its DLC). You suggest Pokémon to add to a partially built team, or to swap in when it is full, so that the finished team plays coherently in the requested format and playstyle.

How to reason:
- Start from the team's goals: the format decides levels and rules (singles is 6v6 at level 100; VGC is doubles, bring 4 of 6, level 50, with Protect and spread moves mattering). The playstyle decides what each slot must do (a Trick Room team wants slow bruisers and a setter, rain wants Swift Swim and Drizzle, stall wants recovery and hazards, and so on).
- Read the coverage analysis you are given as facts. Patch the listed defensive problems and offensive gaps, but never at the cost of the playstyle: a hyper-offense team does not want a wall.
- Respect the ruleset when one is given: only suggest Pokémon and items that are legal under it (restricted Legendary counts, Mythical bans, Paradox bans, item clause) and say so when a pick uses a restricted slot.
- Prefer Pokémon and sets that are actually used in the format. Give every suggestion a concrete, legal set: an ability the species can have, a held item, a nature, a Tera type, EVs that total at most 510 with at most 252 in one stat, and exactly four moves it can learn in this generation.
- Explain each pick in two or three sentences that name what it patches and how it fits the playstyle. Mention one or two alternatives with a similar role.
- Suggest at most the requested number of Pokémon. When the team is already full, suggest replacements and say which member each one replaces.

Output only the JSON described by the schema. Use official English names exactly as Pokémon Showdown spells them (for example "Iron Valiant", "Ogerpon-Wellspring", "Urshifu-Rapid-Strike").`;

const STAT_SCHEMA = {
  type: "object",
  properties: { hp: { type: "integer" }, atk: { type: "integer" }, def: { type: "integer" }, spa: { type: "integer" }, spd: { type: "integer" }, spe: { type: "integer" } },
  required: ["hp", "atk", "def", "spa", "spd", "spe"],
  additionalProperties: false,
} as const;

// Strict-mode schema: every property required, no extras, at every level.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          species: { type: "string" },
          role: { type: "string" },
          why: { type: "string" },
          replaces: { type: "string", description: "Species this replaces when the team is full; empty string otherwise" },
          set: {
            type: "object",
            properties: {
              ability: { type: "string" },
              item: { type: "string" },
              nature: { type: "string" },
              tera_type: { type: "string" },
              evs: STAT_SCHEMA,
              moves: { type: "array", items: { type: "string" } },
            },
            required: ["ability", "item", "nature", "tera_type", "evs", "moves"],
            additionalProperties: false,
          },
          alternatives: { type: "array", items: { type: "string" } },
        },
        required: ["species", "role", "why", "replaces", "set", "alternatives"],
        additionalProperties: false,
      },
    },
    team_notes: { type: "string", description: "Two or three sentences on how the finished team is meant to play" },
  },
  required: ["suggestions", "team_notes"],
  additionalProperties: false,
};

function parseRequest(raw: string): SuggestRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<SuggestRequest>;
  if (!Array.isArray(b.team) || b.team.length > 6) return null;
  if (b.format !== "singles" && b.format !== "vgc") return null;
  return {
    generation: 9,
    format: b.format,
    playstyle: String(b.playstyle ?? "Balance").slice(0, 60),
    ruleset: String(b.ruleset ?? "").slice(0, 600),
    notes: String(b.notes ?? "").slice(0, 1000),
    team: b.team.slice(0, 6).map((m) => ({
      species: String(m?.species ?? "").slice(0, 60),
      types: Array.isArray(m?.types) ? m.types.map(String).slice(0, 2) : [],
      ability: String(m?.ability ?? "").slice(0, 40),
      item: String(m?.item ?? "").slice(0, 40),
      nature: String(m?.nature ?? "").slice(0, 20),
      teraType: String(m?.teraType ?? "").slice(0, 20),
      level: Number(m?.level) || 100,
      evs: m?.evs ?? { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      moves: Array.isArray(m?.moves) ? m.moves.map(String).slice(0, 4) : [],
      baseStats: m?.baseStats ?? null,
      speed: typeof m?.speed === "number" ? m.speed : null,
    })),
    analysis: {
      problems: Array.isArray(b.analysis?.problems) ? b.analysis.problems.slice(0, 18) : [],
      strengths: Array.isArray(b.analysis?.strengths) ? b.analysis.strengths.slice(0, 18) : [],
      uncoveredOffense: Array.isArray(b.analysis?.uncoveredOffense) ? b.analysis.uncoveredOffense.slice(0, 18) : [],
    },
    openSlots: Math.max(0, Math.min(6, 6 - b.team.length)),
  };
}

function userMessage(req: SuggestRequest): string {
  const want = req.openSlots > 0 ? Math.min(MAX_SUGGESTIONS, req.openSlots) : MAX_SUGGESTIONS;
  const mode = req.openSlots > 0 ? `Suggest ${want} Pokémon to fill open slots (the team has ${req.openSlots}).` : `The team is full. Suggest up to ${want} replacements, naming which member each replaces.`;
  const lines = [
    `Format: ${req.format === "vgc" ? "VGC doubles (level 50)" : "Singles 6v6 (level 100)"}`,
    `Playstyle: ${req.playstyle}`,
    req.ruleset ? `Ruleset: ${req.ruleset}` : "",
    req.notes ? `Player's notes: ${req.notes}` : "",
    "",
    "Current team:",
    ...(req.team.length
      ? req.team.map(
          (m) =>
            `- ${m.species} [${m.types.join("/")}] ability ${m.ability || "?"}, item ${m.item || "none"}, ${m.nature || "?"} nature, Tera ${m.teraType || "?"}, EVs ${Object.entries(m.evs)
              .filter(([, v]) => v)
              .map(([k, v]) => `${v} ${k}`)
              .join(" / ") || "none"}, moves: ${m.moves.join(", ") || "none yet"}${m.speed !== null ? `, speed stat ${m.speed}` : ""}`,
        )
      : ["- (empty)"]),
    "",
    "Coverage analysis (computed):",
    `- Defensive problems: ${req.analysis.problems.map((p) => `${p.type} (+${p.net}: ${p.weak.join(", ")})`).join("; ") || "none"}`,
    `- Types the team handles well: ${req.analysis.strengths.join(", ") || "none yet"}`,
    `- Types nothing on the team hits super-effectively with STAB: ${req.analysis.uncoveredOffense.join(", ") || "none"}`,
    "",
    mode,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export async function handleSuggest(rawBody: string, env: SuggestEnv, ip: string): Promise<Response> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return json(500, {
      message: "OPENAI_API_KEY is not configured. Locally, set it in .env and restart the dev server; in production, add it to the Cloudflare project's variables and redeploy.",
    });
  }
  if (rateLimited(ip)) return json(429, { message: `Too many suggestion requests; try again in a few minutes.` });
  const req = parseRequest(rawBody);
  if (!req) return json(400, { message: "Invalid request." });

  const client = new OpenAI({ apiKey });
  try {
    const response = await client.responses.create({
      model: env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
      instructions: SYSTEM_PROMPT,
      input: userMessage(req),
      reasoning: { effort: "high" },
      max_output_tokens: 12000,
      text: { format: { type: "json_schema", name: "team_suggestions", schema: OUTPUT_SCHEMA, strict: true } },
    });
    if (response.status === "incomplete") return json(502, { message: `The suggestion was cut off (${response.incomplete_details?.reason ?? "unknown reason"}); try again.` });
    const refusal = response.output.find((item) => item.type === "message")?.content.find((c) => c.type === "refusal");
    if (refusal) return json(502, { message: `The model declined this request: ${refusal.refusal}` });
    let parsed: SuggestResponse;
    try {
      parsed = JSON.parse(response.output_text) as SuggestResponse;
    } catch {
      return json(502, { message: "The model returned something that was not valid JSON; try again." });
    }
    parsed.suggestions = (parsed.suggestions ?? []).slice(0, MAX_SUGGESTIONS);
    return json(200, {
      ...parsed,
      usage: { input: response.usage?.input_tokens ?? 0, cached: response.usage?.input_tokens_details?.cached_tokens ?? 0, output: response.usage?.output_tokens ?? 0 },
    });
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) return json(401, { message: "The OpenAI API key was rejected. Check OPENAI_API_KEY." });
    if (err instanceof OpenAI.RateLimitError) return json(429, { message: "The OpenAI API is rate limiting requests (or the account is out of credit); try again shortly." });
    if (err instanceof OpenAI.APIError) return json(502, { message: `OpenAI API error ${err.status}: ${err.message}` });
    return json(500, { message: err instanceof Error ? err.message : "Something went wrong." });
  }
}
