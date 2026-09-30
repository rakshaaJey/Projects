// Data access for MR_Scraper, with two upstream sources:
//
//   PRIMARY   MarvelRivalsAPI.com (https://docs.marvelrivalsapi.com/) — documented,
//             needs an API key (MARVELRIVALS_API_KEY, attached by the proxy, never
//             sent to the browser). Full paginated match history per season.
//             Requests go through `/api/mra/*` -> https://marvelrivalsapi.com/api/*.
//
//   FALLBACK  rivalsmeta.com's own site API (undocumented, no key; the same backend
//             serves api.rivalstracker.com). Only the last 20 matches per season.
//             Requests go through `/api/mr/*` -> https://rivalsmeta.com/api/*.
//             Also the ONLY source of hero pick/win/ban rates (the site's tier-list
//             data), which MarvelRivalsAPI.com does not offer, so the ban
//             suggestions always come from here.
//
// Every player lookup and history fetch tries the primary first and falls back
// when it fails for any reason other than the caller aborting (no key, 401,
// 5xx, network error, rate limit exhausted). After a key problem the primary is
// skipped for a while instead of failing every call.
//
// See vite.config.ts (dev/preview) and functions/api/{mra,mr} (production) for the proxies.
//
// MarvelRivalsAPI.com endpoints used:
//   GET /v1/find-player/{username}                         -> { uid, name }
//   GET /v2/player/{uid}                                   -> profile: rank, info.rank_game_season, isPrivate
//   GET /v2/player/{uid}/match-history?game_mode=0&page=N&limit=40[&season=S]
//   GET /v2/seasons                                        -> [{ season, name, starts_at, ends_at }]
// rivalsmeta.com endpoints used (observed from the site itself):
//   POST /find-player            body {"name": "..."}   -> [{aid, name, cur_head_icon_id}, ...]
//   GET  /player/{aid}?season=N  (no season = current)  -> profile + last 20 matches of that season
//   GET  /heroes/stats?season=N                          -> per-rank hero pick/win/ban totals

import { ApiError, requestJson, type RequestOptions } from "../shared/http.ts";
import { seasonIdFromGameSeason, summarizeRank, type RankSummary } from "./rank.ts";

export { ApiError };
export type { RequestOptions };

export const MRA_PROXY_BASE = "/api/mra";
export const MR_PROXY_BASE = "/api/mr";

export type Source = "marvelrivalsapi.com" | "rivalsmeta.com";

export type MrPlayer = {
  uid: string;
  name: string;
  /** How many players the name search returned; >1 means the exact match was picked from a list. */
  candidates: number;
  source: Source | "uid";
  /** Set when the name matched only ignoring case, so the caller can say so. */
  caseInsensitive?: boolean;
};

/** A bare account id: the game's UIDs are long numbers. */
export const UID_PATTERN = /^\d{5,}$/;

/**
 * Exact-match policy: the typed name must equal a result's name. Case is
 * checked first; if that fails and exactly one result matches ignoring case,
 * it is accepted and flagged. Anything else is "not found", with the similar
 * names listed so the user can copy the right one or use the UID.
 */
function pickExact<T extends { name?: string }>(username: string, hits: T[]): { hit: T; caseInsensitive: boolean } {
  const wanted = username.trim();
  const exact = hits.find((h) => h.name?.trim() === wanted);
  if (exact) return { hit: exact, caseInsensitive: false };
  const loose = hits.filter((h) => h.name?.trim().toLowerCase() === wanted.toLowerCase());
  if (loose.length === 1) return { hit: loose[0], caseInsensitive: true };
  const similar = hits.map((h) => h.name?.trim()).filter((n): n is string => Boolean(n)).slice(0, 8);
  const hint = similar.length > 0 ? ` Similar names found: ${similar.map((n) => `"${n}"`).join(", ")}.` : "";
  // Name search only covers accounts the stats site has already indexed, so a real player can still be missing.
  throw new ApiError(
    `No player named exactly "${wanted}".${hint} If the name is right, the stats site has not indexed that account yet: enter their UID instead (shown on their in-game Career page and on tracker.gg).`,
    404,
  );
}

