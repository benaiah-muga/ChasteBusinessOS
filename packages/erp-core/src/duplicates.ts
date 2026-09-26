/**
 * Deterministic customer duplicate detection (M9).
 *
 * Pure string logic - the CRM surfaces a warning when a new customer looks
 * like an existing one; it never silently merges. Two customers are
 * duplicates when email, normalized phone, or a close normalized name match.
 *
 * Deterministic and byte-order stable by construction: no locale-aware
 * comparisons (M8 lesson - localeCompare is environment-dependent).
 */
export interface CustomerFingerprint {
  name: string;
  email?: string | null;
  phone?: string | null;
}

/** Legal-suffix noise stripped before comparing names. */
const NAME_SUFFIXES = ["llc", "ltd", "limited", "inc", "incorporated", "co", "corp", "corporation", "gmbh", "bv", "plc"];

/**
 * Normalize a customer name to a canonical key: lowercase, strip
 * punctuation to spaces, collapse whitespace, drop legal suffixes at the
 * end. Idempotent and deterministic.
 */
export function normalizeCustomerName(name: string): string {
  let key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of NAME_SUFFIXES) {
      if (key === suffix) return ""; // a name made only of a suffix has no identity
      if (key.endsWith(` ${suffix}`)) {
        key = key.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return key;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

function similarName(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 8) return false;
  const longest = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > Math.floor(longest * 0.12)) return false;
  return 1 - editDistance(a, b) / longest >= 0.92;
}

export interface DuplicateVerdict {
  /** true when the candidate matches an existing customer closely enough to warn. */
  duplicate: boolean;
  /** Which fingerprint matched. */
  reason: "name" | "email" | "phone" | "similar name" | null;
  /** The existing customer's name as stored (for the warning message). */
  existingName: string | null;
}

/**
 * Compare one candidate against existing fingerprints. First match wins in
 * array order; callers wanting the strongest match can sort beforehand.
 * Symmetric: findDuplicate([a], b) and findDuplicate([b], a).duplicate agree.
 */
export function findDuplicate(
  existing: CustomerFingerprint[],
  candidate: CustomerFingerprint,
): DuplicateVerdict {
  const candidateEmail = normalizeEmail(candidate.email);
  const candidatePhone = normalizePhone(candidate.phone);
  const candidateName = normalizeCustomerName(candidate.name);
  for (const row of existing) {
    if (candidateEmail && normalizeEmail(row.email) === candidateEmail) {
      return { duplicate: true, reason: "email", existingName: row.name };
    }
    if (candidatePhone && normalizePhone(row.phone) === candidatePhone) {
      return { duplicate: true, reason: "phone", existingName: row.name };
    }
    const rowName = normalizeCustomerName(row.name);
    if (candidateName.length > 0 && rowName === candidateName) {
      return { duplicate: true, reason: "name", existingName: row.name };
    }
    if (candidateName && rowName && similarName(candidateName, rowName)) {
      return { duplicate: true, reason: "similar name", existingName: row.name };
    }
  }
  return { duplicate: false, reason: null, existingName: null };
}
