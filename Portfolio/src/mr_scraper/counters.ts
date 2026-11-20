import { heroName, type PlayerAnalysis } from "./analysis.ts";
import type { MrHeroMatchups } from "./api.ts";
import { heroRole, type Role } from "./data/roles.ts";

// Counter comp: given the scouted lineup's hero pools and the head-to-head
// matchup matrix (api.ts loadHeroMatchups), suggest one hero per slot of the
// user's own team, where each slot is a role (tank / dps / support) or flex.
//
// How a hero is scored:
//   1. The enemy's hero pool becomes threat weights from each scouted player's
//      most played heroes only (their top POOL_PER_PLAYER), weighted by share
//      of games among those, so every player counts equally (weights sum to
//      the number of players with data). Heroes a player only dabbles in are
//      left out, so a hero several players touch now and then cannot outweigh
//      someone's main.
//   2. A candidate's score is its expected win rate against that pool: the
//      weighted average of its head-to-head win rate against each enemy hero.
//      Head-to-head rates are pulled slightly towards 50% (SHRINK_GAMES
//      pseudo-games), which only matters for thin pairs.
//   3. Scores are independent of each other, so filling each role's slots with
//      its best heroes, then each flex slot with the best hero left of any
//      role, is the best comp under this score.

export type Slot = Role | "flex";
export type SlotCounts = Record<Slot, number>;

export const SLOT_ORDER: Slot[] = ["tank", "dps", "support", "flex"];
export const SLOT_LABELS: Record<Slot, string> = { tank: "Tank", dps: "DPS", support: "Support", flex: "Flex" };
export const DEFAULT_SLOTS: SlotCounts = { tank: 2, dps: 2, support: 2, flex: 0 };

/** A match fields this many heroes per team. */
export const TEAM_SIZE = 6;
/** Upper bound on slots per role and in total, so the steppers stay sensible for a roster with subs. */
export const MAX_SLOTS_PER_ROLE = 6;
export const MAX_SLOTS_TOTAL = 10;

/** How many of each enemy player's most played heroes go into the pool. */
export const POOL_PER_PLAYER = 3;
/** Pseudo-games at 50% mixed into each head-to-head rate. */
const SHRINK_GAMES = 200;
/** Matchups shown per side in a pick's reasoning. */
const EDGES_SHOWN = 3;
/** Alternatives listed per pick. */
const ALTERNATIVES_SHOWN = 3;

export type LineupPlayer = { name: string; analysis: PlayerAnalysis };

/** One hero in the enemy pool: how much it weighs and who plays it. */
export type Threat = { hero: string; weight: number; players: { name: string; share: number }[] };

/** A candidate's head-to-head against one enemy hero. */
export type MatchupEdge = {
  hero: string;
  /** The enemy hero's threat weight. */
  weight: number;
  /** Candidate's (shrunk) win rate against it, 0-1. */
  winRate: number;
  matches: number;
  /** weight x (winRate - 0.5): how much this matchup moves the score. */
  impact: number;
};

export type CounterPick = {
  hero: string;
  role: Role;
  /** Expected win rate against the enemy pool, 0-1. */
  score: number;
  /** Share of the enemy pool's weight the matrix had data for, 0-1. */
  coverage: number;
  /** Matchups that help most, biggest first. */
  best: MatchupEdge[];
  /** Matchups that hurt most, worst first. */
  worst: MatchupEdge[];
};

export type CompSlot = { slot: Slot; pick: CounterPick; alternatives: CounterPick[] };

export type CounterComp = {
  slots: CompSlot[];
  /** Enemy hero pool, heaviest first. */
  threats: Threat[];
  /** Players whose games formed the pool. */
  players: number;
  /** Enemy heroes with no matchup data (left out of every score). */
  unrated: string[];
};

/** Hero name -> id for every hero in the matrix. Deadpool's per-role variants keep their own ids, as in heroes.ts. */
function matrixHeroes(matrix: MrHeroMatchups): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of Object.keys(matrix)) out.set(heroName(Number(id)), id);
  return out;
}