/** One entry of a match history. Both sources use this NetEase-derived shape; only the fields we read. */
export type MrMatch = {
  match_uid: string;
  match_map_id: number;
  match_season: string;
  match_time_stamp: number; // Unix seconds
  play_mode_id: number;
  game_mode_id: number;
  match_winner_side?: number;
  match_player: {
    player_uid?: number | string;
    k?: number;
    d?: number;
    a?: number;
    is_win?: number | boolean | { is_win?: boolean; score?: number };
    camp?: number;
    player_hero?: { hero_id: number; hero_name?: string };
  };
};

/** Rank data as stored on the account (identical in both sources). See rank.ts. */
export type RankSeasonsInfo = {
  login_os?: string;
  /** Object (or JSON string) keyed by `<login_os>0010<season>`; each value a rank entry, possibly JSON-encoded. */
  rank_game_season?: Record<string, unknown> | string;
};

/** rivalsmeta.com profile response. */
export type MrPlayerSeason = {
  player?: { _id?: number; info?: { name?: string } & RankSeasonsInfo };
  stats?: { total_matches?: number; ranked_matches?: number; unranked_matches?: number };
  match_history?: MrMatch[];
  /** Per-section privacy from the player's in-game career settings; false means the site cannot see it either. */
  visibility?: { overview?: boolean; career_stats?: boolean; match_history?: boolean };
};

/** MarvelRivalsAPI.com v2 profile response. Only the fields we read. */
export type MraProfile = {
  uid?: string | number;
  name?: string;
  isPrivate?: boolean;
  player?: {
    uid?: string | number;
    name?: string;
    isPrivate?: boolean;
    rank?: { rank?: string; score?: string | number; peak_rank?: { rank?: string; score?: string | number } };
    info?: RankSeasonsInfo;
  };
};

export type MraSeason = { season: string | number; name?: string; starts_at?: string; ends_at?: string };

/** Season-wide hero totals split by rank bucket ("1" Bronze ... "9" One Above All; "0" = everything). Only the fields we read. */
export type MrHeroStats = {
  season?: number;
  timestamp?: number | string;
  ban_slots_per_match?: number;
  ban_matches?: { rank: string | number; matches: number }[];
  bans?: { rank: string | number; bans: { hero_id: number; bans: number }[] }[];
  heroes?: { rank: string | number; heroes: { hero_id: number; matches?: number; wins?: number; wr_matches?: number; wr_wins?: number }[] }[];
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const FRIENDLY_MRA: Record<number, string> = {
  401: "MarvelRivalsAPI.com rejected the API key. Locally, set MARVELRIVALS_API_KEY in .env and restart the dev server; in production, set it in the Cloudflare project's variables and redeploy.",
  404: "Player not found on MarvelRivalsAPI.com.",
  500: "MarvelRivalsAPI.com key is not configured for this deployment (or its server errored).",
  502: "MarvelRivalsAPI.com is not responding right now.",
  503: "MarvelRivalsAPI.com is not responding right now.",
  504: "MarvelRivalsAPI.com is not responding right now.",
};

const FRIENDLY_MR: Record<number, string> = {
  // rivalsmeta.com's API answers a bare 400 "error" to every request, from any address, during its outages,
  // which last a few minutes at a time (observed 2026-09-28/29). mrRequest retries before giving up.
  400: "rivalsmeta.com's API is not answering right now (it goes down for a few minutes at a time). Retried for 3 minutes without luck; try again shortly.",
  404: "Player not found on rivalsmeta.com.",
  502: "rivalsmeta.com is not responding right now. Try again in a few minutes.",
  503: "rivalsmeta.com is not responding right now. Try again in a few minutes.",
};

const extractError = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { message?: unknown; error?: unknown; errors?: { message?: unknown }[] };
  const candidate = b.message ?? b.error ?? b.errors?.[0]?.message;
  return typeof candidate === "string" ? candidate : undefined;
};

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

// ---------------------------------------------------------------------------
// Being gentle with the upstreams, and riding out their outages:
//   - requests are spaced at least MIN_GAP_MS apart;
//   - rivalsmeta's outage 400 is treated like a rate limit and retried after a
//     growing pause (MarvelRivalsAPI.com signals limits with a real 429, which
//     the shared client already retries using Retry-After);
//   - responses are cached in localStorage, so re-running an analysis or adding
//     seasons only fetches what is new. Finished seasons never change.
// ---------------------------------------------------------------------------

const MIN_GAP_MS = 1200;
const THROTTLE_RETRY_WAITS_MS = [30_000, 60_000, 90_000];
/** After a key/auth failure on the primary, skip it for this long instead of failing every call. */
const PRIMARY_BACKOFF_MS = 10 * 60 * 1000;

