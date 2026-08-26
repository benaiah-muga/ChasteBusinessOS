"use client";

import { useEffect, useState } from "react";

/**
 * Workspace display preferences: currency, units, date format, week start.
 * Stored locally per device under "chaste-prefs"; server data stays in minor
 * units and ISO — these only change how figures are *presented*. Pages adopt
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
export type Units = "metric" | "imperial";
export type DateFormat = "iso" | "dmy";
export type WeekStart = "sun" | "mon";

export interface Prefs {
  currency: CurrencyCode;
  units: Units;
  dateFormat: DateFormat;
  weekStart: WeekStart;
}

export const DEFAULT_PREFS: Prefs = {
  currency: "USD",
  units: "metric",
  dateFormat: "dmy",
  weekStart: "mon",
};

const KEY = "chaste-prefs";

export function currencyOf(code: string) {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

/** Formats integer minor units in the given display currency's symbol style. */
export function formatMoneyIn(code: string, minor: number): string {
  const { symbol } = currencyOf(code);
  const body = (Math.abs(minor) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${minor < 0 ? "−" : ""}${symbol}${body}`;
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const validCurrency = CURRENCIES.some((c) => c.code === parsed.currency);
    return {
      currency: validCurrency ? (parsed.currency as CurrencyCode) : DEFAULT_PREFS.currency,
      units: parsed.units === "imperial" ? "imperial" : "metric",
      dateFormat: parsed.dateFormat === "iso" ? "iso" : "dmy",
      weekStart: parsed.weekStart === "sun" ? "sun" : "mon",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const listeners = new Set<(p: Prefs) => void>();

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
export function usePrefs(): [Prefs, (next: Partial<Prefs>) => void] {
  const [prefs, update] = useState<Prefs>(DEFAULT_PREFS);
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
