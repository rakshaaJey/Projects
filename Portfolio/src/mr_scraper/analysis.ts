import type { MrHero, MrMap, MrMatch } from "./api.ts";

export type MatchResult = "win" | "loss" | "draw";

/** Objective modes the summary is split by. Anything else (Doom Match, Conquest, ...) lands in "Other". */
export type Objective = "Domination" | "Convoy" | "Convergence" | "Other";
export const OBJECTIVES: Objective[] = ["Domination", "Convoy", "Convergence", "Other"];

export type HeroTally = {
  hero: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  lastPlayedAt: number; // Unix seconds of the newest game on this hero, used to break ties
};

export type RecentGame = {
  hero: string;
  result: MatchResult;
  startedAt: number; // Unix seconds
  map: string;
};

export type Breakdown = {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  heroes: HeroTally[]; // most games first; ties broken by recency
  recent: RecentGame[]; // newest first, capped at RECENT_LIMIT
};

export type GameModeInfo = { id: number; name: string; games: number };

export type PlayerAnalysis = {
  overall: Breakdown;
  byObjective: Record<Objective, Breakdown>;
  /** Every game mode id seen in the raw history, with how many games it had (before filtering). */
  gameModes: GameModeInfo[];
  /** Map ids in the history that could not be matched to a known map. */
  unknownMapIds: number[];
};

export const RECENT_LIMIT = 5;

/**
 * Names for the API's numeric game_mode_id. The API does not document these;
 * the values below are the community-observed ones. Anything unlisted is shown
 * as "Mode #n" so it can still be selected in the filter.
 */
export const GAME_MODE_NAMES: Record<number, string> = {
  1: "Quick Match",
  2: "Competitive",
  3: "Custom",
  4: "Practice vs AI",
  5: "Arcade",
  6: "Conquest",
  7: "Doom Match",
};

/** Game modes counted by default: competitive and custom games. */
export const DEFAULT_GAME_MODES = [2, 3];

export function gameModeName(id: number, apiName?: string): string {
  return apiName || GAME_MODE_NAMES[id] || `Mode #${id}`;
}

/** Fallback map -> objective table (from the community wiki) for maps the API returns without a mode. */
const MAP_OBJECTIVE_FALLBACK: Record<string, Objective> = {
  "yggdrasill path": "Convoy",
  "yggdrasil path": "Convoy",
  "spider-islands": "Convoy",
  "spider islands": "Convoy",
  midtown: "Convoy",
  arakko: "Convoy",
  "symbiotic surface": "Convergence",
  "shin-shibuya": "Convergence",
  "hall of djalia": "Convergence",
  "central park": "Convergence",
  "heart of heaven": "Convergence",
  "hell's heaven": "Domination",
  "birnin t'challa": "Domination",
  "royal palace": "Domination",
  krakoa: "Domination",
  "celestial husk": "Domination",
};

export function classifyObjective(gameMode: string | undefined, mapName?: string): Objective {
  const mode = (gameMode ?? "").toLowerCase();
  if (mode.includes("domination")) return "Domination";
  if (mode.includes("convoy")) return "Convoy";
  if (mode.includes("convergence")) return "Convergence";
  if (mapName) {
    const key = mapName.toLowerCase().replace(/^.*?:\s*/, "").trim(); // strip "Tokyo 2099: " style prefixes
    if (MAP_OBJECTIVE_FALLBACK[key]) return MAP_OBJECTIVE_FALLBACK[key];
  }
  return "Other";
}

export type MapLookup = Map<number, { name: string; objective: Objective }>;

export function buildMapLookup(maps: MrMap[]): MapLookup {
  const lookup: MapLookup = new Map();
  for (const m of maps) {
    if (typeof m.id !== "number") continue;
    const name = m.full_name || m.name || `Map #${m.id}`;
    lookup.set(m.id, { name, objective: classifyObjective(m.game_mode, m.name || m.full_name) });
  }
  return lookup;
}

export function matchOutcome(m: MrMatch): MatchResult {
  const p = m.match_player;
  const flag = typeof p?.is_win === "object" && p.is_win !== null ? p.is_win.is_win : p?.is_win;
  if (typeof flag === "boolean") return flag ? "win" : "loss";
  // Fall back to comparing the winning side with the player's side, when both are known.
  if (m.match_winner_side !== undefined && p?.camp !== undefined) {
    if (Number(m.match_winner_side) === Number(p.camp)) return "win";
    if (Number(m.match_winner_side) === 0 || Number(m.match_winner_side) === -1) return "draw";
    return "loss";
  }
  return "draw";
}