const CACHE_PREFIX = "mr_scraper:cache.v1:";
const TTL = {
  findPlayer: 24 * 60 * 60 * 1000,
  currentSeason: 10 * 60 * 1000,
  pastSeason: 7 * 24 * 60 * 60 * 1000,
  seasons: 24 * 60 * 60 * 1000,
  heroStats: 6 * 60 * 60 * 1000,
} as const;

let nextSlotAt = 0;

/** Waits until at least MIN_GAP_MS has passed since the previous request was released. */
async function spaceOut(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  nextSlotAt = Math.max(now, nextSlotAt) + MIN_GAP_MS;
  if (wait > 0) await sleep(wait, signal);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Counts down `ms`, reporting the seconds left once a second through onRateLimit. */
async function countdown(ms: number, attempt: number, options: RequestOptions): Promise<void> {
  const deadline = Date.now() + ms;
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    options.onRateLimit?.(Math.max(left, 0), attempt);
    if (left <= 0) return;
    await sleep(Math.min(1000, deadline - Date.now()), options.signal);
  }
}

function cacheRead<T>(key: string, ttlMs: number): T | undefined {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return undefined;
    const { at, value } = JSON.parse(raw) as { at: number; value: T };
    return Date.now() - at < ttlMs ? value : undefined;
  } catch {
    return undefined;
  }
}

function cacheWrite(key: string, value: unknown): void {
  const entry = JSON.stringify({ at: Date.now(), value });
  try {
    localStorage.setItem(CACHE_PREFIX + key, entry);
  } catch {
    // Probably full: drop this page's cache and try once more; give up quietly otherwise.
    clearApiCache();
    try {
      localStorage.setItem(CACHE_PREFIX + key, entry);
    } catch {
      // storage disabled or still full
    }
  }
}

/** Removes every cached API response (players, seasons, hero stats). */
export function clearApiCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

type JsonConfig = RequestOptions & { method?: "GET" | "POST"; json?: unknown };

/** GET/POST against the MarvelRivalsAPI.com proxy (spaced out; 429 handled by the shared client). */
async function mraRequest<T>(path: string, config: JsonConfig = {}): Promise<T> {
  await spaceOut(config.signal);
  const { body } = await requestJson<T>(`${MRA_PROXY_BASE}${path}`, { ...config, friendly: FRIENDLY_MRA, extractError });
  return body;
}

/** GET/POST against the rivalsmeta.com proxy: spaced out, and an outage 400 is retried like a 429. */
async function mrRequest<T>(path: string, config: JsonConfig = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await spaceOut(config.signal);
    try {
      const { body } = await requestJson<T>(`${MR_PROXY_BASE}${path}`, { ...config, friendly: FRIENDLY_MR, extractError });
      return body;
    } catch (err) {
      const throttled = err instanceof ApiError && err.status === 400;
      if (!throttled || attempt >= THROTTLE_RETRY_WAITS_MS.length) throw err;
      await countdown(THROTTLE_RETRY_WAITS_MS[attempt], attempt + 1, config);
    }
  }
}

// ---------------------------------------------------------------------------
// Primary/fallback plumbing
// ---------------------------------------------------------------------------

let primaryDownUntil = 0;
let primaryDownReason = "";

/** Whether the primary should be attempted right now. */
export function primaryAvailable(): boolean {
  return Date.now() >= primaryDownUntil;
}

function notePrimaryFailure(err: unknown): void {
  // A bad or missing key will not fix itself within the session; back off so every player is not delayed by it.
  if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 500)) {
    primaryDownUntil = Date.now() + PRIMARY_BACKOFF_MS;
    primaryDownReason = err.message;
  }
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs `primary`, and on any failure other than an abort runs `fallback`.
 * If both fail, the error names both sources.
 */
async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>, label: string): Promise<T> {
  let primaryError: unknown = primaryDownReason ? new ApiError(primaryDownReason, 401) : null;
  if (primaryAvailable()) {
    try {
      return await primary();
    } catch (err) {
      if (isAbort(err)) throw err;
      notePrimaryFailure(err);
      primaryError = err;
    }
  }
  try {
    return await fallback();
  } catch (err) {
    if (isAbort(err)) throw err;
    const status = err instanceof ApiError ? err.status : 0;
    // "Not found" is an answer, not an outage: report it plainly.
    if (status === 404) throw err;
    throw new ApiError(`${label}: MarvelRivalsAPI.com failed (${describe(primaryError)}) and so did rivalsmeta.com (${describe(err)}).`, status);
  }
}

