import { defensiveMultiplier, effectiveness, TYPES, type PokemonType } from "./data/typechart.ts";

/** What the coverage maths needs to know about a party member. */
export type Member = { name: string; types: PokemonType[]; speed: number; baseSpeed: number };

/** How the party fares against one attacking type. */
export type DefenseRow = {
  type: PokemonType;
  weak: Member[]; // take 2x or more
  veryWeak: Member[]; // take 4x
  resist: Member[]; // take 0.5x or less (but not 0)
  immune: Member[];
  /** weak minus resist/immune: positive means the type is a problem for the party. */
  net: number;
};

export function partyDefense(party: Member[]): DefenseRow[] {
  return TYPES.map((type) => {
    const weak: Member[] = [];
    const veryWeak: Member[] = [];
    const resist: Member[] = [];
    const immune: Member[] = [];
    for (const p of party) {
      const m = defensiveMultiplier(type, p.types);
      if (m === 0) immune.push(p);
      else if (m >= 4) {
        veryWeak.push(p);
        weak.push(p);
      } else if (m >= 2) weak.push(p);
      else if (m < 1) resist.push(p);
    }
    return { type, weak, veryWeak, resist, immune, net: weak.length - resist.length - immune.length };
  });
}

/** Types that the party's own (STAB) types hit for 2x, and those nothing in the party hits super-effectively. */
export type OffenseRow = { type: PokemonType; best: number; by: PokemonType[] };

export function partyOffense(party: Member[]): OffenseRow[] {
  const stab = [...new Set(party.flatMap((p) => p.types))];
  return TYPES.map((defending) => {
    let best = 0;
    const by: PokemonType[] = [];
    for (const atk of stab) {
      const m = effectiveness(atk, defending);
      if (m > best) best = m;
      if (m >= 2) by.push(atk);
    }
    return { type: defending, best: stab.length ? best : 1, by };
  });
}

/**
 * Types worth adding: for each candidate type, how many of the party's net
 * weaknesses it would resist, minus new weaknesses it would bring on its own.
 */
export type Suggestion = { type: PokemonType; patches: PokemonType[]; score: number };

export function suggestTypes(defense: DefenseRow[]): Suggestion[] {
  const problems = defense.filter((r) => r.net > 0);
  if (problems.length === 0) return [];
  return TYPES.map((candidate) => {
    const patches = problems.filter((r) => effectiveness(r.type, candidate) < 1).map((r) => r.type);
    const selfWeak = TYPES.filter((atk) => effectiveness(atk, candidate) >= 2).length;
    return { type: candidate, patches, score: patches.length * 2 - selfWeak * 0.25 };
  })
    .filter((s) => s.patches.length > 0)
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type))
    .slice(0, 5);
}

/** Party members fastest first, with their actual speed stat (nature, EVs and level applied). */
export function speedTiers(party: Member[]): Member[] {
  return [...party].sort((a, b) => b.speed - a.speed || a.name.localeCompare(b.name));
}
