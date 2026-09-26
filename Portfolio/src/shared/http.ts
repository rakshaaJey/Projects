// Shared JSON fetch helper for the scraper pages: friendly error messages and
// automatic retry when the upstream API rate-limits us (HTTP 429).

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type RequestOptions = {
  signal?: AbortSignal;
  /** Called once per second while waiting out a rate limit, with the seconds left. */
  onRateLimit?: (secondsLeft: number, attempt: number) => void;
};

type JsonRequestConfig = RequestOptions & {
  /** HTTP method; defaults to GET. */
  method?: "GET" | "POST";
  /** JSON body to send (sets Content-Type: application/json). */
  json?: unknown;
  /** Status code -> message shown when the body carries no message of its own. */
  friendly?: Record<number, string>;
  /** Pulls an error message out of a non-2xx JSON body, if the API provides one. */
  extractError?: (body: unknown) => string | undefined;
};

// When the API answers 429, wait this long (unless it says otherwise) and retry.
const RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;
const RATE_LIMIT_MAX_RETRIES = 3;

function rateLimitWaitMs(res: Response): number {
  // Prefer the API's own guidance. Retry-After is either seconds or an HTTP date.
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, RATE_LIMIT_MAX_WAIT_MS);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date) && date > Date.now()) return Math.min(date - Date.now(), RATE_LIMIT_MAX_WAIT_MS);
  }
  // Some APIs only send a reset time as a Unix timestamp in seconds.
  const reset = Number(res.headers.get("X-RateLimit-Reset"));
  if (Number.isFinite(reset) && reset > 1_000_000_000) {
    const ms = reset * 1000 - Date.now();
    if (ms > 0) return Math.min(ms, RATE_LIMIT_MAX_WAIT_MS);
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
  const deadline = Date.now() + rateLimitWaitMs(res);
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    options.onRateLimit?.(Math.max(left, 0), attempt);
    if (left <= 0) return;
    await sleep(Math.min(1000, deadline - Date.now()), options.signal);
  }
}

/** Requests `url` (GET by default), retrying on 429, and returns the parsed JSON body with its status. */
export async function requestJson<T>(url: string, config: JsonRequestConfig = {}): Promise<{ status: number; body: T }> {
  const { signal, friendly = {}, extractError, method = "GET", json } = config;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, signal, headers, body: json !== undefined ? JSON.stringify(json) : undefined };
  let res = await fetch(url, init);
  for (let attempt = 1; res.status === 429 && attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await waitOutRateLimit(res, attempt, config);
    res = await fetch(url, init);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body ? extractError?.(body) : undefined;
    const fallback: Record<number, string> = {
      429: "Still rate limited after several retries. Wait a few minutes and try again.",
      503: "The API is temporarily unavailable.",
      ...friendly,
    };
    throw new ApiError(detail || fallback[res.status] || `Request failed (${res.status})`, res.status);
  }
  if (body === null) throw new ApiError("Unexpected response from the API.", res.status);
  return { status: res.status, body: body as T };
}
