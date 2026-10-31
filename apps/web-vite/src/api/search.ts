export type RecordSearchItem = {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
};

export type RecordSearchGroup = {
  type: string;
  label: string;
  items: RecordSearchItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseItem(value: unknown): RecordSearchItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.href !== "string") return null;
  return {
    id: value.id,
    title: value.title,
    href: value.href,
    ...(typeof value.subtitle === "string" && value.subtitle ? { subtitle: value.subtitle } : {}),
  };
}

export async function searchRecords(query: string, signal?: AbortSignal): Promise<RecordSearchGroup[]> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Record search is unavailable.");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.groups)) throw new Error("Record search returned an invalid response.");
  const groups: RecordSearchGroup[] = [];
  for (const value of payload.groups) {
    if (!isRecord(value) || typeof value.type !== "string" || typeof value.label !== "string" || !Array.isArray(value.items)) continue;
    const items = value.items.map(parseItem).filter((item): item is RecordSearchItem => item !== null);
    if (items.length > 0) groups.push({ type: value.type, label: value.label, items });
  }
  return groups;
}
