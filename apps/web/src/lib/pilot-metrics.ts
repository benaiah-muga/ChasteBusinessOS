/**
 * W0.5 pilot instrumentation. The measurement plan (docs/w05-pilot-selection.md)
 * needs time-to-first-useful-action and journey completion per pilot device.
 * Events live in localStorage: no server write path, so telemetry cannot
 * become an ungoverned write, and the pilot operator exports the numbers
 * from each device.
 */

const KEY = "chaste_pilot_events_v1";

export interface PilotEvent {
  at: string;
  event: "home_open" | "receiving_open" | "first_action" | "journey_complete";
  label?: string;
  /** Milliseconds from the journey's page-open to this event, when known. */
  ms?: number;
}

function readAll(): PilotEvent[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as PilotEvent[];
  } catch {
    return [];
  }
}

function writeAll(events: PilotEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(events.slice(-500)));
  } catch {
    // Storage full or blocked: instrumentation must never break the page.
  }
}

/** Remembers when a journey's page opened so later events can carry an elapsed ms. */
export function pilotBegin(journey: "home" | "receiving"): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(`chaste_pilot_open_${journey}`, String(Date.now()));
  record(journey === "home" ? "home_open" : "receiving_open", journey);
}

/** Records one event; the first "first_action"/"journey_complete" carries elapsed ms. */
export function record(
  event: PilotEvent["event"],
  label?: string,
  journey?: "home" | "receiving",
): void {
  const openKey = journey ? `chaste_pilot_open_${journey}` : null;
  const openedAt = openKey ? Number(window.sessionStorage.getItem(openKey) ?? "") : NaN;
  const ms = Number.isFinite(openedAt) ? Date.now() - openedAt : undefined;
  const events = readAll();
  const already = events.some((e) => e.event === event);
  events.push({ at: new Date().toISOString(), event, label, ms: already ? undefined : ms });
  writeAll(events);
}

export function pilotEvents(): PilotEvent[] {
  return readAll();
}

export function pilotEventsCsv(): string {
  const rows = readAll();
  const head = "at,event,label,ms";
  const body = rows.map((e) => `${e.at},${e.event},${e.label ?? ""},${e.ms ?? ""}`).join("\n");
  return `${head}\n${body}`;
}

export function pilotEventsClear(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
