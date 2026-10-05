import { describe, expect, it } from "vitest";
import {
  durableRunResponseExceedsBounds,
  legacyResponseByteLength,
  sessionEventsExceedBounds,
  sessionResponseExceedsBounds,
} from "./response-limits";

describe("migration response limits", () => {
  it("counts the same escaped JSON bytes as the Go JSON encoder", () => {
    expect(legacyResponseByteLength({ value: "<&>\u2028" })).toBe(
      new TextEncoder().encode('{"value":"\\u003c\\u0026\\u003e\\u2028"}').byteLength + 1,
    );
  });

  it("enforces session event count, individual content, and total response bounds", () => {
    expect(sessionEventsExceedBounds([{ content: "x".repeat(256 * 1024) }])).toBe(true);
    expect(sessionEventsExceedBounds(Array.from({ length: 10_001 }, () => ({ content: null })))).toBe(true);
    expect(sessionEventsExceedBounds([{ content: { text: "ok" } }])).toBe(false);
    expect(sessionResponseExceedsBounds({ content: "x".repeat(8 * 1024 * 1024) })).toBe(true);
  });

  it("enforces durable run step and encoded response bounds", () => {
    expect(durableRunResponseExceedsBounds({ steps: [] }, 200)).toBe(false);
    expect(durableRunResponseExceedsBounds({ steps: [] }, 201)).toBe(true);
    expect(durableRunResponseExceedsBounds({ content: "x".repeat(2 * 1024 * 1024) }, 0)).toBe(true);
  });
});
