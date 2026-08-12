/**
 * F12 — redact sensitive fields before they land in the audit trail.
 *
 * The command bus writes `inputSummary` into `audit_log`; command inputs can
 * carry free-text/PII (email bodies, CRM notes, comments, salaries, goals).
 * This walker replaces values under denylisted keys with a `"[redacted]"
 * marker so the audit log stays useful (which command, what ids) without
 * leaking message content or financial/credential data.
 */

const REDACTED = "[redacted]";

/** Keys whose string values are never stored in the audit trail. */
const SENSITIVE_KEYS = new Set([
  "body",
  "note",
  "notes",
  "summary",
  "message",
  "goal",
  "password",
  "token",
  "secret",
  "apiKey",
  "authToken",
  "salary",
  "baseSalary",
  "comment",
  "comments",
  "text",
  "details",
]);

const MAX_DEPTH = 6;
const MAX_ITEMS = 100;

/** Walk a value and replace sensitive strings; JSON `string` values pass through. */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redactForAudit(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key) && (typeof v === "string" || typeof v === "number")) {
        out[key] = REDACTED;
      } else {
        out[key] = redactForAudit(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}
