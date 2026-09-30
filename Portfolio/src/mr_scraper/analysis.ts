import type { MrMatch } from "./api.ts";
import { HEROES } from "./data/heroes.ts";
import { MAPS } from "./data/maps.ts";
import { heroRole, ROLE_LABELS, type Role } from "./data/roles.ts";

export { ROLE_LABELS, type Role };

export type MatchResult = "win" | "loss" | "draw";

/** Objective modes the summary is split by. Anything else (Doom Match, Conquest, arcade, ...) lands in "Other". */
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

export type RoleGames = Record<Role, number>;

export type Breakdown = {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  heroes: HeroTally[]; // most games first; ties broken by recency
  recent: RecentGame[]; // newest first, capped at RECENT_LIMIT
  /** Games per role (tank / dps / support); games on heroes with an unknown role are not counted here. */
  roles: RoleGames;
};

/** How a player splits their games across roles, and the label that earns. */
export type PlayerRole = {
  /** "flex" when no single role dominates. */
  role: Role | "flex";
  label: string;
  /** Share of role-classified games per role, 0-1, largest first. */
  shares: { role: Role; share: number; games: number }[];
};

/** A player is a specialist when this share of their classified games is on one role; below it they are flex. */
export const ROLE_MAIN_SHARE = 0.7;

export function playerRole(b: Breakdown): PlayerRole | null {
  const total = b.roles.tank + b.roles.dps + b.roles.support;
  if (total === 0) return null;
  const shares = (Object.keys(b.roles) as Role[])
    .map((role) => ({ role, games: b.roles[role], share: b.roles[role] / total }))
    .filter((r) => r.games > 0)
    .sort((a, c) => c.games - a.games);
  const top = shares[0];
  if (top.share >= ROLE_MAIN_SHARE) return { role: top.role, label: ROLE_LABELS[top.role], shares };
  return { role: "flex", label: "Flex", shares };
}

export type GameModeInfo = { id: number; name: string; games: number };

export type PlayerAnalysis = {
  overall: Breakdown;
  byObjective: Record<Objective, Breakdown>;
  /** Every game mode id seen in the raw history, with how many games it had (before filtering). */
  gameModes: GameModeInfo[];
  /** Map ids in the history that are missing from the map dictionary. */
  unknownMapIds: number[];
  /** Matches in the counted modes that carried no hero id (usually left early), skipped from the tallies. */
  skippedNoHero: number;
};

export const RECENT_LIMIT = 5;

/**
 * Names for the numeric game_mode_id in match history, as rivalsmeta.com's own
 * match page labels them (bundle chunk o_IWEHbh.js). 2 = Competitive is also
 * confirmed from real data: ranked players' histories are all mode 2 and the
 * count matches their ranked totals. 4 covers every limited-time arcade mode
 * (18 vs 18 Annihilation, Path to Doomsday, ...). Anything unlisted shows as "Mode #n".
 */
export const GAME_MODE_NAMES: Record<number, string> = {
  1: "Quick Play",
  2: "Competitive",
  3: "Custom",
  4: "Arcade",
  5: "Tutorial",
  6: "Practice",
  7: "Practice vs AI",
  9: "Tournament",
  10: "Tournament",
};

/** Game modes counted by default: competitive and custom games. */
export const DEFAULT_GAME_MODES = [2, 3];

export function gameModeName(id: number): string {
  return GAME_MODE_NAMES[id] || `Mode #${id}`;
}

