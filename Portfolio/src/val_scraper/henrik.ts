// Thin client for the HenrikDev unofficial Valorant API.
//
// Requests go through `/api/henrik/*`, which is proxied to
// https://api.henrikdev.xyz with the API key attached server-side
// (see vite.config.ts for dev/preview and functions/api/henrik for production).

import { ApiError, requestJson, type RequestOptions } from "../shared/http.ts";

export { ApiError as HenrikError };
export type { RequestOptions };

export const HENRIK_PROXY_BASE = "/api/henrik";

export type Region = "na" | "eu" | "ap" | "kr" | "latam" | "br";

export type Account = {
  puuid: string;
  region: Region;
  name: string;
  tag: string;
  account_level: number;
};

export type StoredMatch = {
  meta: {
    id: string;
    map: { id: string; name: string };
    mode: string;
    started_at: string;
    season: { id: string; short: string };
    region: string;
  };
  stats: {
    puuid: string;
    team: string;
    character: { id: string; name: string };
    tier: number;
    kills: number;
    deaths: number;
    assists: number;
  };
  teams: { red: number; blue: number };
};

type Envelope<T> = {
  status: number;
  data?: T;
  results?: { total: number; returned: number; before: number; after: number };
  errors?: { code: number; message: string; status: number }[];
};

const FRIENDLY: Record<number, string> = {
  401: "The API key is missing or invalid. Locally, set HENRIKDEV_API_KEY in .env and restart the dev server; in production, set it in the Cloudflare project's variables and redeploy.",
  404: "Player not found. Check the name and tag.",
  500: "The server-side API key is not configured. Set HENRIKDEV_API_KEY in the Cloudflare project's variables and redeploy.",
};

const extractError = (body: unknown): string | undefined => {
  const message = (body as Envelope<unknown>)?.errors?.[0]?.message;
  return typeof message === "string" ? message : undefined;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { body } = await requestJson<Envelope<T>>(`${HENRIK_PROXY_BASE}${path}`, { ...options, friendly: FRIENDLY, extractError });
  return body;
}

export async function lookupAccount(name: string, tag: string, options: RequestOptions = {}): Promise<Account> {
  const body = await request<Account>(`/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, options);
  if (!body.data) throw new ApiError("Account lookup returned no data.", body.status);
  return body.data;
}

const PAGE_SIZE = 100;

/**
 * Fetches the player's stored competitive matches, newest first, walking pages
 * until the API runs out or `maxPages` is reached.
 */
export async function fetchCompetitiveMatches(
  region: Region,
  name: string,
  tag: string,
  options: RequestOptions & { maxPages?: number; onPage?: (fetched: number, total: number) => void } = {},
): Promise<StoredMatch[]> {
  const { maxPages = 5, onPage, ...requestOptions } = options;
  const matches: StoredMatch[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ mode: "competitive", size: String(PAGE_SIZE), page: String(page) });
    const body = await request<StoredMatch[]>(
      `/valorant/v1/stored-matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?${query}`,
      requestOptions,
    );
    const batch = body.data ?? [];
    matches.push(...batch);
    const total = body.results?.total ?? matches.length;
    onPage?.(matches.length, total);
    if (batch.length < PAGE_SIZE || matches.length >= total) break;
  }
  return matches;
}
