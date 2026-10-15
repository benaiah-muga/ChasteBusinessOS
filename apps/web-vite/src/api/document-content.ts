const MAX_CONTENT_DEPTH = 64;
const MAX_CONTENT_NODES = 10_000;
const MAX_CONTENT_VALUES = 100_000;
const MAX_CONTENT_JSON_BYTES = 1_000_000;

type WalkEntry = { value: unknown; depth: number };
type DocumentNode = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isDocumentNode(value: unknown): value is DocumentNode {
  return isRecord(value) && typeof value.type === "string" && value.type.length > 0 && value.type.length <= 100;
}

function normalizeLoneSurrogateEscapes(serialized: string): string {
  let normalized = "";
  let inString = false;
  for (let index = 0; index < serialized.length;) {
    const character = serialized[index];
    if (!inString && character === '"') inString = true;
    else if (inString && character === '"') inString = false;
    if (inString && character === "\\") {
      if (serialized[index + 1] === "u") {
        const codeUnit = Number.parseInt(serialized.slice(index + 2, index + 6), 16);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
          normalized += "\ufffd";
          index += 6;
          continue;
        }
        normalized += serialized.slice(index, index + 6);
        index += 6;
        continue;
      }
      normalized += serialized.slice(index, index + 2);
      index += 2;
      continue;
    }
    normalized += character;
    index += 1;
  }
  return normalized;
}

/** Validate ProseMirror structure and bound all nested JSON before rendering or writing it. */
export function isBoundedDocumentContent(value: unknown): value is Record<string, unknown> {
  if (!isDocumentNode(value) || value.type !== "doc") return false;

  let serialized: string | undefined;
  try {
    const rawJSON = JSON.stringify(value);
    if (typeof rawJSON !== "string") return false;
    serialized = JSON.stringify(JSON.parse(normalizeLoneSurrogateEscapes(rawJSON)) as unknown);
  } catch {
    return false;
  }
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > MAX_CONTENT_JSON_BYTES) return false;

  const seen = new WeakSet<object>();
  const pending: WalkEntry[] = [{ value, depth: 1 }];
  let valueCount = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || entry.depth > MAX_CONTENT_DEPTH || ++valueCount > MAX_CONTENT_VALUES) return false;
    const current = entry.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      for (const item of current) {
        const nested = Array.isArray(item) || isRecord(item);
        pending.push({ value: item, depth: entry.depth + Number(nested) });
      }
      continue;
    }
    if (!isRecord(current) || seen.has(current)) return false;
    seen.add(current);
    for (const nested of Object.values(current)) {
      const depth = Array.isArray(nested) || isRecord(nested) ? entry.depth + 1 : entry.depth;
      pending.push({ value: nested, depth });
    }
  }

  const nodes: unknown[] = [value];
  let nodeCount = 0;
  while (nodes.length > 0) {
    const raw = nodes.pop();
    if (!isDocumentNode(raw) || ++nodeCount > MAX_CONTENT_NODES) return false;
    if (raw.text !== undefined && typeof raw.text !== "string") return false;
    if (raw.attrs !== undefined && !isRecord(raw.attrs)) return false;
    if (raw.marks !== undefined) {
      if (!Array.isArray(raw.marks)) return false;
      for (const mark of raw.marks) {
        if (!isRecord(mark) || typeof mark.type !== "string" || mark.type.length === 0 || mark.type.length > 100) return false;
        if (mark.attrs !== undefined && !isRecord(mark.attrs)) return false;
      }
    }
    if (raw.content !== undefined) {
      if (!Array.isArray(raw.content)) return false;
      for (const child of raw.content) nodes.push(child);
    }
  }

  return true;
}
