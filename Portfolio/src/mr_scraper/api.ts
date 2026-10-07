// Data access for MR_Scraper, with two upstream sources, neither needing a key:
//
//   PRIMARY   rivalsdata.com's site API (undocumented). Full cursor-paginated
//             match history per season, plus the tier-list pick/win/ban rates
//             used by the ban suggestions. Requests go through `/api/rd/*` ->
//             https://api.rivalsdata.com/*. The host sits behind Cloudflare and
//             only answers requests that look like a browser; see the proxies.
//
//   FALLBACK  rivalsmeta.com's own site API (undocumented; the same backend
//             serves api.rivalstracker.com). Only the last 20 matches per season,
//             but its hero stats cover every rank and past seasons. Requests go
//             through `/api/mr/*` -> https://rivalsmeta.com/api/*.
//
// Every player lookup, history fetch and hero-meta load tries the primary and
// moves on when it fails for any reason other than the caller aborting
// (Cloudflare 403, 5xx, network error, rate limit exhausted). After a Cloudflare
// block the primary is skipped for a while instead of failing every call.
//
// MarvelRivalsAPI.com (documented, keyed) was the primary until 2026-10; it was
// dropped because its site stopped issuing keys.
//
// See vite.config.ts (dev/preview) and functions/api/{rd,mr} (production) for the proxies.
//
// rivalsdata.com endpoints used (observed from the site and the community rivals-api client):
//   POST /players/search          body {"name": "..."}                  -> [{aid: "<platform>_<uid>", name}, ...]
//   POST /player                  body {"uid": N}                       -> profile: name, login_os, rank_game_season, match_history_is_visible
//   POST /player/matches          body {"uid": N, "cursor"?: "..."}     -> {matches: [20 rows], next_cursor}; refreshes the newest page from the game
//   POST /player/matches/cached   body {"uid": N, "season"?: S, "cursor"?} -> same shape, from the site's cache
//   GET  /stats/tierlist?rank=diamond_plus|grandmaster_plus|celestial_plus|...  -> {last_update, heroes: [{hero_id, picks, bans, winrate, pick_rate, ban_rate, ...}]}
// rivalsmeta.com endpoints used (observed from the site itself):
//   POST /find-player            body {"name": "..."}   -> [{aid, name, cur_head_icon_id}, ...]
//   GET  /player/{aid}?season=N  (no season = current)  -> profile + last 20 matches of that season
//   GET  /heroes/stats?season=N                          -> per-rank hero pick/win/ban totals

import { ApiError, requestJson, type RequestOptions } from "../shared/http.ts";
import { summarizeRank, type RankSummary } from "./rank.ts";
import type { MetaBracket } from "./bans.ts";
import { isBlocked } from "./data/blocklist.ts";

export { ApiError };
export type { RequestOptions };

export const RD_PROXY_BASE = "/api/rd";
export const MR_PROXY_BASE = "/api/mr";

/** The upstreams. Messages shown to the user or in the debug log never name them; they say "primary" and "fallback". */
export type Source = "rivalsdata.com" | "rivalsmeta.com";
const SOURCE_LABEL: Record<Source, string> = { "rivalsdata.com": "primary source", "rivalsmeta.com": "fallback source" };

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

/** One entry of a match history: the NetEase-derived shape rivalsmeta.com serves, which the other sources are brought to. Only the fields we read. */
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

/** Rank data as stored on the account (identical in every source). See rank.ts. */
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

/** rivalsdata.com profile (POST /player). Only the fields we read; the rank data is the same NetEase shape as everywhere else. */
export type RdProfile = RankSeasonsInfo & {
  uid?: string | number;
  name?: string;
  /**
   * Despite the name, observed as 1 on exactly the accounts whose live history the site refuses as
   * private, and 0 on the open ones (2026-10-07). Not relied on: privacy is read from that refusal.
   */
  match_history_is_visible?: number | boolean;
};

