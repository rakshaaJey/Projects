// Players MR_Scraper will not look up. Checked against the name typed into the
// form and against the display name that comes back from a UID lookup, so a UID
// is no way around it. Matching ignores case and surrounding spaces; otherwise
// the name must be exact, since "ceiIing" (capital i) and "ceiling" are
// different accounts.

const BLOCKED_NAMES = ["BeanLegs", "Shibocage", "hannapork", "Pro Tax Evader", "ceiIing", "Sawed", "G4M3ROMAR", "EyoA1exander"];

const normalize = (name: string) => name.trim().toLowerCase();

const BLOCKED = new Set(BLOCKED_NAMES.map(normalize));

/** Whether this player is kept off the site. */
export function isBlocked(name: string | undefined | null): boolean {
  return Boolean(name) && BLOCKED.has(normalize(name as string));
}
