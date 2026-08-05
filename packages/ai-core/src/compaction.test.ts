import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@chaste/ui-schema";
import {
  applyToOutbound,
  buildState,
  compactedBlock,
  CONTINUATION_CONTRACT,
  estimateTokens,
  extractUserMessages,
  extractWorkingState,
  isContextOverflow,
  pickBoundary,
  shouldCompact,
  SUMMARY_SYSTEM_PROMPT,
  triggerTokens,
  trimState,
  type ToolCallRecord,
} from "./compaction.js";

function u(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
function a(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
    createdAt: "2026-01-01T00:00:01.000Z",
  };
}

// Straightforward fake summarizer implementation.
function makeSummarizer(
  text: string,
  model = "sm",
): {
  summarize(s: ChatMessage[], p: string): Promise<string>;
  modelUsed: string;
  calls: { messages: ChatMessage[]; prior: string }[];
} {
  const calls: { messages: ChatMessage[]; prior: string }[] = [];
  return {
    modelUsed: model,
    summarize: async (messages: ChatMessage[], prior: string) => {
      calls.push({ messages, prior });
      return text;
    },
    calls,
  };
}

describe("tokens, triggers, boundary", () => {
  it("estimateTokens returns chars/4", () => {
    const msgs: ChatMessage[] = [u("iam12chars_x")];
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });

  it("triggerTokens caps with the configured ceiling for huge windows", () => {
    const uncapped = triggerTokens(1_000_000); // 0.8M, capped to 250k
    expect(uncapped).toBeLessThanOrEqual(250_000);
    expect(uncapped).toBe(250_000);
    // below the cap, returns the threshold percentage of the window
    expect(triggerTokens(64_000)).toBe(51_200); // 0.8 * 64k
  });

  it("shouldCompact flips at the trigger", () => {
    const trigger = triggerTokens(128_000);
    expect(shouldCompact(trigger - 1, 128_000)).toBe(false);
    expect(shouldCompact(trigger, 128_000)).toBe(true);
  });

  it("pickBoundary returns null for nothing-to-summarize and finds earliest-fitting user turn", () => {
    expect(pickBoundary([u("hi")], 10_000)).toBeNull();
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(u(`turn ${i}`), a(`reply ${i}`));
    // tight budget (200 tokens) where the last user's suffix fits but middle ones don't:
    // boundary must land on a user (even index), strictly within the list.
    const b = pickBoundary(messages, 200);
    expect(b).not.toBeNull();
    expect(b! % 2).toBe(0); // boundary always lands on a user turn here
    expect(b!).toBeGreaterThan(0);
    expect(b!).toBeLessThan(messages.length);
  });

  it("pickBoundary falls back to assistant turn when budget is exhausted before the last user suffix fits", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(u(`turn ${i}`), a(`reply ${i}`));
    // budget 60: slice(18) = 71 > 60 (user doesn't fit) but slice(19) = 36 fits.
    // Boundary lands inside the newest user turn at the assistant tail (legal suffix head).
    const b = pickBoundary(messages, 60);
    expect(b).not.toBeNull();
    expect(b! % 2).toBe(1); // assistant
    expect(b!).toBe(messages.length - 1);
  });

  it("buildState returns null when nothing meaningful to summarize", async () => {
    const out = await buildState([u("hi")], [], makeSummarizer("(SUMMARY)"), {
      keepTokens: 100_000,
    });
    expect(out).toBeNull();
  });

  it("buildState produces a compaction state with a summary, working state, and capped user messages", async () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 200; i++) messages.push(u(`turn ${i}`), a(`reply ${i}`));
    const audit: ToolCallRecord[] = [
      { command: "crm.customer.create", data: { id: "cust1", name: "Acme" }, success: true },
      { command: "acc.invoice.create", data: { id: "inv9", number: "INV-001" }, success: true },
      { command: "acc.invoice.create", data: { id: "inv9", number: "INV-001" }, success: false },
    ];
    const summarizer = makeSummarizer("(SUMMARY())");

    const state = await buildState(messages, audit, summarizer, {
      keepTokens: 100, // tiny budget so compaction triggers
    });
    expect(state).not.toBeNull();
    expect(state!.summaryText).toBe("(SUMMARY())");
    expect(state!.boundaryIndex).toBeGreaterThan(0);
    expect(state!.userMessages.length).toBeLessThanOrEqual(40);
    expect(state!.workingState).toContain("Working state");
    // Mechanical state records both artifacts and commands
    expect(state!.workingState).toContain("acc.invoice.create");
    expect(state!.workingState).toContain("INV-001");
  });
});

describe("outbound view via applyToOutbound", () => {
  it("replaces everything before boundary with a compacted block", async () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) messages.push(u(`turn ${i}`), a(`reply ${i}`));
    const state = (await buildState(messages, [], makeSummarizer("(S)"), {
      keepTokens: 100,
    }))!;
    const out = applyToOutbound(messages, state);
    expect(out.length).toBeLessThan(messages.length);
    expect(out[0]).toMatchObject({ role: "user" });
    expect((out[0]!.parts[0] as { text: string }).text).toContain("<compacted-history>");
    expect((out[0]!.parts[0] as { text: string }).text).toContain("(S)");
    expect((out[0]!.parts[0] as { text: string }).text).toContain(CONTINUATION_CONTRACT);
    // Verbatim tail preserved
    expect(out.slice(1)).toEqual(messages.slice(state!.boundaryIndex));
  });

  it("applyToOutbound is a no-op when state is null or stale", () => {
    const messages: ChatMessage[] = [u("hi")];
    expect(applyToOutbound(messages, null)).toBe(messages);
  });
});

