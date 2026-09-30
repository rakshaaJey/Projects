import { heroName, oneTrick, type PlayerAnalysis } from "./analysis.ts";
import type { MrHeroStats } from "./api.ts";

// Ban suggestions against a scouted lineup: which heroes the analyzed players
// lean on, weighted by how strong each hero is in the current ranked meta.

/** Rank buckets in the hero-stats payload, as the site's tier list labels them. */
export const RANK_BUCKET_NAMES: Record<string, string> = {
  "1": "Bronze",
  "2": "Silver",
  "3": "Gold",
  "4": "Platinum",
  "5": "Diamond",
  "6": "Grandmaster",
  "7": "Celestial",
  "8": "Eternity",
  "9": "One Above All",
};

export type MetaBracket = { label: string; ranks: string[] };

export const BRACKETS = {
  all: { label: "all ranks", ranks: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
  diamondPlus: { label: "Diamond+", ranks: ["5", "6", "7", "8", "9"] },
  grandmasterPlus: { label: "Grandmaster+", ranks: ["6", "7", "8", "9"] },
} satisfies Record<string, MetaBracket>;

/**
 * Picks the meta bracket closest to the lineup: the median current rank level
 * decides between all ranks, Diamond+ and Grandmaster+. With no rank data the
 * site's default (Diamond+) is used.
 */
export function bracketFor(levels: number[]): MetaBracket {
  const known = levels.filter((l) => l > 0).sort((a, b) => a - b);
  if (known.length === 0) return BRACKETS.diamondPlus;
  const median = known[Math.floor((known.length - 1) / 2)];
  if (median >= 16) return BRACKETS.grandmasterPlus;
  if (median >= 13) return BRACKETS.diamondPlus;
  return BRACKETS.all;
}

export type HeroMeta = {
  hero: string;
  /** Fraction of decided games won, 0-1. */
  winRate: number | null;
  /** Fraction of team slots the hero filled, 0-1 (the site's "pick rate"). */
  pickRate: number;
  /** Fraction of matches in which the hero was banned, 0-1. */
  banRate: number;
  matches: number;
};

/** Aggregates the hero-stats payload for one rank bracket, keyed by hero name. Mirrors the site's tier-list math. */
export function heroMeta(stats: MrHeroStats, bracket: MetaBracket): Map<string, HeroMeta> {
  const inBracket = (rank: unknown) => bracket.ranks.includes(String(rank));
  const acc = new Map<string, { matches: number; wrMatches: number; wrWins: number; bans: number }>();
  const get = (hero: string) => {
    let a = acc.get(hero);
    if (!a) {
      a = { matches: 0, wrMatches: 0, wrWins: 0, bans: 0 };
      acc.set(hero, a);
    }
    return a;
  };
  for (const group of stats.heroes ?? []) {
    if (!inBracket(group.rank)) continue;
    for (const h of group.heroes ?? []) {
      if (!h.hero_id) continue;
      const a = get(heroName(Number(h.hero_id)));
      a.matches += Number(h.matches) || 0;
      a.wrMatches += Number(h.wr_matches) || 0;
      a.wrWins += Number(h.wr_wins) || 0;
    }
  }
  for (const group of stats.bans ?? []) {
    if (!inBracket(group.rank)) continue;
    for (const b of group.bans ?? []) {
      if (!b.hero_id) continue;
      get(heroName(Number(b.hero_id))).bans += Number(b.bans) || 0;
    }
  }
  const banMatches = (stats.ban_matches ?? []).reduce((sum, m) => (inBracket(m.rank) ? sum + (Number(m.matches) || 0) : sum), 0);
  // Every match has 6 hero slots per team, so total picks / 6 is the number of team-matches.
  const teamMatches = [...acc.values()].reduce((sum, a) => sum + a.matches, 0) / 6;

  const out = new Map<string, HeroMeta>();
  for (const [hero, a] of acc) {
    out.set(hero, {
      hero,
      winRate: a.wrMatches > 0 ? a.wrWins / a.wrMatches : null,
      pickRate: teamMatches > 0 ? a.matches / teamMatches : 0,
      banRate: banMatches > 0 ? a.bans / banMatches : 0,
      matches: a.matches,
    });
  }
  return out;
}

export type LineupPlayer = { name: string; analysis: PlayerAnalysis };

export type BanPlayerShare = { name: string; games: number; share: number; oneTrick: boolean };

export type BanSuggestion = {
  hero: string;
  score: number;
  /** Players in the lineup who play the hero, biggest share first. */
  players: BanPlayerShare[];
  /** Sum of every player's share of games on this hero (0 = nobody plays it). */
  overlap: number;
  meta: HeroMeta | null;
  /** True when the hero was added purely for being a strong ban, not for this lineup. */
  metaOnly: boolean;
};

// Weighting: the lineup drives the score, the meta scales it.
//   overlap        sum of each player's share of counted games on the hero
//   + one-tricks   a player who only plays this hero is a much better ban target
//   + spread       several players on the same hero means the ban hits harder
//   × meta         1 + win-rate edge (±8 points per 1% over/under 50%, capped) + ban rate
const ONE_TRICK_BONUS = 0.5;
const SPREAD_BONUS = 0.25;
const WIN_RATE_WEIGHT = 8;
const WIN_RATE_CAP = 0.4;
const MIN_GAMES_TO_COUNT = 2;

export function metaFactor(meta: HeroMeta | null | undefined): number {
  if (!meta) return 1;
  const edge = meta.winRate === null ? 0 : Math.max(-WIN_RATE_CAP, Math.min(WIN_RATE_CAP, (meta.winRate - 0.5) * WIN_RATE_WEIGHT));
  return 1 + edge + meta.banRate;
}

/** How many bans to suggest: one full ban phase for both teams (3 each). */
export const BAN_COUNT = 6;

export function recommendBans(lineup: LineupPlayer[], meta: Map<string, HeroMeta> | null, count = BAN_COUNT): BanSuggestion[] {
  const byHero = new Map<string, { players: BanPlayerShare[]; overlap: number; oneTricks: number }>();
  for (const p of lineup) {
    const overall = p.analysis.overall;
    if (overall.games === 0) continue;
    const trick = oneTrick(overall);
    for (const t of overall.heroes) {
      let entry = byHero.get(t.hero);
      if (!entry) {
        entry = { players: [], overlap: 0, oneTricks: 0 };
        byHero.set(t.hero, entry);
      }
      const share = t.games / overall.games;
      const isTrick = trick?.hero === t.hero;
      entry.players.push({ name: p.name, games: t.games, share, oneTrick: isTrick });
      entry.overlap += share;
      if (isTrick) entry.oneTricks++;
    }
  }

  const suggestions: BanSuggestion[] = [];
  for (const [hero, e] of byHero) {
    const regulars = e.players.filter((p) => p.games >= MIN_GAMES_TO_COUNT).length;
    const lineupScore = e.overlap + ONE_TRICK_BONUS * e.oneTricks + SPREAD_BONUS * Math.max(0, regulars - 1);
    const m = meta?.get(hero) ?? null;
    suggestions.push({
      hero,
      score: lineupScore * metaFactor(m),
      players: [...e.players].sort((a, b) => b.share - a.share),
      overlap: e.overlap,
      meta: m,
      metaOnly: false,
    });
  }
  suggestions.sort((a, b) => b.score - a.score || b.overlap - a.overlap);
  const picked = suggestions.slice(0, count);

  // Not enough lineup data (few players or few heroes): top up with the meta's most banned heroes.
  if (picked.length < count && meta) {
    const taken = new Set(picked.map((s) => s.hero));
    const fillers = [...meta.values()]
      .filter((m) => !taken.has(m.hero) && m.matches > 0)
      .sort((a, b) => b.banRate - a.banRate || (b.winRate ?? 0) - (a.winRate ?? 0));
    for (const m of fillers) {
      if (picked.length >= count) break;
      picked.push({ hero: m.hero, score: 0, players: [], overlap: 0, meta: m, metaOnly: true });
    }
  }
  return picked;
}

export const pct = (fraction: number | null | undefined, digits = 0) => (fraction === null || fraction === undefined ? "—" : `${(fraction * 100).toFixed(digits)}%`);
