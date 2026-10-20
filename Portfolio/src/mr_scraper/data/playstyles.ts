// The team-comp archetype each hero fits best, keyed by the names in heroes.ts.
// Hand-assigned from community comp guides, not from any site's data: many
// heroes fit more than one archetype, so this is each hero's most common home.
// Heroes marked "unsure" are newer or flexible picks; adjust them freely.
//   poke   wins from range: hitscan, projectiles and sustained ranged pressure
//   brawl  wins up close as a group: melee, short range, healing and shields in a ball
//   dive   wins by jumping the backline: mobile heroes picking off isolated targets

export type Playstyle = "poke" | "brawl" | "dive";

export const PLAYSTYLE_LABELS: Record<Playstyle, string> = { poke: "Poke", brawl: "Brawl", dive: "Dive" };

export const HERO_PLAYSTYLES: Record<string, Playstyle[]> = {
  // Vanguards
  Hulk: ["dive"],
  "Doctor Strange": ["poke"],
  "Captain America": ["dive"],
  Groot: ["brawl"],
  Venom: ["dive"],
  Magneto: ["brawl"],
  Thor: ["brawl"],
  "Peni Parker": ["brawl"],
  "The Thing": ["brawl"],
  "Emma Frost": ["brawl"],
  Angela: ["dive"],
  "Devil Dinosaur": ["brawl"], 
  Rogue: ["brawl"], 
  "The Hood": ["poke"], 
  "Deadpool (Vanguard)": ["brawl"], 

  // Duelists
  "The Punisher": ["poke"],
  Storm: ["poke"],
  "Human Torch": ["poke"],
  Hawkeye: ["poke"],
  Hela: ["poke"],
  "Black Panther": ["dive"],
  Magik: ["brawl"],
  "Moon Knight": ["poke"],
  "Squirrel Girl": ["poke"],
  "Black Widow": ["poke"],
  "Iron Man": ["poke"],
  "Spider-man": ["dive"],
  "Scarlet Witch": ["brawl"],
  "Mister Fantastic": ["brawl"],
  "Winter Soldier": ["brawl"],
  "Star-lord": ["dive"],
  Blade: ["brawl"],
  Namor: ["poke"],
  Psylocke: ["dive", "poke"],
  Wolverine: ["brawl"],
  "Iron Fist": ["dive"],
  Phoenix: ["poke"], 
  Daredevil: ["dive"], 
  "Elsa Bloodstone": ["poke"], 
  "Black Cat": ["dive", "brawl"],
  Cyclops: ["poke"], 
  "Gorr The God Butcher": ["brawl"], 
  "Deadpool (Duelist)": ["dive"], 

  // Strategists
  Loki: ["brawl"],
  Mantis: ["poke"],
  "Rocket Raccoon": ["dive"],
  "Cloak & Dagger": ["brawl"],
  Ultron: ["poke"],
  "Luna Snow": ["brawl"],
  "Adam Warlock": ["brawl"],
  "Jeff The Land Shark": ["brawl"],
  "Invisible Woman": ["brawl"],
  Gambit: ["dive"], 
  "White Fox": ["dive"], 
  Jubilee: ["brawl"],
  "Deadpool (Strategist)": ["brawl"],
};
