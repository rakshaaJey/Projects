// Client side of the AI team suggestions: builds the request from the party,
// goals and coverage analysis, calls /api/ai/suggest (a server function that
// holds the OpenAI key), and checks every suggestion against the dex before
// it is shown, so an illegal move or ability never reaches the party.

import type { DefenseRow, Member, OffenseRow } from "./analysis.ts";
import { getSpecies, STAT_KEYS, type Species, type Stats } from "./dex.ts";
import { defaultSet, validateSet, type TeamSet } from "./sets.ts";
import type { SuggestRequest, SuggestResponse, Suggestion } from "../server/suggest-types.ts";

export type { SuggestResponse, Suggestion };

export type Goals = {
  format: "singles" | "vgc";
  playstyle: string;
  /** VGC regulation id from VGC_REGULATIONS, or "custom". */
  ruleset: string;
  /** Free-text rules used when ruleset is "custom". */
  customRules: string;
  notes: string;
};

/** Scarlet/Violet VGC regulation sets, newest first, plus the Pokémon Champions format. */
export const VGC_REGULATIONS: { id: string; label: string; rules: string }[] = [
  { id: "reg-i", label: "Regulation I (current, from April 2026)", rules: "Regulation Set I: any Pokémon in the Scarlet/Violet dex including HOME transfers; up to two restricted Legendaries per team (Mewtwo, Lugia, Ho-Oh, Kyogre, Groudon, Rayquaza, Dialga, Palkia, Giratina, Reshiram, Zekrom, Kyurem, Solgaleo, Lunala, Necrozma, Zacian, Zamazenta, Eternatus, Calyrex, Koraidon, Miraidon, Terapagos); Mythical Pokémon banned; no duplicate species or items." },
  { id: "reg-h", label: "Regulation H (no Legendaries or Paradox)", rules: "Regulation Set H: no Legendary, Mythical, Paradox or Ultra Beast Pokémon; everything else in the Scarlet/Violet dex including HOME transfers; no duplicate species or items." },
  { id: "reg-g", label: "Regulation G (one restricted Legendary)", rules: "Regulation Set G: one restricted Legendary per team; Paradox and sub-legendaries allowed; Mythicals banned; no duplicate species or items." },
  { id: "reg-f", label: "Regulation F (no restricted Legendaries)", rules: "Regulation Set F: full Scarlet/Violet dex including both DLCs and HOME transfers, but no restricted Legendaries and no Mythicals; no duplicate species or items." },
  { id: "reg-e", label: "Regulation E (Teal Mask era)", rules: "Regulation Set E: Paldea and Kitakami dex Pokémon plus HOME transfers; no restricted Legendaries or Mythicals; no duplicate species or items." },
  { id: "reg-d", label: "Regulation D (HOME transfers, pre-DLC)", rules: "Regulation Set D: Paldea dex plus Pokémon transferred via HOME; no restricted Legendaries or Mythicals; no duplicate species or items." },
  { id: "reg-c", label: "Regulation C (Paradox and Treasures of Ruin)", rules: "Regulation Set C: Paldea dex only, Paradox Pokémon and the Treasures of Ruin allowed; no Legendaries otherwise; no duplicate species or items." },
  { id: "reg-b", label: "Regulation B (Paradox allowed)", rules: "Regulation Set B: Paldea dex only with Paradox Pokémon allowed; no Treasures of Ruin, Legendaries or Mythicals; no duplicate species or items." },
  { id: "reg-a", label: "Regulation A (Paldea dex only)", rules: "Regulation Set A: Paldea dex only; no Paradox Pokémon, Treasures of Ruin, Legendaries or Mythicals; no duplicate species or items." },
  { id: "champions-ma", label: "Pokémon Champions, Regulation M-A", rules: "Pokémon Champions Regulation Set M-A: doubles, no Legendary, restricted or Mythical Pokémon; no duplicate species or items." },
  { id: "custom", label: "Custom rules (describe below)", rules: "" },
];

export function rulesetText(goals: Goals): string {
  if (goals.format !== "vgc") return "";
  const reg = VGC_REGULATIONS.find((r) => r.id === goals.ruleset);
  if (!reg || reg.id === "custom") return goals.customRules.trim() ? `Custom VGC rules: ${goals.customRules.trim()}` : "VGC doubles, standard rules";
  return reg.rules;
}

