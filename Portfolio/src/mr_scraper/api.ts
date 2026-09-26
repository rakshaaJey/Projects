// Thin client for MarvelRivalsAPI.com.
//
// Requests go through `/api/mr/*`, which is proxied to
// https://marvelrivalsapi.com/api/* with the `x-api-key` header attached
// server-side (see vite.config.ts for dev/preview and functions/api/mr for production).

import { ApiError, requestJson, type RequestOptions } from "../shared/http.ts";

export { ApiError };
export type { RequestOptions };

export const MR_PROXY_BASE = "/api/mr";

export type MrPlayer = { uid: string; name: string };

export type MrHero = {
  hero_id: number;
  hero_name: string;
  hero_type?: string;
  play_time?: number | string;
  kills?: number;
  deaths?: number;
  assists?: number;
};

/** One entry of the player's match history (v2). Only the fields we read. */
export type MrMatch = {
  match_uid: string;
  match_map_id: number;
  match_season?: string | number;
  match_time_stamp: number; // Unix seconds
  play_mode_id?: number;
  game_mode_id: number;
  game_mode_name?: string;
  match_winner_side?: number;
  match_player: {
    player_uid?: string | number;
    kills?: number;
    deaths?: number;
    assists?: number;
    // v1 nests the flag in an object; v2 may send a plain boolean.
    is_win?: boolean | { is_win?: boolean; score?: number };
    camp?: number | string;
    player_hero?: MrHero;
    player_heroes?: MrHero[];
  };
};

export type MrMap = {
  id: number;
  name: string;
  full_name?: string;
  location?: string;
  game_mode?: string; // "Domination" | "Convoy" | "Convergence" | ...
  is_competitve?: boolean;
};

// Friendly text for statuses this API is known to return.
const FRIENDLY: Record<number, string> = {
  401: "The API key is missing or invalid. Locally, set MARVELRIVALS_API_KEY in .env and restart the dev server; in production, set it in the Cloudflare project's variables and redeploy.",
  404: "Player not found. Check the username.",
  500: "The server-side API key is not configured. Set MARVELRIVALS_API_KEY in the Cloudflare project's variables and redeploy.",
  502: "MarvelRivalsAPI.com is not responding right now. Try again in a few minutes.",
};

const extractError = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { message?: unknown; error?: unknown; errors?: { message?: unknown }[] };
  const candidate = b.message ?? b.error ?? b.errors?.[0]?.message;
  return typeof candidate === "string" ? candidate : undefined;
};

async function get<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body } = await requestJson<T>(`${MR_PROXY_BASE}${path}`, { ...options, friendly: FRIENDLY, extractError });
  return body;
}

export async function findPlayer(username: string, options: RequestOptions = {}): Promise<MrPlayer> {
  const body = await get<{ uid?: string | number; name?: string; player?: { uid?: string | number; name?: string } }>(
    `/v2/find-player/${encodeURIComponent(username)}`,
    options,
  );
  const uid = body.uid ?? body.player?.uid;
  const name = body.name ?? body.player?.name ?? username;
  if (uid === undefined || uid === null || uid === "") throw new ApiError("Player not found. Check the username.", 404);
  return { uid: String(uid), name };
}

const PAGE_SIZE = 40;

/**
 * Fetches the player's match history for the current season across every game
 * mode (`game_mode=0`), newest first, walking pages until the API reports no
 * more or `maxPages` is reached.
 */
export async function fetchMatchHistory(
  uid: string,
  options: RequestOptions & { maxPages?: number; season?: string; onPage?: (fetched: number, total: number | null) => void } = {},
): Promise<MrMatch[]> {
  const { maxPages = 5, season, onPage, ...requestOptions } = options;
  const matches: MrMatch[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ game_mode: "0", page: String(page), limit: String(PAGE_SIZE) });
    if (season) query.set("season", season);
    const body = await get<{
      match_history?: MrMatch[];
      matches?: MrMatch[];
      pagination?: { has_more?: boolean; total_matches?: number; total_pages?: number };
    }>(`/v2/player/${encodeURIComponent(uid)}/match-history?${query}`, requestOptions);
    const batch = body.match_history ?? body.matches ?? [];
    for (const m of batch) {
      if (m?.match_uid && seen.has(m.match_uid)) continue;
      if (m?.match_uid) seen.add(m.match_uid);
      matches.push(m);
    }
    const total = body.pagination?.total_matches ?? null;
    onPage?.(matches.length, total);
    const hasMore = body.pagination?.has_more ?? batch.length >= PAGE_SIZE;
    if (!hasMore || batch.length === 0) break;
  }
  return matches;
}

/** Fetches every map with its objective mode (Domination / Convoy / Convergence / ...). */
export async function fetchMaps(options: RequestOptions = {}): Promise<MrMap[]> {
  const maps: MrMap[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await get<{ maps?: MrMap[]; data?: MrMap[]; total_maps?: number; total_pages?: number }>(
      `/v1/maps?page=${page}&limit=100`,
      options,
    );
    const batch = body.maps ?? body.data ?? [];
    maps.push(...batch);
    const totalPages = body.total_pages ?? 1;
    if (batch.length === 0 || page >= totalPages) break;
  }
  return maps;
}
