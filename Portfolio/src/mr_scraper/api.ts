// Client for the JSON API behind rivalsmeta.com (the same API also serves
// rivalstracker.com at https://api.rivalstracker.com/api). It needs no API key.
//
// Requests go through `/api/mr/*`, which is proxied to https://rivalsmeta.com/api
// (see vite.config.ts for dev/preview and functions/api/mr for production).
//
// Endpoints used (undocumented, observed from the site itself):
//   POST /find-player            body {"name": "..."}   -> [{aid, name, cur_head_icon_id}, ...]
//   GET  /player/{aid}?season=N  (no season = current)  -> profile + last 20 matches of that season

import { ApiError, requestJson, type RequestOptions } from "../shared/http.ts";

export { ApiError };
export type { RequestOptions };

export const MR_PROXY_BASE = "/api/mr";

export type MrPlayer = {
  uid: string;
  name: string;
  /** How many players the name search returned; >1 means the exact match was picked from a list. */
  candidates: number;
};

/** One entry of `match_history`. Only the fields we read. */
export type MrMatch = {
  match_uid: string;
  match_map_id: number;
  match_season: string;
  match_time_stamp: number; // Unix seconds
  play_mode_id: number;
  game_mode_id: number;
  match_winner_side?: number;
  match_player: {
    player_uid?: number;
    k?: number;
    d?: number;
    a?: number;
    is_win?: number | boolean | { is_win?: boolean };
    camp?: number;
    player_hero?: { hero_id: number };
  };
};

export type MrPlayerSeason = {
  player?: { _id?: number; info?: { name?: string; rank_game_season?: Record<string, string> } };
  stats?: { total_matches?: number; ranked_matches?: number; unranked_matches?: number };
  match_history?: MrMatch[];
};

const FRIENDLY: Record<number, string> = {
  404: "Player not found.",
  502: "The stats site is not responding right now. Try again in a few minutes.",
  503: "The stats site is not responding right now. Try again in a few minutes.",
};

const extractError = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { message?: unknown; error?: unknown };
  const candidate = b.message ?? b.error;
  return typeof candidate === "string" ? candidate : undefined;
};

type FindPlayerHit = { aid: string | number; name: string };

/** Resolves a username to a player id, preferring an exact (case-insensitive) name match. */
export async function findPlayer(username: string, options: RequestOptions = {}): Promise<MrPlayer> {
  const { body } = await requestJson<FindPlayerHit[] | { players?: FindPlayerHit[] }>(`${MR_PROXY_BASE}/find-player`, {
    ...options,
    method: "POST",
    json: { name: username },
    friendly: FRIENDLY,
    extractError,
  });
  const hits = Array.isArray(body) ? body : (body?.players ?? []);
  if (hits.length === 0) throw new ApiError(`No player named "${username}" was found.`, 404);
  const wanted = username.trim().toLowerCase();
  const hit = hits.find((h) => h.name?.trim().toLowerCase() === wanted) ?? hits[0];
  return { uid: String(hit.aid), name: hit.name ?? username, candidates: hits.length };
}

/** Fetches a player's profile for one season, including that season's last 20 matches. Omit `season` for the current one. */
export async function fetchPlayerSeason(uid: string, season?: number, options: RequestOptions = {}): Promise<MrPlayerSeason> {
  const query = season !== undefined ? `?season=${encodeURIComponent(String(season))}` : "";
  const { body } = await requestJson<MrPlayerSeason>(`${MR_PROXY_BASE}/player/${encodeURIComponent(uid)}${query}`, {
    ...options,
    friendly: FRIENDLY,
    extractError,
  });
  return body;
}

/** Works out which season a profile response describes. */
export function seasonOf(profile: MrPlayerSeason): number | null {
  const fromMatch = Number(profile.match_history?.[0]?.match_season);
  if (Number.isFinite(fromMatch) && fromMatch > 0) return fromMatch;
  // Fall back to the newest ranked season the account has an entry for.
  let best: number | null = null;
  for (const raw of Object.values(profile.player?.info?.rank_game_season ?? {})) {
    try {
      const id = Number((JSON.parse(raw) as { rank_game_id?: number }).rank_game_id);
      if (Number.isFinite(id) && (best === null || id > best)) best = id;
    } catch {
      // ignore malformed entries
    }
  }
  return best;
}

/**
 * Fetches the current season's matches plus `seasonsBack` earlier seasons
 * (each season contributes up to 20 matches, newest first), de-duplicated.
 */
export async function fetchRecentMatches(
  uid: string,
  options: RequestOptions & { seasonsBack?: number; onSeason?: (season: number | null, fetched: number) => void } = {},
): Promise<{ matches: MrMatch[]; seasons: number[]; profile: MrPlayerSeason }> {
  const { seasonsBack = 0, onSeason, ...requestOptions } = options;
  const profile = await fetchPlayerSeason(uid, undefined, requestOptions);
  const matches: MrMatch[] = [];
  const seen = new Set<string>();
  const add = (list: MrMatch[] | undefined) => {
    for (const m of list ?? []) {
      if (!m?.match_uid || seen.has(m.match_uid)) continue;
      seen.add(m.match_uid);
      matches.push(m);
    }
  };
  add(profile.match_history);
  const current = seasonOf(profile);
  const seasons: number[] = current !== null ? [current] : [];
  onSeason?.(current, matches.length);
  if (current !== null) {
    for (let k = 1; k <= seasonsBack && current - k >= 1; k++) {
      const season = current - k;
      const earlier = await fetchPlayerSeason(uid, season, requestOptions);
      add(earlier.match_history);
      seasons.push(season);
      onSeason?.(season, matches.length);
    }
  }
  return { matches, seasons, profile };
}
