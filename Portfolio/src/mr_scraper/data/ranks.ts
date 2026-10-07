// Rank badges for MR_Scraper: the game's own tier icons (texture img_rank_dan_01..09,
// Bronze through One Above All), taken from rivalsmeta.com's static files
// (/images/DanIcon/, 2026-10-07) and shrunk to 128 px WebP. The icon is per tier;
// the division ("Diamond 2") and score are written in the caption. Files live in
// public/mr_scraper/ranks/<tier>.webp.

import type { RankTier } from "../rank.ts";

/** URL of the tier's badge, or null for an unranked player. */
export function rankBadge(tier: RankTier): string | null {
  return tier === "unranked" ? null : `/mr_scraper/ranks/${tier}.webp`;
}