// ---------------------------------------------------------------------------
// Player lookup
// ---------------------------------------------------------------------------

async function findPlayerMra(username: string, options: RequestOptions): Promise<MrPlayer> {
  const body = await mraRequest<{ uid?: string | number; name?: string; player?: { uid?: string | number; name?: string } }>(
    `/v1/find-player/${encodeURIComponent(username)}`,
    options,
  );
  const uid = body.uid ?? body.player?.uid;
  if (uid === undefined || uid === null || uid === "") throw new ApiError(`No player named "${username}" was found.`, 404);
  const { hit, caseInsensitive } = pickExact(username, [{ uid, name: body.name ?? body.player?.name }]);
  return { uid: String(hit.uid), name: hit.name ?? username, candidates: 1, source: "marvelrivalsapi.com", caseInsensitive };
}

type FindPlayerHit = { aid: string | number; name: string };

async function findPlayerMr(username: string, options: RequestOptions): Promise<MrPlayer> {
  const body = await mrRequest<FindPlayerHit[] | { players?: FindPlayerHit[] }>(`/find-player`, { ...options, method: "POST", json: { name: username } });
  const hits = Array.isArray(body) ? body : (body?.players ?? []);
  if (hits.length === 0) throw new ApiError(`No player named "${username}" was found.`, 404);
  const { hit, caseInsensitive } = pickExact(username, hits);
  return { uid: String(hit.aid), name: hit.name ?? username, candidates: hits.length, source: "rivalsmeta.com", caseInsensitive };
}

/**
 * Resolves a username to a player id (the uid is the game's own, identical in
 * both sources). A numeric input is taken as the UID itself, no search needed;
 * the display name then comes from the profile. Names must match exactly.
 */
export async function findPlayer(username: string, options: RequestOptions = {}): Promise<MrPlayer> {
  const trimmed = username.trim();
  if (UID_PATTERN.test(trimmed)) return { uid: trimmed, name: trimmed, candidates: 1, source: "uid" };
  const cacheKey = `find:${trimmed}`;
  const cached = cacheRead<MrPlayer>(cacheKey, TTL.findPlayer);
  if (cached?.source) return cached;
  const player = await withFallback(
    () => findPlayerMra(username, options),
    () => findPlayerMr(username, options),
    `Looking up "${username}"`,
  );
  cacheWrite(cacheKey, player);
  return player;
}

// ---------------------------------------------------------------------------
// rivalsmeta.com history (fallback)
// ---------------------------------------------------------------------------

/**
 * Fetches a rivalsmeta profile for one season, including that season's last 20
 * matches. Omit `season` for the current one (cached briefly); pass one only
 * for a finished season (cached for a week, since it can no longer change).
 */
export async function fetchPlayerSeason(uid: string, season?: number, options: RequestOptions = {}): Promise<MrPlayerSeason> {
  const cacheKey = `player:${uid}:${season ?? "current"}`;
  const cached = cacheRead<MrPlayerSeason>(cacheKey, season === undefined ? TTL.currentSeason : TTL.pastSeason);
  if (cached) return cached;
  const query = season !== undefined ? `?season=${encodeURIComponent(String(season))}` : "";
  const body = await mrRequest<MrPlayerSeason>(`/player/${encodeURIComponent(uid)}${query}`, options);
  // Keep only what the page reads; the profile also carries hero tables and cosmetics.
  const slim: MrPlayerSeason = { player: body.player, stats: body.stats, match_history: body.match_history, visibility: body.visibility };
  cacheWrite(cacheKey, slim);
  return slim;
}

/** Works out which season a rivalsmeta profile response describes. */
export function seasonOf(profile: MrPlayerSeason): number | null {
  const fromMatch = Number(profile.match_history?.[0]?.match_season);
  if (Number.isFinite(fromMatch) && fromMatch > 0) return fromMatch;
  // Fall back to the newest ranked season the account has an entry for.
  return summarizeRank(profile).current?.season ?? null;
}

export type RecentMatches = {
  /** Display name from the profile, when the source provides one. */
  name?: string;
  matches: MrMatch[];
  /** Rank-season ids covered (see rank.ts seasonLabel), newest first. */
  seasons: number[];
  historyPrivate: boolean;
  rank: RankSummary;
  source: Source;
};

