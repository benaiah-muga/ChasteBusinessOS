/**
 * Pinned apps: the user's favorite surfaces, pinned to the workspace rail.
 * Client preference (max 5), not a governed object — it decorates navigation
 * only and never gates authority.
 */
import { useSyncExternalStore } from "react";

const KEY = "chaste-pinned-apps";
export const MAX_PINS = 5;

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
    return Array.isArray(raw) ? raw.slice(0, MAX_PINS) : [];
  } catch {
    return [];
  }
}

let pins: string[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Private mode etc; pins live for the session.
  }
  emit();
}

export const appPins = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): string[] => {
    if (!hydrated && typeof window !== "undefined") {
      pins = load();
      hydrated = true;
    }
    return pins;
  },
  isPinned: (id: string): boolean => appPins.get().includes(id),
  toggle(id: string) {
    const cur = appPins.get();
    if (cur.includes(id)) {
      pins = cur.filter((p) => p !== id);
    } else {
      if (cur.length >= MAX_PINS) return;
      pins = [...cur, id];
    }
    persist();
  },
};

const empty: string[] = [];

export function usePinnedApps(): string[] {
  return useSyncExternalStore(appPins.subscribe, appPins.get, () => empty);
}
