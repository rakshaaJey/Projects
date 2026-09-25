// Thin client for the HenrikDev unofficial Valorant API.
//
// Requests go through `/api/henrik/*`, which is proxied to
// https://api.henrikdev.xyz with the API key attached server-side
// (see vite.config.ts for dev/preview and functions/api/henrik for production).

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

export class HenrikError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HenrikError";
    this.status = status;
  }
}

export type RequestOptions = {
  signal?: AbortSignal;
  /** Called once per second while waiting out a rate limit, with the seconds left. */
  onRateLimit?: (secondsLeft: number, attempt: number) => void;
};

// When the API answers 429, wait this long (unless it says otherwise) and retry.
const RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_MAX_RETRIES = 3;

function rateLimitWaitMs(res: Response): number {
  // Prefer the API's own guidance. Retry-After is either seconds or an HTTP date.
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 5 * 60_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date) && date > Date.now()) return Math.min(date - Date.now(), 5 * 60_000);
  }
  return RATE_LIMIT_WAIT_MS;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitOutRateLimit(res: Response, attempt: number, options: RequestOptions): Promise<void> {
  const total = rateLimitWaitMs(res);
  const deadline = Date.now() + total;
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    options.onRateLimit?.(Math.max(left, 0), attempt);
    if (left <= 0) return;
    await sleep(Math.min(1000, deadline - Date.now()), options.signal);
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { signal } = options;
  let res = await fetch(`${HENRIK_PROXY_BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  for (let attempt = 1; res.status === 429 && attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await waitOutRateLimit(res, attempt, options);
    res = await fetch(`${HENRIK_PROXY_BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  }
  const text = await res.text();
  let body: Envelope<T> | null = null;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.errors?.[0]?.message;
    const friendly: Record<number, string> = {
      401: "The API key is missing or invalid. Set HENRIKDEV_API_KEY in .env and restart the dev server.",
      404: "Player not found. Check the name and tag.",
      429: "Still rate limited after several retries. Wait a few minutes and try again.",
      503: "The API is temporarily unavailable.",
    };
    throw new HenrikError(detail || friendly[res.status] || `Request failed (${res.status})`, res.status);
  }
  if (!body) throw new HenrikError("Unexpected response from the API.", res.status);
  return body;
}

export async function lookupAccount(name: string, tag: string, options: RequestOptions = {}): Promise<Account> {
  const body = await request<Account>(`/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, options);
  if (!body.data) throw new HenrikError("Account lookup returned no data.", body.status);
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
