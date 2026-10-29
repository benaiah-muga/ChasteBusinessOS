// Shared presentation rules for a stored approval payload. The approvals page
// and the in-conversation approval card must show the same fields and hide the
// same secrets, otherwise one surface can leak what the other redacts.

export const SENSITIVE_KEY = /(password|secret|token|credential|base64|api[_-]?key|private[_-]?key|authorization|bearer)/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function actionTitle(capabilityId: string): string {
  const action = capabilityId.split(".").at(-1) ?? capabilityId;
  return action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

const ACRONYM_WORDS = new Set(["id", "sku", "url", "api", "vat", "pos", "rfq", "po"]);

export function humanizeFieldKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  const label = words.map((word) => (ACRONYM_WORDS.has(word) ? word.toUpperCase() : word)).join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function previewFields(payload: unknown): Array<[string, unknown]> {
  if (!isRecord(payload)) return [];
  return Object.entries(payload)
    .filter(([key]) => !SENSITIVE_KEY.test(key) && !["intentId", "sessionId"].includes(key))
    .slice(0, 8);
}

export function safePayload(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[hidden]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 497)}…` : value;
  if (depth >= 5) return "[nested details hidden]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safePayload(entry, "", depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, entry]) => [childKey, safePayload(entry, childKey, depth + 1)]));
  }
  return value;
}
