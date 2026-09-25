import { useEffect, useState } from "preact/hooks";

// Namespaced so keys never collide with the desktop page on the same origin.
const PREFIX = "val_scraper:";

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage may be full, disabled, or unavailable in private mode; the page still works without it.
  }
}

export function clearStored(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // ignore
    }
  }
}

/**
 * Like useState, but the value is restored from localStorage on first render
 * and written back whenever it changes. `serialize` lets callers drop
 * transient parts (such as in-progress requests) before saving.
 */
export function usePersistentState<T>(
  key: string,
  initial: () => T,
  serialize: (value: T) => T = (v) => v,
): [T, (update: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = read<T>(key);
    return stored === undefined ? initial() : stored;
  });

  useEffect(() => {
    write(key, serialize(value));
  }, [key, value]);

  return [value, setValue];
}
