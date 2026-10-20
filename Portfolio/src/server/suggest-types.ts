// Request and response shapes shared by the page and the suggestion server function.

export type StatBlock = { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };

export type SuggestRequest = {
  generation: number;
  format: "singles" | "vgc";
  playstyle: string;
  /** Plain-English ruleset, e.g. a VGC regulation and what it allows; empty for singles. */
  ruleset: string;
  notes: string;
  team: {
    species: string;
    types: string[];
    ability: string;
    item: string;
    nature: string;
    teraType: string;
    level: number;
    evs: StatBlock;
    moves: string[];
    baseStats: StatBlock | null;
    speed: number | null;
  }[];
  analysis: {
    problems: { type: string; net: number; weak: string[] }[];
    strengths: string[];
    uncoveredOffense: string[];
  };
  openSlots: number;
};

export type Suggestion = {
  species: string;
  role: string;
  why: string;
  /** Species this would replace when the team is full; empty when it fills an open slot. */
  replaces: string;
  set: {
    ability: string;
    item: string;
    nature: string;
    tera_type: string;
    evs: StatBlock;
    moves: string[];
  };
  alternatives: string[];
};

export type SuggestResponse = {
  suggestions: Suggestion[];
  team_notes: string;
};
