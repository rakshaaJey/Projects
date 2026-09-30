// Hero classes from rivalsmeta.com's hero dictionary (bundle chunk COSizvdV.js,
// captured 2026-09-29): class 1 = Vanguard (tank), 2 = Duelist (DPS),
// 3 = Strategist (support). Deadpool's per-class variants carry their own ids.
// Regenerate alongside heroes.ts when new heroes are added.

export type Role = "tank" | "dps" | "support";

export const ROLE_LABELS: Record<Role, string> = { tank: "Tank", dps: "DPS", support: "Support" };

export const HERO_ROLES: Record<number, Role> = {
  1011: "tank", // Hulk
  1014: "dps", // The Punisher
  1015: "dps", // Storm
  1016: "support", // Loki
  1017: "dps", // Human Torch
  1018: "tank", // Doctor Strange
  1020: "support", // Mantis
  1021: "dps", // Hawkeye
  1022: "tank", // Captain America
  1023: "support", // Rocket Raccoon
  1024: "dps", // Hela
  1025: "support", // Cloak & Dagger
  1026: "dps", // Black Panther
  1027: "tank", // Groot
  1028: "support", // Ultron
  1029: "dps", // Magik
  1030: "dps", // Moon Knight
  1031: "support", // Luna Snow
  1032: "dps", // Squirrel Girl
  1033: "dps", // Black Widow
  1034: "dps", // Iron Man
  1035: "tank", // Venom
  1036: "dps", // Spider-man
  1037: "tank", // Magneto
  1038: "dps", // Scarlet Witch
  1039: "tank", // Thor
  1040: "dps", // Mister Fantastic
  1041: "dps", // Winter Soldier
  1042: "tank", // Peni Parker
  1043: "dps", // Star-lord
  1044: "dps", // Blade
  1045: "dps", // Namor
  1046: "support", // Adam Warlock
  1047: "support", // Jeff The Land Shark
  1048: "dps", // Psylocke
  1049: "dps", // Wolverine
  1050: "support", // Invisible Woman
  1051: "tank", // The Thing
  1052: "dps", // Iron Fist
  1053: "tank", // Emma Frost
  1054: "dps", // Phoenix
  1055: "dps", // Daredevil
  1056: "tank", // Angela
  1058: "support", // Gambit
  1059: "dps", // Elsa Bloodstone
  1060: "support", // White Fox
  1061: "dps", // Black Cat
  1062: "tank", // Devil Dinosaur
  1063: "dps", // Cyclops
  1064: "support", // Jubilee
  1065: "tank", // Rogue
  1066: "tank", // The Hood
  1067: "dps", // Gorr The God Butcher
  10571: "tank", // Deadpool (Vanguard)
  10572: "dps", // Deadpool (Duelist)
  10573: "support", // Deadpool (Strategist)
};

/** Role for a hero id; variant ids (e.g. 10571) are looked up directly, other unknown ids fall back to the base hero. */
export function heroRole(id: number | undefined): Role | null {
  if (id === undefined || id === null) return null;
  const direct = HERO_ROLES[id];
  if (direct) return direct;
  if (id >= 10000) return HERO_ROLES[Math.floor(id / 10)] ?? null;
  return null;
}
