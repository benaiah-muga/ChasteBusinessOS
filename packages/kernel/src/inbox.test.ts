import { describe, expect, it } from "vitest";
import { argsPreview, type InboxItem, InboxStore } from "./inbox.js";

function fixedClock(): { now: () => Date; t: Date } {
  const t = new Date("2026-08-01T10:00:00Z");
  return {
    t,
    now: () => t,
  };
}

function baseline(overrides: Partial<Parameters<InboxStore["addApproval"]>[0]> = {}) {
  return {
    sessionId: "s1",
    organizationId: "o1",
    userId: "u1",
    title: "Run email.send?",
    ...overrides,
  } as const;
}

describe("InboxStore — adding items", () => {
  it("adds an approval item with default state, visibility, and inbox", () => {
    const clock = fixedClock();
    const store = new InboxStore({ now: clock.now });
    const item = store.addApproval(baseline());
    expect(item.state).toBe<InboxItem["state"]>("pending");
    expect(item.visibility).toBe<InboxItem["visibility"]>("inbox");
    expect(item.inbox).toBe("default");
    expect(item.createdAt).toBe(clock.t.toISOString());
    expect(item.toolCallId).toBeUndefined();
  });

  it("allows inline visibility for attended sessions (the R3 attending path)", () => {
    const store = new InboxStore();
    const item = store.addApproval(baseline({ visibility: "inline" }));
    expect(item.visibility).toBe<InboxItem["visibility"]>("inline");
  });

  it("adds a question with quick-reply options and the always-present Other escape", () => {
    const store = new InboxStore();
    const q = store.addQuestion({
      sessionId: "s1",
      organizationId: "o1",
      userId: "u1",
      title: "Which account?",
      options: ["Acme", "Contoso"],
    });
    expect(q.options).toEqual(["Acme", "Contoso"]);
    expect(q.allowText).toBe(true);
  });

  it("idempotently dedupes by (sessionId, toolCallId) — re-raise returns the same record", () => {
    const store = new InboxStore();
    const first = store.addApproval(baseline({ toolCallId: "tc1" }));
    const second = store.addApproval(baseline({ toolCallId: "tc1", title: "DIFFERENT" }));
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title); // not the duplicate
  });
});

describe("InboxStore — the state machine", () => {
  it("resolves an item exactly once; first responder wins", () => {
    const store = new InboxStore();
    const item = store.addApproval(baseline());
    expect(store.resolve(item.id, "allow")).toBe(true);
    expect(store.resolve(item.id, "deny")).toBe(false);
    const got = store.get(item.id)!;
    expect(got.state).toBe("resolved");
    expect(got.resolution).toBe("allow");
  });

  it("resolves a deletion of all session item to closed count", () => {
    const store = new InboxStore();
    store.addApproval(baseline({ sessionId: "sx" }));
    store.addApproval(baseline({ sessionId: "sx" }));
    store.addApproval(baseline({ sessionId: "sy" }));
    const closed = store.resolveSession("sx", "session deleted");
    expect(closed).toBe(2);
    expect(store.pending({ sessionId: "sx" })).toEqual([]);
    expect(store.pending({ sessionId: "sy" })).toHaveLength(1);
  });

  it("`wait` resolves with the recorded resolution; later waits see it immediately", async () => {
    const store = new InboxStore();
    const item = store.addApproval(baseline());
    const prom = store.wait(item.id);
    // microtask: should not resolve before we call resolve()
    let resolved: string | undefined;
    prom.then((r) => (resolved = r));
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    store.resolve(item.id, "allow");
    expect(await prom).toBe("allow");
    // second waiter sees the persisted resolution immediately
    const later = await store.wait(item.id);
    expect(later).toBe("allow");
  });

  it("lists items with filters and orders oldest-first", () => {
    const t0 = new Date("2026-08-01T10:00:00Z");
    const t1 = new Date("2026-08-01T11:00:00Z");
    const store = new InboxStore({ now: () => t0 });
    const a = store.addApproval(baseline({ sessionId: "sx" }));
    store["now"] = () => t1; // mutate clock for the second insert
    const b = store.addApproval(baseline({ sessionId: "sy", title: "later" }));

    expect(store.list({ sessionId: "sx" }).map((i) => i.id)).toEqual([a.id]);
    expect(store.list({ state: "pending" }).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(store.pending().map((i) => i.id)).toEqual([a.id, b.id]);
    store.resolve(b.id, "allow");
    expect(store.pending().map((i) => i.id)).toEqual([a.id]);
  });
});

describe("InboxStore — standing approval rules (R4)", () => {
  it("mints a task-scoped standing rule on `always` for an eligible approval", () => {
    const store = new InboxStore();
    const item = store.addApproval(
      baseline({
        toolCallId: "tc1",
        data: {
          taskId: "task-7",
          commandId: "email.send",
          standingTarget: "user@x.com",
        },
      }),
    );
    expect(store.resolve(item.id, "always")).toBe(true);

    const decision = store.standingRuleFor({
      taskId: "task-7",
      sessionId: "s1",
      commandId: "email.send",
      target: "user@x.com",
    });
    expect(decision).toEqual({
      allowed: true,
      rule: "email.send → user@x.com",
      taskId: "task-7",
    });
  });

  it("does NOT mint a rule when missing task/target/command metadata", () => {
    const store = new InboxStore();
    const item = store.addApproval(baseline({ toolCallId: "tc2" }));
    store.resolve(item.id, "always");
    expect(
      store.standingRuleFor({
        sessionId: "s1",
        commandId: "email.send",
        target: "user@x.com",
      }),
    ).toBeNull();
  });

  it("falls back to scoping by sessionId when no taskId is set", () => {
    const store = new InboxStore();
    const item = store.addApproval(
      baseline({
        toolCallId: "tc3",
        data: {
          commandId: "slack.send",
          standingTarget: "#ops-alerts",
        },
      }),
    );
    expect(store.resolve(item.id, "always")).toBe(true);
    const decision = store.standingRuleFor({
      sessionId: "s1",
      commandId: "slack.send",
      target: "#ops-alerts",
    });
    expect(decision).toEqual({
      allowed: true,
      rule: "slack.send → #ops-alerts",
      sessionId: "s1",
    });
  });

  it("never auto-allows an unmatched target even when rule exists for the command", () => {
    const store = new InboxStore();
    const item = store.addApproval(
      baseline({
        toolCallId: "tc4",
        data: { taskId: "T", commandId: "slack.send", standingTarget: "#ops" },
      }),
    );
    store.resolve(item.id, "always");

    expect(
      store.standingRuleFor({
        taskId: "T",
        sessionId: "s1",
        commandId: "slack.send",
        target: "#other-channel",
      }),
    ).toBeNull();
  });
});

describe("argsPreview", () => {
  it("formats key-value pairs compactly, clips long content, caps the total", () => {
    expect(argsPreview({ a: "x", b: 2 })).toBe("a: x · b: 2");
    expect(
      argsPreview({ path: "x".repeat(120) }).length,
    ).toBeLessThanOrEqual(240);
    expect(argsPreview(undefined)).toBe("");
  });
});