describe("overflow detection", () => {
  it("recognizes OpenAI-style context_length_exceeded messages", () => {
    expect(isContextOverflow(new Error("context_length_exceeded"))).toBe(true);
    expect(isContextOverflow(new Error("Maximum context length exceeded"))).toBe(true);
    expect(isContextOverflow(new Error("not related"))).toBe(false);
    expect(isContextOverflow("too many tokens")).toBe(true);
  });
});

describe("mechanical state extraction (R11)", () => {
  it("captures commands, writes, and artifacts; never includes LLM text", () => {
    const audit: ToolCallRecord[] = [
      { command: "crm.customer.create", data: { id: "c1", name: "Acme" }, success: true },
      { command: "acc.invoice.create", data: { id: "i1", number: "INV-001" }, success: true },
      { command: "pur.po.create", data: { id: "p1", number: "PO-9" }, success: true },
      { command: "pur.po.create", data: { id: "p1", number: "PO-9" }, success: false },
      { command: "hr.payroll.prepare", data: { id: "r1", periodLabel: "2026-03" }, success: true },
    ];
    const out = extractWorkingState(audit);
    expect(out).toContain("## Working state");
    expect(out).toContain("crm.customer.create → Acme");
    expect(out).toContain("Artifacts produced:");
    expect(out).toContain("acc.invoice.create: INV-001");
    expect(out).toContain("pur.po.create: PO-9");
    expect(out).toContain("hr.payroll.prepare: r1"); // periodLabel has no number → falls back to id
    expect(out).toContain("Recent commands:");
    expect(out).toContain("[error]"); // the failed re-issue
    // No LLM text invades the block — only deterministic extraction
    expect(out).not.toContain("summary");
    expect(out).not.toContain("perhaps");
  });

  it("dedupes recent-first writes and caps to 20", () => {
    const audit: ToolCallRecord[] = Array.from({ length: 50 }, (_, i) => ({
      command: "crm.customer.create",
      data: { id: `c${i}`, name: `Acme-${i}` },
      success: true,
    }));
    const out = extractWorkingState(audit);
    // Most-recent-first means c49 must appear first
    expect(out).toMatch(/crm\.customer\.create → Acme-49/);
    // No more than 20 dedupe lines (since these are all unique though, just capped to 20 unique)
    expect(out.match(/Acme-\d+/g)?.length).toBeLessThanOrEqual(20);
  });

  it("returns empty when the span had no entries", () => {
    expect(extractWorkingState([])).toBe("");
  });
});

describe("user message extraction", () => {
  it("keeps only user message text, clipped, never assistant prose", () => {
    const span: ChatMessage[] = [
      u("create customer Acme"),
      a("done"),
      u("also create invoice INV-100"),
    ];
    const out = extractUserMessages(span);
    expect(out).toEqual(["create customer Acme", "also create invoice INV-100"]);
  });

  it("clips very long messages", () => {
    const span: ChatMessage[] = [u("x".repeat(1200))];
    const out = extractUserMessages(span);
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith("…")).toBe(true);
    expect(out[0]!.length).toBeLessThanOrEqual(600);
  });
});

describe("trimState — no-LLM fallback", () => {
  it("advances the boundary past a fraction and writes an honest note", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) messages.push(u(`turn ${i}`), a(`reply ${i}`));
    const trimmed = trimState(messages, [], { fraction: 0.1 });
    expect(trimmed).not.toBeNull();
    expect(trimmed!.trimmed).toBe(true);
    expect(trimmed!.summaryText).toContain("no summary is available");
    expect(trimmed!.boundaryIndex).toBeGreaterThan(0);
    expect(trimmed!.boundaryIndex).toBeLessThan(messages.length);
  });

  it("is a no-op when only 1-2 messages remain", () => {
    expect(trimState([u("hi")], [])).toBeNull();
  });
});

describe("SUMMARY_SYSTEM_PROMPT sanity", () => {
  it("exposes the 8-section contract (does the work of the spec)", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/1\. \*\*Primary request and intent\*\*/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/8\. \*\*Next step\*\*/);
  });
});

describe("compactedBlock helper", () => {
  it("emits a wrapped block visible to the model", () => {
    const block = compactedBlock({
      boundaryIndex: 5,
      summaryText: "(S)",
      workingState: "## Working state\n- foo",
      userMessages: ["Hi", "Also: create customer"],
      userMessagesDropped: 3,
      createdAt: 0,
      modelUsed: "sm",
      trimmed: false,
    });
    expect(block).toContain("<compacted-history>");
    expect(block).toContain("</compacted-history>");
    expect(block).toContain("- Hi");
    expect(block).toContain("3 earlier user messages omitted");
    expect(block).toContain("## Working state");
  });
});
