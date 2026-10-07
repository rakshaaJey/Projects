// Competitive data from Pokémon Showdown via @pkmn/dex: species, abilities,
// items, moves, natures and learnsets, all offline. Generation 9 (Scarlet /
// Violet) is the working ruleset. Learnsets are a separate 5 MB chunk that the
// package loads on first use.

import { Dex, type Item, type Move, type Nature, type Species } from "@pkmn/dex";
import { isType, type PokemonType } from "./data/typechart.ts";

export type { Item, Move, Nature, Species };

export const GEN = 9;
export const dex = Dex.forGen(GEN);

export type StatKey = "hp" | "atk" | "def" | "spa" | "spd" | "spe";
export const STAT_KEYS: StatKey[] = ["hp", "atk", "def", "spa", "spd", "spe"];
export const STAT_LABELS: Record<StatKey, string> = { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
export type Stats = Record<StatKey, number>;

export const zeroStats = (): Stats => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
export const maxIvs = (): Stats => ({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 });

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

export function getSpecies(name: string): Species | null {
  if (!name) return null;
  const s = dex.species.get(name);
  return s.exists && s.num > 0 ? s : null;
}

export function speciesTypes(s: Species): PokemonType[] {
  return s.types.map((t) => t.toLowerCase()).filter(isType);
}

let speciesCache: Species[] | null = null;

/** Every species (and forme) available in the current generation, dex order. */
export function allSpecies(): Species[] {
  if (!speciesCache) {
    speciesCache = dex.species
      .all()
      .filter((s) => s.exists && s.num > 0 && !s.isNonstandard)
      .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
  }
  return speciesCache;
}

export function searchSpecies(query: string, limit = 12): Species[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = allSpecies();
  const starts = all.filter((s) => s.name.toLowerCase().startsWith(q));
  const contains = all.filter((s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

export function abilitiesOf(s: Species): string[] {
  const a = s.abilities;
  return [...new Set([a[0], a[1], a.H, a.S].filter((x) => Boolean(x)).map((x) => String(x)))];
}

/** Base-form artwork from PokéAPI by dex number, with Showdown's sprite as the fallback. */
export function spriteUrls(s: Species): { primary: string; fallback: string } {
  return {
    primary: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${s.num}.png`,
    fallback: `https://play.pokemonshowdown.com/sprites/gen5/${s.id}.png`,
  };
}

// ---------------------------------------------------------------------------
// Items, natures, moves
// ---------------------------------------------------------------------------

let itemCache: Item[] | null = null;

/** Held items usable in the current generation (no Poké Balls, Mega Stones or Z-Crystals). */
export function allItems(): Item[] {
  if (!itemCache) {
    itemCache = dex.items
      .all()
      .filter((i) => i.exists && !i.isNonstandard && !i.megaStone && !i.zMove && !(i as { isPokeball?: boolean }).isPokeball)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return itemCache;
}

export function getItem(name: string): Item | null {
  if (!name) return null;
  const i = dex.items.get(name);
  return i.exists ? i : null;
}

let natureCache: Nature[] | null = null;

export function allNatures(): Nature[] {
  if (!natureCache) natureCache = dex.natures.all().filter((n) => n.exists).sort((a, b) => a.name.localeCompare(b.name));
  return natureCache;
}

export function getNature(name: string): Nature | null {
  if (!name) return null;
  const n = dex.natures.get(name);
  return n.exists ? n : null;
}

export function natureLabel(n: Nature): string {
  return n.plus && n.minus ? `${n.name} (+${STAT_LABELS[n.plus]} −${STAT_LABELS[n.minus]})` : `${n.name} (neutral)`;
}

export function getMove(name: string): Move | null {
  if (!name) return null;
  const m = dex.moves.get(name);
  return m.exists ? m : null;
}

const learnsetCache = new Map<string, Promise<Move[]>>();

/**
 * Moves the species can legally know in this generation: its own learnset plus
 * its pre-evolutions and base forme. Falls back to every generation's data when
 * nothing is tagged for the current one (some formes only carry older tags).
 */
export function legalMoves(s: Species): Promise<Move[]> {
  const cached = learnsetCache.get(s.id);
  if (cached) return cached;
  const promise = (async () => {
    const ids = new Set<string>();
    const chain: Species[] = [];
    const seen = new Set<string>();
    let cur: Species | null = s;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      const base = cur.baseSpecies !== cur.name ? getSpecies(cur.baseSpecies) : null;
      if (base && !seen.has(base.id)) chain.push(base), seen.add(base.id);
      cur = cur.prevo ? getSpecies(cur.prevo) : null;
    }
    const collect = (currentGenOnly: boolean) => {
      ids.clear();
      for (const sp of chain) {
        const learnset = learnsets.get(sp.id);
        for (const [moveId, sources] of Object.entries(learnset ?? {})) {
          if (!currentGenOnly || sources.some((src) => src.startsWith(String(GEN)))) ids.add(moveId);
        }
      }
    };
    const learnsets = new Map<string, Record<string, string[]> | undefined>();
    for (const sp of chain) learnsets.set(sp.id, (await dex.learnsets.get(sp.id)).learnset);
    collect(true);
    if (ids.size === 0) collect(false);
    return [...ids]
      .map((id) => dex.moves.getByID(id as never))
      .filter((m) => m.exists && !m.isNonstandard)
      .sort((a, b) => a.name.localeCompare(b.name));
  })();
  learnsetCache.set(s.id, promise);
  return promise;
}

/** Type names as the games capitalise them, for Tera type pickers. */
export function typeNames(): string[] {
  return dex.types
    .all()
    .filter((t) => t.exists && !t.isNonstandard)
    .map((t) => t.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** The games' stat formula. Nature is 1.1 / 0.9 / 1 on non-HP stats; Shedinja-style 1 HP stays 1. */
export function calcStat(key: StatKey, base: number, iv: number, ev: number, level: number, nature: Nature | null): number {
  const core = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  if (key === "hp") return base === 1 ? 1 : core + level + 10;
  const mod = nature?.plus === key ? 1.1 : nature?.minus === key ? 0.9 : 1;
  return Math.floor((core + 5) * mod);
}

export function computeStats(s: Species, evs: Stats, ivs: Stats, level: number, natureName: string): Stats {
  const nature = getNature(natureName);
  const out = zeroStats();
  for (const key of STAT_KEYS) out[key] = calcStat(key, s.baseStats[key], ivs[key], evs[key], level, nature);
  return out;
}
