import { describe, expect, it } from "vitest";
import {
  COMPACTION_STUB,
  compactTrajectory,
  estimateTokens,
  shouldCompact,
} from "./compaction";
import type { LoopMessage } from "./loop";

const sys = (content: string): LoopMessage => ({ role: "system", content });
const user = (content: string): LoopMessage => ({ role: "user", content });
const tool = (id: string): LoopMessage => ({ role: "tool", content: `result for ${id}`.repeat(50), toolCallId: id });

describe("estimateTokens", () => {
  it("approximates chars/4 and never returns zero for nonempty input", () => {
    expect(estimateTokens([user("abcdefgh")])).toBe(2);
    expect(estimateTokens([])).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("false under budget, true over it", () => {
    const small = [sys("tiny"), user("hi")];
    expect(shouldCompact(small, 24_000)).toBe(false);
    expect(shouldCompact(small, 1)).toBe(true);
  });
});

describe("compactTrajectory", () => {
  const messages = [
    sys("You are the assistant. ".repeat(100)),
    user("first goal"),
    tool("call_1"),
    tool("call_2"),
    tool("call_3"),
    user("second goal"),
    tool("call_4"),
    user("latest question"),
  ];

  it("keeps the system message verbatim, it is the cache anchor", () => {
    const { messages: out } = compactTrajectory(messages, { keepRecent: 3 });
    expect(out[0]).toEqual(messages[0]);
  });

  it("keeps the recent window verbatim", () => {
    const { messages: out } = compactTrajectory(messages, { keepRecent: 3 });
    expect(out.slice(-3)).toEqual(messages.slice(-3));
  });

  it("folds old non-system messages into stubs", () => {
    const { messages: out, compactedCount } = compactTrajectory(messages, { keepRecent: 3 });
    expect(compactedCount).toBeGreaterThan(0);
    for (let i = 1; i < out.length - 3; i++) {
      expect(out[i]!.content).toContain(COMPACTION_STUB);
    }
  });

  it("is a no-op when already within the window", () => {
    const r = compactTrajectory(messages.slice(0, 3), { keepRecent: 6 });
    expect(r.compactedCount).toBe(0);
    expect(r.messages).toEqual(messages.slice(0, 3));
  });

  it("never drops messages, total count is preserved", () => {
    const { messages: out } = compactTrajectory(messages, { keepRecent: 2 });
    expect(out).toHaveLength(messages.length);
  });

  it("compacting twice is stable (idempotent on stubs)", () => {
    const first = compactTrajectory(messages, { keepRecent: 4 }).messages;
    const second = compactTrajectory(first, { keepRecent: 2 }).messages;
    expect(second.length).toBe(first.length);
  });
});
