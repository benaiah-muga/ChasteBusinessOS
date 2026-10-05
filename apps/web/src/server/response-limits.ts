const SESSION_MAX_EVENT_BYTES = 256 * 1024;
const SESSION_MAX_EVENT_COUNT = 10_000;
const SESSION_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DURABLE_RUN_MAX_STEPS = 200;
const DURABLE_RUN_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function legacyResponseByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return Number.POSITIVE_INFINITY;
  // Go's encoding/json escapes these characters and appends one newline.
  const goCompatibleJSON = json.replace(/[<>&\u2028\u2029]/g, (char) => {
    const escapes: Record<string, string> = {
      "<": "\\u003c",
      ">": "\\u003e",
      "&": "\\u0026",
      "\u2028": "\\u2028",
      "\u2029": "\\u2029",
    };
    return escapes[char] ?? char;
  });
  return new TextEncoder().encode(goCompatibleJSON).byteLength + 1;
}

export function sessionResponseExceedsBounds(value: unknown): boolean {
  return legacyResponseByteLength(value) > SESSION_MAX_RESPONSE_BYTES;
}

export function sessionEventsExceedBounds(events: readonly { content: unknown; contentBytes?: number | string }[]): boolean {
  if (events.length > SESSION_MAX_EVENT_COUNT) return true;
  let totalBytes = 0;
  for (const event of events) {
    const contentBytes = Number(event.contentBytes ?? legacyResponseByteLength(event.content) - 1);
    if (contentBytes > SESSION_MAX_EVENT_BYTES) return true;
    totalBytes += contentBytes;
    if (totalBytes > SESSION_MAX_RESPONSE_BYTES) return true;
  }
  return false;
}

export function sessionEventMetricsExceedBounds(eventCount: number, maxEventBytes: number, totalEventBytes: number): boolean {
  return eventCount > SESSION_MAX_EVENT_COUNT || maxEventBytes > SESSION_MAX_EVENT_BYTES || totalEventBytes > SESSION_MAX_RESPONSE_BYTES;
}

export function durableRunResponseExceedsBounds(value: unknown, stepCount: number): boolean {
  return stepCount > DURABLE_RUN_MAX_STEPS || legacyResponseByteLength(value) > DURABLE_RUN_MAX_RESPONSE_BYTES;
}