type HistoryOptions = RequestOptions & {
  seasonsBack?: number;
  onSeason?: (season: number | null, fetched: number, source: Source) => void;
};

function collector() {
  const matches: MrMatch[] = [];
  const seen = new Set<string>();
  const add = (list: MrMatch[] | undefined) => {
    for (const m of list ?? []) {
      if (!m?.match_uid || seen.has(m.match_uid)) continue;
      seen.add(m.match_uid);
      matches.push(m);
    }
  };
  return { matches, add };
}

async function fetchRecentMatchesMr(uid: string, options: HistoryOptions): Promise<RecentMatches> {
  const { seasonsBack = 0, onSeason, ...requestOptions } = options;
  const profile = await fetchPlayerSeason(uid, undefined, requestOptions);
  const { matches, add } = collector();
  add(profile.match_history);
  const current = seasonOf(profile);
  const seasons: number[] = current !== null ? [current] : [];
  onSeason?.(current, matches.length, "rivalsmeta.com");
  if (current !== null) {
    for (let k = 1; k <= seasonsBack && current - k >= 1; k++) {
      const season = current - k;
      const earlier = await fetchPlayerSeason(uid, season, requestOptions);
      add(earlier.match_history);
      seasons.push(season);
      onSeason?.(season, matches.length, "rivalsmeta.com");
    }
  }
  return {
    name: profile.player?.info?.name,
    matches,
    seasons,
    historyPrivate: profile.visibility?.match_history === false,
    rank: summarizeRank(profile),
    source: "rivalsmeta.com",
  };
}

// ---------------------------------------------------------------------------
// MarvelRivalsAPI.com history (primary)
// ---------------------------------------------------------------------------

const MRA_PAGE_SIZE = 40;
/** Pages per season; 3 x 40 = 120 matches, plenty for a hero breakdown. */
const MRA_MAX_PAGES = 3;

/** The season list, newest first. */
export async function fetchSeasonsMra(options: RequestOptions = {}): Promise<MraSeason[]> {
  const cached = cacheRead<MraSeason[]>("mra:seasons", TTL.seasons);
  if (cached) return cached;
  const body = await mraRequest<{ seasons?: MraSeason[] } | MraSeason[]>(`/v2/seasons`, options);
  const list = (Array.isArray(body) ? body : (body.seasons ?? [])).filter((s) => s && s.season !== undefined && s.season !== null);
  const time = (s: MraSeason) => (s.starts_at ? Date.parse(s.starts_at) : NaN);
  list.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return (Number(b.season) || 0) - (Number(a.season) || 0);
  });
  cacheWrite("mra:seasons", list);
  return list;
}

/** Brings a v2 match-history entry to the shared shape (v2 sometimes uses `map_id`/`season`). */
function normalizeMraMatch(raw: Record<string, unknown>): MrMatch | null {
  const uid = raw.match_uid ?? raw.match_id;
  if (!uid) return null;
  const player = (raw.match_player ?? raw.player_performance ?? {}) as MrMatch["match_player"] & { hero_id?: number; hero_name?: string };
  const hero = player.player_hero ?? (player.hero_id ? { hero_id: Number(player.hero_id), hero_name: player.hero_name } : undefined);
  return {
    match_uid: String(uid),
    match_map_id: Number(raw.match_map_id ?? raw.map_id) || 0,
    match_season: String(raw.match_season ?? raw.season ?? ""),
    match_time_stamp: Number(raw.match_time_stamp) || 0,
    play_mode_id: Number(raw.play_mode_id) || 0,
    game_mode_id: Number(raw.game_mode_id) || 0,
    match_winner_side: raw.match_winner_side !== undefined ? Number(raw.match_winner_side) : raw.winner_side !== undefined ? Number(raw.winner_side) : undefined,
    match_player: { ...player, player_hero: hero },
  };
}

