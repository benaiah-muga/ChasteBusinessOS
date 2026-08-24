export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Money is integer minor units everywhere; render once, consistently. */
export function formatMoney(minor: number): string {
  const abs = Math.abs(minor) / 100;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return minor < 0 ? `−$${body}` : `$${body}`;
}

/** Whole-dollar display for forecasts/pipeline where cents are noise. */
export function formatMoneyWhole(minor: number): string {
  const body = (Math.abs(minor) / 100).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  return minor < 0 ? `−$${body}` : `$${body}`;
}

/** Parses a user-entered dollar amount into integer minor units. */
export function toMinor(dollars: string): number {
  return Math.round(Number(dollars || "0") * 100);
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
