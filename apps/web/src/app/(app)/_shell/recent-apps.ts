/**
 * Recently visited apps (most recent first), shared by the launcher's Recent
 * group and the rail's MRU tiles. A client convenience, not a governed object.
 */
import { useSyncExternalStore } from "react";

const KEY = "chaste-recent-apps";
const MAX = 8;

let hrefs: string[] | null = null;
const listeners = new Set<() => void>();

function load(): string[] {
  if (hrefs) return hrefs;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
    hrefs = Array.isArray(raw) ? raw.slice(0, MAX) : [];
  } catch {
    hrefs = [];
  }
  return hrefs;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(hrefs));
  } catch {
    // Private mode etc; recents live for the session.
  }
}

export function recordAppVisit(href: string) {
  const cur = load();
  if (cur[0] === href) return;
  hrefs = [href, ...cur.filter((h) => h !== href)].slice(0, MAX);
  persist();
  for (const l of listeners) l();
}

export const recentApps = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): string[] => load(),
};

const empty: string[] = [];

export function useRecentApps(): string[] {
  return useSyncExternalStore(recentApps.subscribe, recentApps.get, () => empty);
}