export function heroName(id: number | undefined): string {
  if (id === undefined || id === null) return "Unknown hero";
  const direct = HEROES[id];
  if (direct) return direct;
  // Variant ids like 10571 (Deadpool as Vanguard) fall back to the base hero 1057.
  if (id >= 10000) {
    const base = HEROES[Math.floor(id / 10)];
    if (base) return base;
  }
  return `Hero #${id}`;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'(-])([a-z])/g, (m) => m.toUpperCase());

export type MapInfo = { name: string; objective: Objective; mode: string; known: boolean };

export function mapInfo(id: number): MapInfo {
  const entry = MAPS[id];
  if (!entry) return { name: `Map #${id}`, objective: "Other", mode: "", known: false };
  const mode = entry.mode.toUpperCase();
  const objective: Objective = mode.includes("DOMINATION")
    ? "Domination"
    : mode.includes("CONVOY")
      ? "Convoy"
      : mode.includes("CONVERGENCE")
        ? "Convergence"
        : "Other";
  return { name: `${titleCase(entry.map)} (${titleCase(entry.mode)})`, objective, mode: entry.mode, known: true };
}

export function matchOutcome(m: MrMatch): MatchResult {
  const p = m.match_player;
  const raw = p?.is_win;
  const flag = typeof raw === "object" && raw !== null ? raw.is_win : raw;
  if (typeof flag === "boolean") return flag ? "win" : "loss";
  if (typeof flag === "number") return flag > 0 ? "win" : "loss";
  // Fall back to comparing the winning side with the player's side, when both are known.
  if (m.match_winner_side !== undefined && p?.camp !== undefined) {
    return Number(m.match_winner_side) === Number(p.camp) ? "win" : "loss";
  }
  return "draw";
}

type Acc = {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  heroes: Map<string, HeroTally>;
  recent: RecentGame[];
  roles: RoleGames;
};

const newAcc = (): Acc => ({ games: 0, wins: 0, losses: 0, draws: 0, heroes: new Map(), recent: [], roles: { tank: 0, dps: 0, support: 0 } });

function record(acc: Acc, m: MrMatch, hero: string, role: Role | null, result: MatchResult, mapName: string): void {
  acc.games++;
  if (role) acc.roles[role]++;
  if (result === "win") acc.wins++;
  else if (result === "loss") acc.losses++;
  else acc.draws++;

  let tally = acc.heroes.get(hero);
  if (!tally) {
    // Matches are visited newest-first, so the first sighting is the latest game.
    tally = { hero, games: 0, wins: 0, losses: 0, draws: 0, lastPlayedAt: m.match_time_stamp };
    acc.heroes.set(hero, tally);
  }
  tally.games++;
  if (result === "win") tally.wins++;
  else if (result === "loss") tally.losses++;
  else tally.draws++;

  if (acc.recent.length < RECENT_LIMIT) acc.recent.push({ hero, result, startedAt: m.match_time_stamp, map: mapName });
}

function finish(acc: Acc): Breakdown {
  const heroes = [...acc.heroes.values()].sort((a, b) => b.games - a.games || b.lastPlayedAt - a.lastPlayedAt);
  return { games: acc.games, wins: acc.wins, losses: acc.losses, draws: acc.draws, heroes, recent: acc.recent, roles: acc.roles };
}

/**
 * A player counts as a one-trick when their most played hero has significantly
 * more games than their second most played one. "Significantly" is a one-sided
 * exact binomial test: of the games split between those two heroes, would a
 * lead this big be unlikely (p < ONE_TRICK_ALPHA) if the player really split
 * them evenly? So 34 vs 10 qualifies (p ≈ 0.0002), 8 vs 1 does (p ≈ 0.018),
 * 6 vs 1 does not (p ≈ 0.063). A small overall minimum stops a 5-game sample
 * from counting.
 */
export const ONE_TRICK_MIN_GAMES = 5;
export const ONE_TRICK_ALPHA = 0.05;

export type OneTrick = {
  hero: string;
  /** Share of all counted games on this hero, 0-1. */
  share: number;
  games: number;
  total: number;
  /** The next most played hero, if any. */
  runnerUp: { hero: string; games: number } | null;
  /** One-sided binomial p-value for the lead over the runner-up (0 when there is no runner-up). */
  pValue: number;
};

/** P(X >= k) for X ~ Binomial(n, 1/2), computed exactly in log space. */
export function binomialUpperTail(k: number, n: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  // log C(n, i) built up incrementally: C(n, i+1) = C(n, i) * (n - i) / (i + 1).
  let logC = 0;
  const logHalfN = -n * Math.LN2;
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += Math.exp(logC + logHalfN);
    logC += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, tail);
}

export function oneTrick(b: Breakdown): OneTrick | null {
  const top = b.heroes[0];
  if (!top || b.games < ONE_TRICK_MIN_GAMES) return null;
  const second = b.heroes[1] ?? null;
  const pValue = second ? binomialUpperTail(top.games, top.games + second.games) : 0;
  if (pValue >= ONE_TRICK_ALPHA) return null;
  return {
    hero: top.hero,
    share: top.games / b.games,
    games: top.games,
    total: b.games,
    runnerUp: second ? { hero: second.hero, games: second.games } : null,
    pValue,
  };
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
export function analyzeMatches(matches: MrMatch[], includedModes: Set<number>): PlayerAnalysis {
  const ordered = [...matches].sort((a, b) => (b.match_time_stamp ?? 0) - (a.match_time_stamp ?? 0));

  const modeCounts = new Map<number, GameModeInfo>();
  for (const m of ordered) {
    const id = Number(m.game_mode_id);
    const info = modeCounts.get(id) ?? { id, name: gameModeName(id), games: 0 };
    info.games++;
    modeCounts.set(id, info);
  }

  const overall = newAcc();
  const byObjective: Record<Objective, Acc> = { Domination: newAcc(), Convoy: newAcc(), Convergence: newAcc(), Other: newAcc() };
  const unknownMaps = new Set<number>();
  let skippedNoHero = 0;

  for (const m of ordered) {
    if (!includedModes.has(Number(m.game_mode_id))) continue;
    const heroId = Number(m.match_player?.player_hero?.hero_id);
    if (!heroId) {
      // The API reports hero 0 when nothing was recorded for the player (e.g. left before picking).
      skippedNoHero++;
      continue;
    }
    const hero = heroName(heroId);
    const role = heroRole(heroId);
    const result = matchOutcome(m);
    const map = mapInfo(Number(m.match_map_id));
    if (!map.known) unknownMaps.add(Number(m.match_map_id));
    record(overall, m, hero, role, result, map.name);
    record(byObjective[map.objective], m, hero, role, result, map.name);
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
    skippedNoHero,
  };
}