/** One rivalsdata.com match-history row (POST /player/matches). Only the fields we read. */
type RdMatch = {
  match_uid?: string;
  is_win?: boolean;
  game_mode_id?: number;
  game_play_mode_id?: number;
  /** Rank-season id (20 = Season 10), the same numbering rank.ts uses. */
  season?: number;
  timestamp?: number; // Unix seconds
  kills?: number;
  deaths?: number;
  assists?: number;
  hero_id?: number;
  map_id?: number;
  winner_camp?: number;
};

/** One hero of rivalsdata.com's tier list (GET /stats/tierlist). Rates are percentages, 0-100. */
export type RdTierHero = {
  hero_id: number;
  picks?: number;
  bans?: number;
  total_games?: number;
  winrate?: number;
  winrate_no_mirror?: number;
  pick_rate?: number;
  ban_rate?: number;
};

/**
 * Hero meta for the ban suggestions, in one of two shapes:
 *   - rivalsmeta.com: season-wide totals split by rank bucket ("1" Bronze ... "9" One
 *     Above All; "0" = everything), which bans.ts adds up for the chosen bracket;
 *   - rivalsdata.com: `rates`, already worked out for one bracket (current season only).
 * Only the fields we read.
 */
export type MrHeroStats = {
  source?: Source;
  season?: number;
  timestamp?: number | string;
  ban_slots_per_match?: number;
  ban_matches?: { rank: string | number; matches: number }[];
  bans?: { rank: string | number; bans: { hero_id: number; bans: number }[] }[];
  heroes?: { rank: string | number; heroes: { hero_id: number; matches?: number; wins?: number; wr_matches?: number; wr_wins?: number }[] }[];
  rates?: { bracket: string; heroes: RdTierHero[] };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const FRIENDLY_RD: Record<number, string> = {
  // The host is behind Cloudflare; a 403 with an HTML body is its bot check turning the proxy away.
  403: "The primary stats source is refusing requests from this server right now (bot check).",
  404: "Player not found on the primary stats source.",
  502: "The primary stats source is not responding right now.",
  503: "The primary stats source is not responding right now.",
  504: "The primary stats source is not responding right now.",
};

const FRIENDLY_MR: Record<number, string> = {
  // rivalsmeta.com's API answers a bare 400 "error" to every request, from any address, during its outages,
  // which last a few minutes at a time (observed 2026-09-28/29). mrRequest retries before giving up.
  400: "The fallback stats source is not answering right now (it goes down for a few minutes at a time). Retried for 3 minutes without luck; try again shortly.",
  404: "Player not found on the fallback stats source.",
  502: "The fallback stats source is not responding right now. Try again in a few minutes.",
  503: "The fallback stats source is not responding right now. Try again in a few minutes.",
};

const extractError = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { message?: unknown; error?: unknown; errors?: { message?: unknown }[] };
  const candidate = b.message ?? b.error ?? b.errors?.[0]?.message;
  return typeof candidate === "string" ? candidate : undefined;
};

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

// ---------------------------------------------------------------------------
// Debug log: a running account of what this module is doing (requests, cache
// hits, retries, fallbacks), shown by the page's debug terminal.
// ---------------------------------------------------------------------------

export type DebugEntry = { at: number; text: string };

const DEBUG_LIMIT = 400;
const debugEntries: DebugEntry[] = [];
const debugListeners = new Set<(entries: readonly DebugEntry[]) => void>();

export function debugLog(text: string): void {
  debugEntries.push({ at: Date.now(), text });
  if (debugEntries.length > DEBUG_LIMIT) debugEntries.splice(0, debugEntries.length - DEBUG_LIMIT);
  for (const listener of debugListeners) listener(debugEntries);
}

/** Calls `listener` with the whole log now and after every new entry; returns the unsubscribe. */
export function subscribeDebug(listener: (entries: readonly DebugEntry[]) => void): () => void {
  listener(debugEntries);
  debugListeners.add(listener);
  return () => void debugListeners.delete(listener);
}