/** Heroes the player used in a match, main hero first. */
export function heroesInMatch(m: MrMatch): MrHero[] {
  const p = m.match_player;
  const list = (p?.player_heroes ?? []).filter((h) => h && h.hero_name);
  if (list.length > 0) {
    const playTime = (h: MrHero) => Number(h.play_time) || 0;
    return [...list].sort((a, b) => playTime(b) - playTime(a));
  }
  return p?.player_hero?.hero_name ? [p.player_hero] : [];
}

type Acc = {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  heroes: Map<string, HeroTally>;
  recent: RecentGame[];
};

const newAcc = (): Acc => ({ games: 0, wins: 0, losses: 0, draws: 0, heroes: new Map(), recent: [] });

function record(acc: Acc, m: MrMatch, heroes: MrHero[], result: MatchResult, mapName: string): void {
  acc.games++;
  if (result === "win") acc.wins++;
  else if (result === "loss") acc.losses++;
  else acc.draws++;

  // Count the match once per distinct hero the player used in it.
  const seen = new Set<string>();
  for (const h of heroes) {
    const name = h.hero_name || "Unknown hero";
    if (seen.has(name)) continue;
    seen.add(name);
    let tally = acc.heroes.get(name);
    if (!tally) {
      // Matches are visited newest-first, so the first sighting is the latest game.
      tally = { hero: name, games: 0, wins: 0, losses: 0, draws: 0, lastPlayedAt: m.match_time_stamp };
      acc.heroes.set(name, tally);
    }
    tally.games++;
    if (result === "win") tally.wins++;
    else if (result === "loss") tally.losses++;
    else tally.draws++;
  }

  if (acc.recent.length < RECENT_LIMIT) {
    acc.recent.push({ hero: heroes[0]?.hero_name || "Unknown hero", result, startedAt: m.match_time_stamp, map: mapName });
  }
}

function finish(acc: Acc): Breakdown {
  const heroes = [...acc.heroes.values()].sort((a, b) => b.games - a.games || b.lastPlayedAt - a.lastPlayedAt);
  return { games: acc.games, wins: acc.wins, losses: acc.losses, draws: acc.draws, heroes, recent: acc.recent };
}

/** Heroes sharing the top game count (length 1 when there is no tie). */
export function topHeroes(heroes: HeroTally[]): HeroTally[] {
  if (heroes.length === 0) return [];
  return heroes.filter((h) => h.games === heroes[0].games);
}

/** Win rate as a percentage of decided games (draws excluded); null when no decided games. */
export function winRate(b: { wins: number; losses: number }): number | null {
  const decided = b.wins + b.losses;
  return decided === 0 ? null : Math.round((b.wins / decided) * 100);
}

/**
 * Tallies heroes overall and per objective mode for the matches whose
 * game_mode_id is in `includedModes` (e.g. competitive and custom).
 */
export function analyzeMatches(matches: MrMatch[], mapLookup: MapLookup, includedModes: Set<number>): PlayerAnalysis {
  const ordered = [...matches].sort((a, b) => (b.match_time_stamp ?? 0) - (a.match_time_stamp ?? 0));

  const modeCounts = new Map<number, GameModeInfo>();
  for (const m of ordered) {
    const id = Number(m.game_mode_id);
    const info = modeCounts.get(id) ?? { id, name: gameModeName(id, m.game_mode_name), games: 0 };
    info.games++;
    modeCounts.set(id, info);
  }

  const overall = newAcc();
  const byObjective: Record<Objective, Acc> = { Domination: newAcc(), Convoy: newAcc(), Convergence: newAcc(), Other: newAcc() };
  const unknownMaps = new Set<number>();

  for (const m of ordered) {
    if (!includedModes.has(Number(m.game_mode_id))) continue;
    const heroes = heroesInMatch(m);
    if (heroes.length === 0) continue;
    const result = matchOutcome(m);
    const mapInfo = mapLookup.get(Number(m.match_map_id));
    if (!mapInfo) unknownMaps.add(Number(m.match_map_id));
    const mapName = mapInfo?.name ?? `Map #${m.match_map_id}`;
    const objective = mapInfo?.objective ?? "Other";
    record(overall, m, heroes, result, mapName);
    record(byObjective[objective], m, heroes, result, mapName);
  }

  return {
    overall: finish(overall),
    byObjective: {
      Domination: finish(byObjective.Domination),
      Convoy: finish(byObjective.Convoy),
      Convergence: finish(byObjective.Convergence),
      Other: finish(byObjective.Other),
    },
    gameModes: [...modeCounts.values()].sort((a, b) => a.id - b.id),
    unknownMapIds: [...unknownMaps].sort((a, b) => a - b),
  };
}
