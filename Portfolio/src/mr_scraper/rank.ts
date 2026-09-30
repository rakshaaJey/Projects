import type { MrPlayerSeason } from "./api.ts";

type RankSource = Pick<MrPlayerSeason, "player">;

// Competitive rank as rivalsmeta reports it: a numeric `level` 1-25 plus a
// rank score (RS). The level -> name mapping mirrors the site's RankBadge
// component (bundle chunk Dp19ovyi.js): three divisions per tier, counting
// down (level 1 = Bronze 3, level 3 = Bronze 1), then Eternity and One Above All.

export type RankTier =
  | "unranked"
  | "bronze"
  | "silver"
  | "gold"
  | "platinum"
  | "diamond"
  | "grandmaster"
  | "celestial"
  | "eternity"
  | "one-above-all";

const TIERS: { max: number; tier: RankTier; name: string; divisions: boolean }[] = [
  { max: 3, tier: "bronze", name: "Bronze", divisions: true },
  { max: 6, tier: "silver", name: "Silver", divisions: true },
  { max: 9, tier: "gold", name: "Gold", divisions: true },
  { max: 12, tier: "platinum", name: "Platinum", divisions: true },
  { max: 15, tier: "diamond", name: "Diamond", divisions: true },
  { max: 18, tier: "grandmaster", name: "Grandmaster", divisions: true },
  { max: 21, tier: "celestial", name: "Celestial", divisions: true },
  { max: 22, tier: "eternity", name: "Eternity", divisions: false },
  { max: 25, tier: "one-above-all", name: "One Above All", divisions: false },
];

export function rankTier(level: number): RankTier {
  if (!(level > 0)) return "unranked";
  return TIERS.find((t) => level <= t.max)?.tier ?? "one-above-all";
}

export function rankName(level: number): string {
  if (!(level > 0)) return "Unranked";
  const t = TIERS.find((t) => level <= t.max) ?? TIERS[TIERS.length - 1];
  if (!t.divisions) return t.name;
  return `${t.name} ${t.max - level + 1}`;
}

export type RankEntry = {
  /** Rank season id as the API counts it (two per game season); see seasonLabel(). */
  season: number;
  /** Platform the entry belongs to (first digit of its key: 1 PC, 2 PlayStation, 4 Xbox); accounts can hold one entry per platform per season. */
  platform: string;
  level: number;
  score: number;
  /** Ranked games played that season. 0 means the level is just the soft-reset placement. */
  games: number;
  /** Highest rank reached that season; 0 when no ranked game was played. */
  maxLevel: number;
  maxScore: number;
};

/**
 * The API numbers rank seasons in halves: id 20 is Season 10, id 19 is Season 9.5,
 * id 2 is Season 1 and id 1 the launch Season 0.
 */
export function seasonLabel(id: number): string {
  if (id <= 1) return "S0";
  return id % 2 === 0 ? `S${id / 2}` : `S${(id - 1) / 2}.5`;
}

/**
 * The inverse: a game season as MarvelRivalsAPI.com names it ("10", "9.5",
 * 3, "Season 2.5") to the rank-season id. Null when it cannot be read.
 */
export function seasonIdFromGameSeason(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  // Already a rank-season id (two digits, e.g. "20") is ambiguous with Season 20; the game
  // is nowhere near that, so anything above 15 is taken as a rank-season id.
  const n = Number(text.match(/-?\d+(\.\d+)?/)?.[0]);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 15) return Math.round(n);
  if (n <= 0) return 1;
  return Math.round(n * 2);
}

export type RankSummary = {
  /** Rank in the newest season the account has an entry for. */
  current: RankEntry | null;
  /** Highest rank reached in any recorded season. */
  peak: RankEntry | null;
};

type RawRankSeason = {
  level?: number | string;
  rank_score?: number | string;
  max_level?: number | string;
  max_rank_score?: number | string;
  rank_game_id?: number | string;
  battle_count?: number | string;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Reads every season's rank entry out of `player.info.rank_game_season`: an
 * object keyed by `<platform>0010<season>` whose values are rank records
 * (observed as objects; the site also tolerates JSON strings, so both are
 * accepted). Unknown or malformed entries are skipped. A cross-platform
 * account has several entries for the same season, one per platform; only
 * the one actually played on carries games, the others hold placement levels.
 */
export function rankSeasons(profile: RankSource): RankEntry[] {
  let raw: unknown = profile.player?.info?.rank_game_season;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!raw || typeof raw !== "object") return [];
  const entries: RankEntry[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    let entry: RawRankSeason | null = null;
    try {
      entry = typeof value === "string" ? (JSON.parse(value) as RawRankSeason) : (value as RawRankSeason);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    // Prefer the entry's own season id; otherwise the last two digits of the key.
    const season = num(entry.rank_game_id) || num(key.slice(-2));
    if (!season) continue;
    const level = num(entry.level);
    const games = num(entry.battle_count);
    // A season with no ranked games only holds the soft-reset placement level, which is not a rank reached.
    const maxLevel = Math.max(num(entry.max_level), games > 0 ? level : 0);
    entries.push({
      season,
      platform: key.slice(0, 1),
      level,
      score: num(entry.rank_score),
      games,
      maxLevel,
      maxScore: Math.max(num(entry.max_rank_score), maxLevel === level && games > 0 ? num(entry.rank_score) : 0),
    });
  }
  return entries.sort((a, b) => b.season - a.season);
}

/**
 * Picks one entry per season when a season has several (one per platform):
 * the one with the most ranked games, then the account's login platform,
 * then the highest level.
 */
export function bestPerSeason(entries: RankEntry[], loginOs?: string): RankEntry[] {
  const bySeason = new Map<number, RankEntry>();
  for (const e of entries) {
    const cur = bySeason.get(e.season);
    if (!cur) {
      bySeason.set(e.season, e);
      continue;
    }
    const better =
      e.games !== cur.games ? e.games > cur.games : e.platform !== cur.platform && loginOs ? e.platform === loginOs : e.level > cur.level;
    if (better) bySeason.set(e.season, e);
  }
  return [...bySeason.values()].sort((a, b) => b.season - a.season);
}

export function summarizeRank(profile: RankSource): RankSummary {
  const all = rankSeasons(profile);
  const current = bestPerSeason(all, profile.player?.info?.login_os)[0] ?? null;
  // Peak looks at every platform's entries, so a rank reached on another platform still counts.
  let peak: RankEntry | null = null;
  for (const s of all) {
    if (s.maxLevel <= 0) continue;
    if (!peak || s.maxLevel > peak.maxLevel || (s.maxLevel === peak.maxLevel && s.maxScore > peak.maxScore)) peak = s;
  }
  return { current, peak };
}

export const formatScore = (score: number) => `${Math.round(score).toLocaleString("en-US")} RS`;