export function clearDebugLog(): void {
  debugEntries.length = 0;
  for (const listener of debugListeners) listener(debugEntries);
}

const statusOf = (err: unknown) => (err instanceof ApiError ? String(err.status) : isAbort(err) ? "aborted" : "network error");
const brief = (json: unknown) => (json === undefined ? "" : ` ${JSON.stringify(json).slice(0, 80)}`);

/** For a player on the blocklist (data/blocklist.ts); 451 so it is never mistaken for an outage or a "not found". */
const blockedError = (name: string) => new ApiError(`"${name}" is not available on this site.`, 451);

// ---------------------------------------------------------------------------
// Being gentle with the upstreams, and riding out their outages:
//   - requests are spaced at least MIN_GAP_MS apart;
//   - rivalsmeta's outage 400 is treated like a rate limit and retried after a
//     growing pause, and rivalsdata's passing 502 is retried once (a real 429
//     from either is retried by the shared client using Retry-After);
//   - responses are cached in localStorage, so re-running an analysis or adding
//     seasons only fetches what is new. Finished seasons never change.
// ---------------------------------------------------------------------------

const MIN_GAP_MS = 1200;
const THROTTLE_RETRY_WAITS_MS = [30_000, 60_000, 90_000];
/** After an auth-type failure (bad key, Cloudflare block) a source is skipped for this long instead of failing every call. */
const SOURCE_BACKOFF_MS = 10 * 60 * 1000;

const CACHE_PREFIX = "mr_scraper:cache.v1:";
const TTL = {
  findPlayer: 24 * 60 * 60 * 1000,
  currentSeason: 10 * 60 * 1000,
  pastSeason: 7 * 24 * 60 * 60 * 1000,
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
  debugLog(`… fallback is in one of its outages; waiting ${Math.round(ms / 1000)}s before retry ${attempt} of ${THROTTLE_RETRY_WAITS_MS.length}`);
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
    if (Date.now() - at >= ttlMs) return undefined;
    debugLog(`cache hit ${key} (${Math.round((Date.now() - at) / 60000)} min old)`);
    return value;
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

/** rivalsdata.com's origin drops the odd request with a bare 502 (observed 2026-10-07); one short pause and retry rides that out. */
const RD_RETRY_WAIT_MS = 2500;

/** GET/POST against the rivalsdata.com proxy: spaced out, a passing 5xx retried once, 429 handled by the shared client. */
async function rdRequest<T>(path: string, config: JsonConfig = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await spaceOut(config.signal);
    const started = Date.now();
    debugLog(`→ primary ${config.method ?? "GET"} ${path}${brief(config.json)}${attempt ? ` (retry ${attempt})` : ""}`);
    try {
      const { status, body } = await requestJson<T>(`${RD_PROXY_BASE}${path}`, { ...config, friendly: FRIENDLY_RD, extractError });
      debugLog(`← primary ${status} in ${Date.now() - started} ms`);
      return body;
    } catch (err) {
      debugLog(`✗ primary ${statusOf(err)} after ${Date.now() - started} ms: ${describe(err)}`);
      const flaky = err instanceof ApiError && err.status >= 502 && err.status <= 504;
      if (!flaky || attempt >= 1) throw err;
      debugLog(`… passing 5xx; waiting ${RD_RETRY_WAIT_MS / 1000}s and retrying once`);
      await sleep(RD_RETRY_WAIT_MS, config.signal);
    }
  }
}

/** GET/POST against the rivalsmeta.com proxy: spaced out, and an outage 400 is retried like a 429. */
async function mrRequest<T>(path: string, config: JsonConfig = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await spaceOut(config.signal);
    const started = Date.now();
    debugLog(`→ fallback ${config.method ?? "GET"} ${path}${brief(config.json)}${attempt ? ` (retry ${attempt})` : ""}`);
    try {
      const { status, body } = await requestJson<T>(`${MR_PROXY_BASE}${path}`, { ...config, friendly: FRIENDLY_MR, extractError });
      debugLog(`← fallback ${status} in ${Date.now() - started} ms`);
      return body;
    } catch (err) {
      debugLog(`✗ fallback ${statusOf(err)} after ${Date.now() - started} ms: ${describe(err)}`);
      const throttled = err instanceof ApiError && err.status === 400;
      if (!throttled || attempt >= THROTTLE_RETRY_WAITS_MS.length) throw err;
      await countdown(THROTTLE_RETRY_WAITS_MS[attempt], attempt + 1, config);
    }
  }
}