export function enemyThreats(lineup: LineupPlayer[], excluded: Set<string>): { threats: Threat[]; players: number } {
  const byHero = new Map<string, Threat>();
  let players = 0;
  for (const p of lineup) {
    // analysis.ts keeps heroes sorted most played first (ties by recency).
    const heroes = p.analysis.overall.heroes.filter((h) => !excluded.has(h.hero)).slice(0, POOL_PER_PLAYER);
    const games = heroes.reduce((n, h) => n + h.games, 0);
    if (games === 0) continue;
    players++;
    for (const h of heroes) {
      const share = h.games / games;
      let t = byHero.get(h.hero);
      if (!t) {
        t = { hero: h.hero, weight: 0, players: [] };
        byHero.set(h.hero, t);
      }
      t.weight += share;
      t.players.push({ name: p.name, share });
    }
  }
  const threats = [...byHero.values()].sort((a, b) => b.weight - a.weight);
  for (const t of threats) t.players.sort((a, b) => b.share - a.share);
  return { threats, players };
}

function scoreHero(hero: string, id: string, role: Role, matrix: MrHeroMatchups, threats: Threat[], ids: Map<string, string>): CounterPick | null {
  const row = matrix[id];
  if (!row) return null;
  const edges: MatchupEdge[] = [];
  let weighted = 0;
  let rated = 0;
  let total = 0;
  for (const t of threats) {
    total += t.weight;
    const enemyId = ids.get(t.hero);
    if (!enemyId) continue;
    // A mirror is a coin flip; the matrix says so too, but not every hero has its own row entry.
    const cell = enemyId === id ? { matches: 0, wins: 0 } : row[enemyId];
    if (!cell) continue;
    const winRate = (cell.wins + SHRINK_GAMES / 2) / (cell.matches + SHRINK_GAMES);
    weighted += t.weight * winRate;
    rated += t.weight;
    edges.push({ hero: t.hero, weight: t.weight, winRate, matches: cell.matches, impact: t.weight * (winRate - 0.5) });
  }
  if (rated === 0) return null;
  const best = edges.filter((e) => e.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, EDGES_SHOWN);
  const worst = edges.filter((e) => e.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, EDGES_SHOWN);
  return { hero, role, score: weighted / rated, coverage: total > 0 ? rated / total : 0, best, worst };
}

/**
 * The suggested comp for `slots` against `lineup`. Heroes in `excluded`
 * (e.g. the suggested bans) are left out of both the enemy pool and our picks,
 * since a ban removes the hero for both teams.
 */
export function counterComp(lineup: LineupPlayer[], matrix: MrHeroMatchups, slots: SlotCounts, excluded: Set<string> = new Set()): CounterComp | null {
  const { threats, players } = enemyThreats(lineup, excluded);
  if (players === 0) return null;
  const ids = matrixHeroes(matrix);

  const candidates: CounterPick[] = [];
  for (const [hero, id] of ids) {
    if (excluded.has(hero)) continue;
    const role = heroRole(Number(id));
    if (!role) continue;
    const pick = scoreHero(hero, id, role, matrix, threats, ids);
    if (pick) candidates.push(pick);
  }
  candidates.sort((a, b) => b.score - a.score || a.hero.localeCompare(b.hero));

  const taken = new Set<string>();
  const chosen: { slot: Slot; pick: CounterPick }[] = [];
  const fits = (slot: Slot) => (c: CounterPick) => slot === "flex" || c.role === slot;
  // Role slots first, so a flex slot never takes the hero a fixed-role slot needed.
  for (const slot of SLOT_ORDER) {
    for (let i = 0; i < slots[slot]; i++) {
      const pick = candidates.find((c) => !taken.has(c.hero) && fits(slot)(c));
      if (!pick) break;
      taken.add(pick.hero);
      chosen.push({ slot, pick });
    }
  }
  // Alternatives: the next best heroes for the same kind of slot that are not already in the comp.
  const compSlots = chosen.map(({ slot, pick }) => ({
    slot,
    pick,
    alternatives: candidates.filter((c) => !taken.has(c.hero) && fits(slot)(c)).slice(0, ALTERNATIVES_SHOWN),
  }));
  const unrated = threats.filter((t) => !ids.has(t.hero)).map((t) => t.hero);
  return { slots: compSlots, threats, players, unrated };
}

/** Clamps saved or edited slot counts to the allowed ranges. */
export function clampSlots(s: Partial<SlotCounts> | null | undefined): SlotCounts {
  const out = { ...DEFAULT_SLOTS };
  if (!s) return out;
  let total = 0;
  for (const slot of SLOT_ORDER) {
    const n = Math.max(0, Math.min(MAX_SLOTS_PER_ROLE, Math.floor(Number(s[slot]) || 0)));
    out[slot] = Math.min(n, MAX_SLOTS_TOTAL - total);
    total += out[slot];
  }
  return out;
}
