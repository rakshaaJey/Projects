// A party member's full competitive set, plus Showdown text import/export
// (via @pkmn/sets) and legality checks against the dex.

import { Sets, Teams, type Data, type PokemonSet } from "@pkmn/sets";
import {
  abilitiesOf,
  allNatures,
  dex,
  getItem,
  getMove,
  getNature,
  getSpecies,
  legalMoves,
  maxIvs,
  STAT_KEYS,
  typeNames,
  zeroStats,
  type Species,
  type Stats,
} from "./dex.ts";

export const EV_MAX = 252;
export const EV_TOTAL = 510;
export const MOVE_SLOTS = 4;
export const PARTY_SIZE = 6;

export type TeamSet = {
  species: string;
  /** Nickname, optional. */
  name: string;
  ability: string;
  item: string;
  nature: string;
  teraType: string;
  level: number;
  evs: Stats;
  ivs: Stats;
  /** Up to four move names; empty strings are unfilled slots. */
  moves: string[];
};

const data = dex as unknown as Data;

export function defaultSet(species: Species, level: number): TeamSet {
  return {
    species: species.name,
    name: "",
    ability: abilitiesOf(species)[0] ?? "",
    item: "",
    nature: "Hardy",
    teraType: species.types[0],
    level,
    evs: zeroStats(),
    ivs: maxIvs(),
    moves: ["", "", "", ""],
  };
}

export const evTotal = (evs: Stats) => STAT_KEYS.reduce((sum, k) => sum + (evs[k] || 0), 0);

const fullStats = (partial: Partial<Stats> | undefined, fill: number): Stats => {
  const out = zeroStats();
  for (const k of STAT_KEYS) out[k] = partial && typeof partial[k] === "number" ? partial[k]! : fill;
  return out;
};

export function toPokemonSet(set: TeamSet): Partial<PokemonSet<string>> {
  return {
    name: set.name || undefined,
    species: set.species,
    item: set.item || undefined,
    ability: set.ability || undefined,
    nature: set.nature || undefined,
    teraType: set.teraType || undefined,
    level: set.level,
    evs: set.evs,
    ivs: set.ivs,
    moves: set.moves.filter((m) => m),
  };
}

export function fromPokemonSet(p: Partial<PokemonSet<string>>, defaultLevel: number): TeamSet | null {
  const species = getSpecies(p.species ?? p.name ?? "");
  if (!species) return null;
  const base = defaultSet(species, p.level || defaultLevel);
  return {
    ...base,
    name: p.name && p.name !== species.name ? p.name : "",
    ability: p.ability || base.ability,
    item: p.item || "",
    nature: p.nature || base.nature,
    teraType: p.teraType || base.teraType,
    evs: fullStats(p.evs, 0),
    ivs: fullStats(p.ivs, 31),
    moves: [...(p.moves ?? []).slice(0, MOVE_SLOTS), "", "", "", ""].slice(0, MOVE_SLOTS),
  };
}

/** Showdown export text for the whole team. */
export function exportTeam(team: TeamSet[]): string {
  return team
    .map((s) => Sets.exportSet(toPokemonSet(s), data).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Parses Showdown export text; unknown species are reported, the rest imported. */
export function importTeam(text: string, defaultLevel: number): { sets: TeamSet[]; errors: string[] } {
  const parsed = Teams.importTeam(text, data);
  const sets: TeamSet[] = [];
  const errors: string[] = [];
  for (const p of parsed?.team ?? []) {
    const set = fromPokemonSet(p, defaultLevel);
    if (set) sets.push(set);
    else errors.push(`Unknown Pokémon "${p.species ?? p.name ?? "?"}"`);
  }
  if (sets.length === 0 && errors.length === 0) errors.push("No sets found. Paste text in Pokémon Showdown's export format.");
  return { sets: sets.slice(0, PARTY_SIZE), errors };
}

/** Human-readable legality problems with a set; an empty list means it is fine. */
export async function validateSet(set: TeamSet): Promise<string[]> {
  const issues: string[] = [];
  const species = getSpecies(set.species);
  if (!species) return [`Unknown Pokémon "${set.species}"`];
  if (set.ability && !abilitiesOf(species).includes(set.ability)) issues.push(`${species.name} cannot have the ability ${set.ability}`);
  if (set.item && !getItem(set.item)) issues.push(`Unknown item "${set.item}"`);
  if (set.nature && !getNature(set.nature)) issues.push(`Unknown nature "${set.nature}"`);
  if (set.teraType && !typeNames().includes(set.teraType)) issues.push(`Unknown Tera type "${set.teraType}"`);
  const total = evTotal(set.evs);
  if (total > EV_TOTAL) issues.push(`EVs add up to ${total}; the limit is ${EV_TOTAL}`);
  for (const k of STAT_KEYS) {
    if (set.evs[k] > EV_MAX || set.evs[k] < 0) issues.push(`${k.toUpperCase()} EVs must be between 0 and ${EV_MAX}`);
    if (set.ivs[k] > 31 || set.ivs[k] < 0) issues.push(`${k.toUpperCase()} IVs must be between 0 and 31`);
  }
  if (set.level < 1 || set.level > 100) issues.push("Level must be between 1 and 100");
  const moves = set.moves.filter((m) => m);
  if (moves.length > MOVE_SLOTS) issues.push(`More than ${MOVE_SLOTS} moves`);
  const seen = new Set<string>();
  const legal = new Set((await legalMoves(species)).map((m) => m.id));
  for (const name of moves) {
    const move = getMove(name);
    if (!move) {
      issues.push(`Unknown move "${name}"`);
      continue;
    }
    if (seen.has(move.id)) issues.push(`${move.name} is listed twice`);
    seen.add(move.id);
    if (!legal.has(move.id)) issues.push(`${species.name} cannot learn ${move.name}`);
  }
  return issues;
}

/** Lists a nature that is neutral, for defaults. */
export const NEUTRAL_NATURE = allNatures().find((n) => !n.plus)?.name ?? "Hardy";