export const FORMATS: { id: Goals["format"]; label: string; level: number }[] = [
  { id: "singles", label: "Singles (6v6, level 100)", level: 100 },
  { id: "vgc", label: "VGC doubles (bring 4 of 6, level 50)", level: 50 },
];

export const PLAYSTYLES = ["Balance", "Hyper offense", "Bulky offense", "Stall", "Trick Room", "Rain", "Sun", "Sand", "Snow", "Screens offense"];

export const DEFAULT_GOALS: Goals = { format: "singles", playstyle: "Balance", ruleset: "reg-i", customRules: "", notes: "" };

/** Fills in fields missing from goals saved by an older version of the page. */
export const normalizeGoals = (g: Partial<Goals> | null | undefined): Goals => ({ ...DEFAULT_GOALS, ...(g ?? {}) });

export const levelForFormat = (format: Goals["format"]) => FORMATS.find((f) => f.id === format)?.level ?? 100;

export function buildRequest(team: TeamSet[], members: Member[], goals: Goals, defense: DefenseRow[], offense: OffenseRow[]): SuggestRequest {
  const bySpecies = new Map(members.map((m) => [m.name, m]));
  return {
    generation: 9,
    format: goals.format,
    playstyle: goals.playstyle,
    ruleset: rulesetText(goals).slice(0, 600),
    notes: goals.notes.trim().slice(0, 1000),
    team: team.map((s) => {
      const species = getSpecies(s.species);
      const m = bySpecies.get(s.species);
      return {
        species: s.species,
        types: m?.types ?? [],
        ability: s.ability,
        item: s.item,
        nature: s.nature,
        teraType: s.teraType,
        level: s.level,
        evs: s.evs,
        moves: s.moves.filter(Boolean),
        baseStats: species ? { ...species.baseStats } : null,
        speed: m?.speed ?? null,
      };
    }),
    analysis: {
      problems: defense.filter((r) => r.net > 0).map((r) => ({ type: r.type, net: r.net, weak: r.weak.map((p) => p.name) })),
      strengths: defense.filter((r) => r.net < 0).map((r) => r.type),
      uncoveredOffense: offense.filter((r) => r.best < 2).map((r) => r.type),
    },
    openSlots: 6 - team.length,
  };
}

export async function requestSuggestions(body: SuggestRequest): Promise<SuggestResponse> {
  const res = await fetch("/api/ai/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string" ? (json as { message: string }).message : `Request failed (${res.status})`;
    throw new Error(message);
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as SuggestResponse).suggestions)) throw new Error("The suggestion service returned an unexpected response.");
  return json as SuggestResponse;
}

/** A suggestion after checking it against the dex: a ready-to-add set plus anything that had to be fixed. */
export type CheckedSuggestion = {
  suggestion: Suggestion;
  species: Species | null;
  set: TeamSet | null;
  /** Problems found; illegal moves are removed from `set` and listed here. */
  issues: string[];
};

export async function checkSuggestion(s: Suggestion, level: number): Promise<CheckedSuggestion> {
  const species = getSpecies(s.species);
  if (!species) return { suggestion: s, species: null, set: null, issues: [`"${s.species}" is not a Pokémon in this generation`] };
  const evs = { ...defaultSet(species, level).evs } as Stats;
  for (const k of STAT_KEYS) evs[k] = Math.max(0, Math.min(252, Math.round(Number(s.set.evs?.[k]) || 0)));
  const set: TeamSet = {
    ...defaultSet(species, level),
    ability: s.set.ability || defaultSet(species, level).ability,
    item: s.set.item ?? "",
    nature: s.set.nature || "Hardy",
    teraType: s.set.tera_type || species.types[0],
    evs,
    moves: [...(s.set.moves ?? []).slice(0, 4), "", "", "", ""].slice(0, 4),
  };
  let issues = await validateSet(set);
  // Drop any move the species cannot learn (or that does not exist) so the set is addable as-is.
  const bad = new Set(issues.filter((i) => /cannot learn|Unknown move|listed twice/.test(i)).map((i) => i.match(/"([^"]+)"|learn (.+)$/)?.[1] ?? i.match(/learn (.+)$/)?.[1] ?? ""));
  if (bad.size > 0) {
    set.moves = set.moves.map((m) => (bad.has(m) ? "" : m));
    issues = [...issues.filter((i) => !/cannot learn|Unknown move|listed twice/.test(i)), ...[...bad].filter(Boolean).map((m) => `Removed ${m}: not a legal move here`)];
  }
  return { suggestion: s, species, set, issues };
}