// ---------------------------------------------------------------------------
// Source chain
// ---------------------------------------------------------------------------

type Attempt<T> = { source: Source; run: () => Promise<T> };

const sourceDown = new Map<Source, { until: number; reason: string }>();

function noteFailure(source: Source, err: unknown): void {
  if (!(err instanceof ApiError)) return;
  // A Cloudflare block will not fix itself within minutes; back off so every player is not delayed by it.
  // rivalsdata.com also answers 403 for one player's private history, which says nothing about the next player.
  const blocked = err.status === 403 && (source !== "rivalsdata.com" || err.message === FRIENDLY_RD[403]);
  if (blocked) sourceDown.set(source, { until: Date.now() + SOURCE_BACKOFF_MS, reason: err.message });
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs the attempts in order and returns the first that succeeds. A source in
 * backoff is skipped; an abort stops everything; any other failure moves on.
 * When every source fails the error names each one, unless the last answer
 * was a plain "not found", which is an answer rather than an outage.
 */
async function firstWorking<T>(attempts: Attempt<T>[], label: string): Promise<T> {
  const failures: string[] = [];
  let last: unknown = null;
  for (const { source, run } of attempts) {
    const down = sourceDown.get(source);
    if (down && Date.now() < down.until) {
      failures.push(`${SOURCE_LABEL[source]}: ${down.reason}`);
      debugLog(`${label}: skipping the ${SOURCE_LABEL[source]}, benched for another ${Math.ceil((down.until - Date.now()) / 60000)} min (${down.reason})`);
      continue;
    }
    try {
      return await run();
    } catch (err) {
      if (isAbort(err)) throw err;
      noteFailure(source, err);
      last = err;
      failures.push(`${SOURCE_LABEL[source]}: ${describe(err)}`);
      // The page only shows the source that answered; leave a trace of why the earlier ones did not.
      console.warn(`[mr_scraper] ${label}: ${SOURCE_LABEL[source]} failed, trying the next source. ${describe(err)}`);
      debugLog(`${label}: ${SOURCE_LABEL[source]} failed${sourceDown.has(source) ? " and is benched for 10 min" : ""}; trying the next source`);
    }
  }
  if (last instanceof ApiError && last.status === 404) throw last;
  throw new ApiError(`${label}: ${failures.join("; ")}`, last instanceof ApiError ? last.status : 0);
}

// ---------------------------------------------------------------------------
// Player lookup
// ---------------------------------------------------------------------------

type RdSearchHit = { aid?: string | number; uid?: string | number; name?: string };

/** The search's `aid` is "<platform>_<uid>" (e.g. "11001_1979499089"); the game's uid is the trailing number. */
function rdUid(hit: RdSearchHit): string | null {
  const tail = String(hit.uid ?? hit.aid ?? "").match(/\d+$/)?.[0];
  return tail && UID_PATTERN.test(tail) ? tail : null;
}

async function findPlayerRd(username: string, options: RequestOptions): Promise<MrPlayer> {
  const body = await rdRequest<RdSearchHit[] | { players?: RdSearchHit[] }>(`/players/search`, { ...options, method: "POST", json: { name: username } });
  const hits = Array.isArray(body) ? body : (body?.players ?? []);
  if (hits.length === 0) throw new ApiError(`No player named "${username}" was found.`, 404);
  const { hit, caseInsensitive } = pickExact(username, hits);
  const uid = rdUid(hit);
  if (!uid) throw new ApiError(`The primary stats source returned an unreadable account id for "${username}".`, 502);
  return { uid, name: hit.name ?? username, candidates: hits.length, source: "rivalsdata.com", caseInsensitive };
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
 * every source). A numeric input is taken as the UID itself, no search needed;
 * the display name then comes from the profile. Names must match exactly.
 */
export async function findPlayer(username: string, options: RequestOptions = {}): Promise<MrPlayer> {
  const trimmed = username.trim();
  if (isBlocked(trimmed)) throw blockedError(trimmed);
  if (UID_PATTERN.test(trimmed)) return { uid: trimmed, name: trimmed, candidates: 1, source: "uid" };
  const cacheKey = `find:${trimmed}`;
  const cached = cacheRead<MrPlayer>(cacheKey, TTL.findPlayer);
  if (cached?.source) return cached;
  const player = await firstWorking(
    [
      { source: "rivalsdata.com", run: () => findPlayerRd(username, options) },
      { source: "rivalsmeta.com", run: () => findPlayerMr(username, options) },
    ],
    `Looking up "${username}"`,
  );
  cacheWrite(cacheKey, player);
  return player;
}

// ---------------------------------------------------------------------------
// rivalsmeta.com history (last resort)
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
  /** The player hides their battle history in-game. Any matches present were indexed by the source before that, so they can be stale. */
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
// rivalsdata.com history (first choice)
// ---------------------------------------------------------------------------

/** Rows per page are fixed upstream at 20; 6 pages = 120 matches per season, plenty for a hero breakdown. */
const RD_MAX_PAGES = 6;

/**
 * The profile (cached as briefly as the current season's history), or a 404
 * when the site has never seen the uid: it answers 200 with an empty profile.
 */
async function fetchRdProfile(uid: string, options: RequestOptions): Promise<RdProfile> {
  const cacheKey = `rd:profile:${uid}`;
  const cached = cacheRead<RdProfile>(cacheKey, TTL.currentSeason);
  if (cached) return cached;
  const body = await rdRequest<RdProfile>(`/player`, { ...options, method: "POST", json: { uid: Number(uid) } });
  const ranks = body?.rank_game_season;
  const known = Boolean(body?.name) || (typeof ranks === "string" ? ranks.length > 2 : Boolean(ranks && Object.keys(ranks).length > 0));
  if (!known) throw new ApiError(FRIENDLY_RD[404], 404);
  // Keep only what the page reads; the profile also carries cosmetics and faction data.
  const slim: RdProfile = { uid: body.uid, name: body.name, login_os: body.login_os, rank_game_season: body.rank_game_season, match_history_is_visible: body.match_history_is_visible };
  cacheWrite(cacheKey, slim);
  return slim;
}

/** Brings a rivalsdata.com row to the shared shape. */
function normalizeRdMatch(raw: RdMatch): MrMatch | null {
  if (!raw?.match_uid) return null;
  const heroId = Number(raw.hero_id) || 0;
  return {
    match_uid: String(raw.match_uid),
    match_map_id: Number(raw.map_id) || 0,
    match_season: raw.season !== undefined && raw.season !== null ? String(raw.season) : "",
    match_time_stamp: Number(raw.timestamp) || 0,
    play_mode_id: Number(raw.game_play_mode_id) || 0,
    game_mode_id: Number(raw.game_mode_id) || 0,
    match_winner_side: raw.winner_camp !== undefined ? Number(raw.winner_camp) : undefined,
    match_player: {
      k: raw.kills,
      d: raw.deaths,
      a: raw.assists,
      is_win: typeof raw.is_win === "boolean" ? raw.is_win : undefined,
      player_hero: heroId ? { hero_id: heroId } : undefined,
    },
  };
}

type RdSeasonHistory = {
  matches: MrMatch[];
  /** True when the live endpoint refused the history as private; the matches then come from the site's cache. */
  historyPrivate: boolean;
};

/** The live endpoint answers 403 with {"error": "match history is private"} for accounts that hide their battle history in-game. */
const isRdPrivate = (err: unknown) => err instanceof ApiError && err.status === 403 && /private/i.test(err.message);

/** One page of history, following the site's cursor. */
async function fetchRdHistoryPage(path: string, uid: string, season: number | undefined, cursor: string | undefined, options: RequestOptions) {
  const json: Record<string, unknown> = { uid: Number(uid) };
  if (season !== undefined) json.season = season;
  if (cursor) json.cursor = cursor;
  return rdRequest<{ matches?: RdMatch[]; next_cursor?: string | null }>(path, { ...options, method: "POST", json });
}

/**
 * Fetches up to RD_MAX_PAGES pages of one season's history. Omit `season` for
 * the current one: that starts at the live endpoint, which refreshes the
 * player's newest page from the game before answering (later pages come from
 * the site's cache). A history hidden in-game is refused there, in which case
 * the cache still holds what the site indexed before, and that is used
 * instead. Finished seasons are read from the cache directly.
 */
async function fetchRdSeasonMatches(uid: string, season: number | undefined, options: RequestOptions): Promise<RdSeasonHistory> {
  const cacheKey = `rd:history:${uid}:${season ?? "current"}`;
  const cached = cacheRead<RdSeasonHistory>(cacheKey, season === undefined ? TTL.currentSeason : TTL.pastSeason);
  if (cached) return cached;
  let path = season === undefined ? "/player/matches" : "/player/matches/cached";
  let historyPrivate = false;
  const { matches, add } = collector();
  let cursor: string | undefined;
  for (let page = 0; page < RD_MAX_PAGES; page++) {
    let body: Awaited<ReturnType<typeof fetchRdHistoryPage>>;
    try {
      body = await fetchRdHistoryPage(path, uid, season, cursor, options);
    } catch (err) {
      if (!isRdPrivate(err) || path !== "/player/matches") throw err;
      historyPrivate = true;
      path = "/player/matches/cached";
      debugLog("primary refused the live history as private; reading what it cached before");
      body = await fetchRdHistoryPage(path, uid, season, cursor, options);
    }
    const batch = (body.matches ?? []).map(normalizeRdMatch).filter((m): m is MrMatch => m !== null);
    add(batch);
    cursor = body.next_cursor ?? undefined;
    if (!cursor || batch.length === 0) break;
  }
  const result = { matches, historyPrivate };
  cacheWrite(cacheKey, result);
  return result;
}

async function fetchRecentMatchesRd(uid: string, options: HistoryOptions): Promise<RecentMatches> {
  const { seasonsBack = 0, onSeason, ...requestOptions } = options;
  const profile = await fetchRdProfile(uid, requestOptions);
  const rank = summarizeRank({ player: { info: { login_os: profile.login_os, rank_game_season: profile.rank_game_season } } });
  const { matches, add } = collector();
  const latest = await fetchRdSeasonMatches(uid, undefined, requestOptions);
  add(latest.matches);
  // Without a season filter the site answers with the newest season only, numbered as a rank-season id.
  const current = (Number(matches[0]?.match_season) || null) ?? rank.current?.season ?? null;
  const seasons: number[] = current !== null ? [current] : [];
  onSeason?.(current, matches.length, "rivalsdata.com");
  if (current !== null) {
    for (let k = 1; k <= seasonsBack && current - k >= 1; k++) {
      const season = current - k;
      add((await fetchRdSeasonMatches(uid, season, requestOptions)).matches);
      seasons.push(season);
      onSeason?.(season, matches.length, "rivalsdata.com");
    }
  }
  return { name: profile.name || undefined, matches, seasons, historyPrivate: latest.historyPrivate, rank, source: "rivalsdata.com" };
}

/**
 * Fetches the current season's matches plus `seasonsBack` earlier seasons,
 * newest first and de-duplicated: from rivalsdata.com (up to 120 per season),
 * else rivalsmeta.com (last 20).
 */
export async function fetchRecentMatches(uid: string, options: HistoryOptions = {}): Promise<RecentMatches> {
  const result = await firstWorking(
    [
      { source: "rivalsdata.com", run: () => fetchRecentMatchesRd(uid, options) },
      { source: "rivalsmeta.com", run: () => fetchRecentMatchesMr(uid, options) },
    ],
    "Fetching match history",
  );
  // A blocked player looked up by UID is only recognisable once the profile has named them.
  if (isBlocked(result.name)) throw blockedError(result.name as string);
  return result;
}

// ---------------------------------------------------------------------------
// Hero meta: rivalsdata.com's tier list first, rivalsmeta.com's hero stats after
// ---------------------------------------------------------------------------

/**
 * rivalsdata.com publishes its tier list per rank bracket, and only from
 * Diamond up (diamond, diamond_plus, grandmaster, grandmaster_plus, celestial,
 * celestial_plus, eternity_plus). The page's "all ranks" bracket therefore maps
 * to the site's default, Diamond+, and the returned label says so.
 */
function rdBracket(bracket: MetaBracket): { rank: string; label: string } {
  const lowest = Math.min(...bracket.ranks.map(Number));
  if (lowest >= 7) return { rank: "celestial_plus", label: "Celestial+" };
  if (lowest >= 6) return { rank: "grandmaster_plus", label: "Grandmaster+" };
  return { rank: "diamond_plus", label: "Diamond+" };
}

/** Fetches rivalsdata.com's current-season tier list for the bracket closest to `bracket`. */
async function fetchHeroStatsRd(bracket: MetaBracket, options: RequestOptions): Promise<MrHeroStats> {
  const { rank, label } = rdBracket(bracket);
  const body = await rdRequest<{ last_update?: number; heroes?: RdTierHero[] }>(`/stats/tierlist?rank=${encodeURIComponent(rank)}`, options);
  if (!body.heroes?.length) throw new ApiError("The primary stats source returned an empty tier list.", 502);
  // Keep only what the ban recommender reads.
  const heroes = body.heroes.map(({ hero_id, picks, bans, total_games, winrate, winrate_no_mirror, pick_rate, ban_rate }) => ({
    hero_id,
    picks,
    bans,
    total_games,
    winrate,
    winrate_no_mirror,
    pick_rate,
    ban_rate,
  }));
  return { source: "rivalsdata.com", timestamp: body.last_update, rates: { bracket: label, heroes } };
}

/** Fetches rivalsmeta.com's hero statistics for a season (pick, win and ban totals per rank bucket). */
export async function fetchHeroStats(season: number, options: RequestOptions = {}): Promise<MrHeroStats> {
  const body = await mrRequest<MrHeroStats>(`/heroes/stats?season=${encodeURIComponent(String(season))}`, options);
  // Keep only what the ban recommender reads; the payload also carries map and team-up tables.
  return {
    source: "rivalsmeta.com",
    season: body.season,
    timestamp: body.timestamp,
    ban_slots_per_match: body.ban_slots_per_match,
    ban_matches: body.ban_matches,
    bans: body.bans,
    heroes: body.heroes,
  };
}

/**
 * Hero meta for the ban suggestions, cached per season and bracket so
 * re-running the analysis does not refetch it. rivalsdata.com only publishes
 * the current season, which is what a lineup's newest season nearly always is;
 * rivalsmeta.com covers any season and every rank, and is used when it fails.
 */
export async function loadHeroStats(season: number, bracket: MetaBracket, options: RequestOptions = {}): Promise<MrHeroStats> {
  const cacheKey = `heroStats:${season}:${rdBracket(bracket).rank}`;
  const cached = cacheRead<MrHeroStats>(cacheKey, TTL.heroStats);
  if (cached) return cached;
  const stats = await firstWorking(
    [
      { source: "rivalsdata.com", run: () => fetchHeroStatsRd(bracket, options) },
      { source: "rivalsmeta.com", run: () => fetchHeroStats(season, options) },
    ],
    "Loading the hero meta",
  );
  cacheWrite(cacheKey, stats);
  return stats;
}
