// Hero portraits for MR_Scraper: the game's own hero-select art (texture
// img_selecthero_<id>001), the picture every stats site shows for a hero,
// psylocke.gg included. Served from this project rather than hotlinked:
// psylocke.gg sits behind a bot challenge that turns cross-site image requests
// away, so its copies cannot be embedded. These were taken from rivalsmeta.com's
// static files (/images/heroes/SelectHero/, 2026-10-07) and shrunk to 128 px
// WebP; they live in public/mr_scraper/heroes/<id>.webp. Add a file there when
// heroes.ts gains a hero.

import { HEROES } from "./heroes.ts";

const ID_BY_NAME = new Map(Object.entries(HEROES).map(([id, name]) => [name, Number(id)]));

/** URL of the hero's portrait, or null for a hero the table does not know yet (a new release). */
export function heroPortrait(hero: string): string | null {
  const id = ID_BY_NAME.get(hero);
  return id === undefined ? null : `/mr_scraper/heroes/${id}.webp`;
}