/** Fetches up to MRA_MAX_PAGES pages of one season's history across every game mode. Omit `season` for the current one. */
async function fetchMraSeasonMatches(uid: string, season: string | undefined, options: RequestOptions): Promise<MrMatch[]> {
  const cacheKey = `mra:history:${uid}:${season ?? "current"}`;
  const cached = cacheRead<MrMatch[]>(cacheKey, season === undefined ? TTL.currentSeason : TTL.pastSeason);
  if (cached) return cached;
  const { matches, add } = collector();
  for (let page = 1; page <= MRA_MAX_PAGES; page++) {
    const query = new URLSearchParams({ game_mode: "0", page: String(page), limit: String(MRA_PAGE_SIZE) });
    if (season !== undefined) query.set("season", season);
    const body = await mraRequest<{ match_history?: Record<string, unknown>[]; matches?: Record<string, unknown>[]; pagination?: { has_more?: boolean } }>(
      `/v2/player/${encodeURIComponent(uid)}/match-history?${query}`,
      options,
    );
    const batch = (body.match_history ?? body.matches ?? []).map(normalizeMraMatch).filter((m): m is MrMatch => m !== null);
    add(batch);
    const hasMore = body.pagination?.has_more ?? batch.length >= MRA_PAGE_SIZE;
    if (!hasMore || batch.length === 0) break;
  }
  cacheWrite(cacheKey, matches);
  return matches;
}

async function fetchRecentMatchesMra(uid: string, options: HistoryOptions): Promise<RecentMatches> {
  const { seasonsBack = 0, onSeason, ...requestOptions } = options;
  const profile = await mraRequest<MraProfile>(`/v2/player/${encodeURIComponent(uid)}`, requestOptions);
  const info = profile.player?.info;
  const rank = summarizeRank({ player: { info } });
  const historyPrivate = Boolean(profile.isPrivate ?? profile.player?.isPrivate);

  const { matches, add } = collector();
  add(await fetchMraSeasonMatches(uid, undefined, requestOptions));
  // Which rank-season the current history belongs to: from the matches, else the account's newest rank entry.
  let current = seasonIdFromGameSeason(matches[0]?.match_season) ?? rank.current?.season ?? null;
  const seasons: number[] = current !== null ? [current] : [];
  onSeason?.(current, matches.length, "marvelrivalsapi.com");

  if (seasonsBack > 0) {
    const list = await fetchSeasonsMra(requestOptions);
    // Everything older than the current season, newest first.
    const currentIndex = current === null ? 0 : Math.max(0, list.findIndex((s) => seasonIdFromGameSeason(s.season) === current));
    const earlier = list.slice(currentIndex + 1, currentIndex + 1 + seasonsBack);
    for (const s of earlier) {
      const batch = await fetchMraSeasonMatches(uid, String(s.season), requestOptions);
      add(batch);
      const id = seasonIdFromGameSeason(s.season) ?? seasonIdFromGameSeason(batch[0]?.match_season);
      if (id !== null) {
        seasons.push(id);
        if (current === null) current = id;
      }
      onSeason?.(id, matches.length, "marvelrivalsapi.com");
    }
  }
  return { name: profile.name ?? profile.player?.name, matches, seasons, historyPrivate, rank, source: "marvelrivalsapi.com" };
}

/**
 * Fetches the current season's matches plus `seasonsBack` earlier seasons,
 * newest first and de-duplicated, from MarvelRivalsAPI.com (up to 120 per
 * season) or, when that fails, from rivalsmeta.com (last 20 per season).
 */
export async function fetchRecentMatches(uid: string, options: HistoryOptions = {}): Promise<RecentMatches> {
  return withFallback(
    () => fetchRecentMatchesMra(uid, options),
    () => fetchRecentMatchesMr(uid, options),
    "Fetching match history",
  );
}

// ---------------------------------------------------------------------------
// Hero meta (rivalsmeta.com only)
// ---------------------------------------------------------------------------

/** Fetches the season's hero statistics (pick, win and ban totals per rank bucket). */
export async function fetchHeroStats(season: number, options: RequestOptions = {}): Promise<MrHeroStats> {
  const body = await mrRequest<MrHeroStats>(`/heroes/stats?season=${encodeURIComponent(String(season))}`, options);
  // Keep only what the ban recommender reads; the payload also carries map and team-up tables.
  return { season: body.season, timestamp: body.timestamp, ban_slots_per_match: body.ban_slots_per_match, ban_matches: body.ban_matches, bans: body.bans, heroes: body.heroes };
}

/** fetchHeroStats with a per-season cache, so re-running the analysis does not refetch a 200 KB payload. */
export async function loadHeroStats(season: number, options: RequestOptions = {}): Promise<MrHeroStats> {
  const cacheKey = `heroStats:${season}`;
  const cached = cacheRead<MrHeroStats>(cacheKey, TTL.heroStats);
  if (cached) return cached;
  const stats = await fetchHeroStats(season, options);
  cacheWrite(cacheKey, stats);
  return stats;
}
