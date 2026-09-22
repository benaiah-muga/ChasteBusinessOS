"use client";

import { useSyncExternalStore } from "react";
import { activeCurrencyCode, setActiveCurrency } from "@/lib/format";
import { getPrefs, subscribePrefs } from "@/lib/prefs";

/**
 * Client store binding the presentation currency to React rendering.
 *
 * Resolution order: an explicit per-device choice from Settings wins;
 * otherwise money renders in the organization's base currency; USD stands in
 * until the shell tells us what the org uses. Components call useMoneySync()
 * once at their root: a currency change then re-renders the whole page tree,
 * and the plain formatMoney()/toMinor() helpers pick the new style up with no
 * call-site changes.
 */

let orgCurrency: string | null = null;
const subscribers = new Set<() => void>();

function resolvedCode(): string {
  const pref = getPrefs().currency;
  if (pref !== "org") return pref;
  return orgCurrency ?? "USD";
}

function emit(): void {
  for (const fn of subscribers) fn();
}

function getSnapshot(): string {
  const code = resolvedCode();
  // Keep the formatters exactly in step with the snapshot; idempotent.
  setActiveCurrency(code);
  return code;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  const offPrefs = subscribePrefs(() => emit());
  return () => {
    subscribers.delete(cb);
    offPrefs();
  };
}

/** The shell calls this once per render with the active org's base currency. */
export function applyOrgDefault(code: string | null | undefined): void {
  const next = code ?? null;
  if (orgCurrency === next) return;
  orgCurrency = next;
  emit();
}

/** Subscribes the calling component to presentation-currency changes. */
export function useMoneySync(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => activeCurrencyCode());
}
