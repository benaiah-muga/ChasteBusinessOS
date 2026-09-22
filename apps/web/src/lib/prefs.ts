"use client";

import { useEffect, useState } from "react";
import { currencyStyleFor } from "@/lib/format";

/**
 * Workspace display preferences: currency, units, date format, week start.
 * Stored locally per device under "chaste-prefs"; server data stays in minor
 * units and ISO - these only change how figures are *presented*. Pages adopt
 * them progressively via the format helpers below.
 */

export const CURRENCIES = [
  { code: "USD", symbol: "$", label: "US dollar" },
  { code: "KES", symbol: "KSh", label: "Kenyan shilling" },
  { code: "EUR", symbol: "€", label: "Euro" },
  { code: "GBP", symbol: "£", label: "Pound sterling" },
  { code: "TZS", symbol: "TSh", label: "Tanzanian shilling" },
  { code: "UGX", symbol: "USh", label: "Ugandan shilling" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
/** "org" follows the organization's base currency; anything else pins this device. */
export type DisplayCurrency = CurrencyCode | "org";
export type Units = "metric" | "imperial";
export type DateFormat = "iso" | "dmy";
export type WeekStart = "sun" | "mon";

export interface Prefs {
  currency: DisplayCurrency;
  units: Units;
  dateFormat: DateFormat;
  weekStart: WeekStart;
  /** Harper spell/grammar underlines on writing surfaces. */
  writingAids: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  currency: "org",
  units: "metric",
  dateFormat: "dmy",
  weekStart: "mon",
  writingAids: true,
};

const KEY = "chaste-prefs";

export function currencyOf(code: string) {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

/** Formats integer minor units in the given display currency's symbol style. */
export function formatMoneyIn(code: string, minor: number): string {
  const style = currencyStyleFor(code) ?? { code: "USD", symbol: "$", minorUnits: 2 };
  const body = (Math.abs(minor) / 10 ** style.minorUnits).toLocaleString("en-US", {
    minimumFractionDigits: style.minorUnits,
    maximumFractionDigits: style.minorUnits,
  });
  return `${minor < 0 ? "−" : ""}${style.symbol}${body}`;
}

function readPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const validCurrency =
      parsed.currency === "org" || CURRENCIES.some((c) => c.code === parsed.currency);
    return {
      currency: validCurrency ? (parsed.currency as DisplayCurrency) : DEFAULT_PREFS.currency,
      units: parsed.units === "imperial" ? "imperial" : "metric",
      dateFormat: parsed.dateFormat === "iso" ? "iso" : "dmy",
      weekStart: parsed.weekStart === "sun" ? "sun" : "mon",
      writingAids: parsed.writingAids !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const listeners = new Set<(p: Prefs) => void>();

/** Current preferences; safe on the server (returns defaults). */
export function getPrefs(): Prefs {
  return readPrefs();
}

/** Subscribes to preference changes; returns the unsubscribe function. */
export function subscribePrefs(cb: (p: Prefs) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setPrefs(next: Partial<Prefs>) {
  const merged = { ...readPrefs(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Session-only memory when storage is unavailable.
  }
  for (const fn of listeners) fn(merged);
}

/** Subscribes to display preferences; safe to call from many components. */
export function usePrefs(initial?: Partial<Prefs>): [Prefs, (next: Partial<Prefs>) => void] {
  const [prefs, update] = useState<Prefs>({ ...DEFAULT_PREFS, ...initial });
  useEffect(() => {
    const sync = (p: Prefs) => update(p);
    listeners.add(sync);
    update(readPrefs());
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return [prefs, setPrefs];
}
