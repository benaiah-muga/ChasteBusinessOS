"use client";

import { useSyncExternalStore } from "react";

/**
 * Chat dock modes, shared app-wide so any surface can drive the dock:
 * - "input": horizontal floating input bar at the lower center (default,
 *   visible on every page)
 * - "bubble": shrunk to a bubble at the lower right
 * - "open": expanded chat panel overlaying the lower right
 * - "pinned": chat panel pinned to the right edge as part of the layout;
 *   AppShell reserves its width so nothing behind it is obstructed
 */

export type ChatDockMode = "input" | "bubble" | "open" | "pinned";

const STORAGE_KEY = "chaste.chatDockMode";
const VALID: ChatDockMode[] = ["input", "bubble", "open", "pinned"];

let mode: ChatDockMode = "input";
const listeners = new Set<() => void>();

function set(next: ChatDockMode) {
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode etc; persistence is best-effort */
  }
  for (const l of listeners) l();
}

export const chatDock = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): ChatDockMode => mode,
  set,
  /**
   * Rehydrates the last chosen mode once we're on the client. Called from an
   * effect so SSR renders the default and hydration never mismatches.
   */
  restore() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ChatDockMode | null;
      if (stored && VALID.includes(stored) && stored !== mode) {
        mode = stored;
        for (const l of listeners) l();
      }
    } catch {
      /* ignore */
    }
  },
};

export function useChatDockMode(): ChatDockMode {
  return useSyncExternalStore(chatDock.subscribe, chatDock.get, chatDock.get);
}

/** Draft text shared between dashboard quick actions and the dock input. */
let draft = "";
const draftListeners = new Set<() => void>();

export const chatDraft = {
  subscribe(listener: () => void) {
    draftListeners.add(listener);
    return () => draftListeners.delete(listener);
  },
  get: () => draft,
  set(v: string) {
    draft = v;
    for (const l of draftListeners) l();
  },
};

export function useChatDraft(): string {
  return useSyncExternalStore(chatDraft.subscribe, chatDraft.get, chatDraft.get);
}
