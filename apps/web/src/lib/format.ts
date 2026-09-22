import { currencyMinorUnits } from "@chaste/erp-core";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Presentation currency for money figures. Stored amounts never change:
 * integer minor units in the org's recording currency, always. This only
 * decides symbol and decimal digits. The client store (lib/money.ts) points
 * it at the org's base currency, with the device preference as an override;
 * USD is the neutral fallback before hydration.
 */
interface CurrencyStyle {
  code: string;
  symbol: string;
  minorUnits: number;
}

const FALLBACK_STYLE: CurrencyStyle = { code: "USD", symbol: "$", minorUnits: 2 };

/** Friendly symbols for currencies the UI offers by name; others show their code. */
const SYMBOLS: Record<string, string> = {
  USD: "$",
  KES: "KSh ",
  EUR: "€",
  GBP: "£",
  TZS: "TSh ",
  UGX: "USh ",
};

let activeStyle: CurrencyStyle = FALLBACK_STYLE;

/** Style for a currency code, or null when the code is not recognized. */
export function currencyStyleFor(code: string): CurrencyStyle | null {
  const up = code.toUpperCase();
  const minorUnits = currencyMinorUnits(up);
  if (minorUnits === null) return null;
  return { code: up, symbol: SYMBOLS[up] ?? `${up} `, minorUnits };
}

/** Points the formatters at a currency; returns false when nothing changed. */
export function setActiveCurrency(code: string): boolean {
  const next = currencyStyleFor(code);
  if (!next) return false;
  if (activeStyle.code === next.code && activeStyle.minorUnits === next.minorUnits) return false;
  activeStyle = next;
  return true;
}

export function activeCurrencyCode(): string {
  return activeStyle.code;
}

function groupDigits(minor: number, minDecimals: number, maxDecimals: number): string {
  const major = Math.abs(minor) / 10 ** activeStyle.minorUnits;
  return major.toLocaleString("en-US", {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  });
}

function wrapSign(body: string, negative: boolean): string {
  return negative ? `−${activeStyle.symbol}${body}` : `${activeStyle.symbol}${body}`;
}

/** Money is integer minor units everywhere; render once, consistently. */
export function formatMoney(minor: number): string {
  return wrapSign(groupDigits(minor, activeStyle.minorUnits, activeStyle.minorUnits), minor < 0);
}

/** Whole-unit display for forecasts/pipeline where cents are noise. */
export function formatMoneyWhole(minor: number): string {
  return wrapSign(groupDigits(minor, 0, 0), minor < 0);
}

/** Parses a user-entered amount in presentation-currency major units. */
export function toMinor(amount: string): number {
  return Math.round(Number(amount || "0") * 10 ** activeStyle.minorUnits);
}

/** Minor units back to a plain major-unit string for input fields. */
export function minorToInput(minor: number): string {
  return String(minor / 10 ** activeStyle.minorUnits);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Minimal domain-status → semantic badge tone mapping. */
export function statusTone(status: string): "green" | "red" | "amber" | "neutral" {
  const s = status.toLowerCase();
  if (/(executed|parsed|approved|merged|posted|paid|balanced|won)/.test(s)) return "green";
  if (/(failed|rejected|voided|lost|unbalanced|blocked)/.test(s)) return "red";
  if (/(draft|pending|in_review|review|open)/.test(s)) return "amber";
  return "neutral";
}
