import { describe, expect, it } from "vitest";
import { InMemorySessionLog, sessionEvent } from "./session-log.js";
import { reconstructModelRequest, summarizeModelRequest } from "./reconstruct.js";

const now = () => new Date("2026-08-16T09:00:00Z");

describe("InMemorySessionLog", () => {
  it("is append-only and returns events in append order", async () => {
    const log = new InMemorySessionLog();
    const a = sessionEvent("s1", "o1", "session/start", {}, { now });
    const b = sessionEvent("s1", "o1", "user/message", { content: "hello" }, { now });
    await log.append(a);
    await log.append(b);

    const events = await log.list("s1");
    expect(events.map((e) => e.type)).toEqual(["session/start", "user/message"]);
  });

  it("lists sessions per organization", async () => {
    const log = new InMemorySessionLog();
    await log.append(sessionEvent("s1", "o1", "session/start", {}, { now }));
    await log.append(sessionEvent("s2", "o1", "session/start", {}, { now }));
    await log.append(sessionEvent("s3", "o2", "session/start", {}, { now }));

    expect(await log.listSessions("o1")).toEqual(["s1", "s2"]);
    expect(await log.listSessions("o2")).toEqual(["s3"]);
  });
});

describe("reconstructModelRequest", () => {
  it("rebuilds a complete model-visible request from durable events", async () => {
    const log = new InMemorySessionLog();
    await log.append(sessionEvent("s1", "o1", "session/start", {}, { now }));
    await log.append(
      sessionEvent("s1", "o1", "user/message", { content: "low stock?", role: "user" }, { now }),
    );
    await log.append(
      sessionEvent("s1", "o1", "context/assembled", { bundleId: "cb-1", turn: 1 }, { now }),
    );
    await log.append(
      sessionEvent(
        "s1",
        "o1",
        "model/request",
        {
          modelRoute: "cheap",
          provider: "local",
          model: "small",
          systemPromptSections: ["You are the Chaste operator."],
          messages: [{ role: "user", content: "low stock?" }],
          toolSchemas: [{ name: "inventory_stockout_risk" }],
          evidenceRefs: [{ id: "e1", type: "query_result", ref: "q1" }],
          memoryReads: ["org: prefers weekly summaries"],
          contextBundleId: "cb-1",
        },
        { now },
      ),
    );
    await log.append(
      sessionEvent(
        "s1",
        "o1",
        "policy/decision",
        {
          kind: "allow",
          policy: "inventory.read",
          reason: "role allows",
          evaluatedAt: now().toISOString(),
          context: {},
        },
        { now },
      ),
    );

    const r = await log.list("s1");
    const rebuilt = reconstructModelRequest("s1", r);

    expect(rebuilt.complete).toBe(true);
    expect(rebuilt.gaps).toEqual([]);
    expect(rebuilt.systemPromptSections).toEqual(["You are the Chaste operator."]);
    expect(rebuilt.messages).toContainEqual({ role: "user", content: "low stock?" });
    expect(rebuilt.toolSchemas).toContainEqual({ name: "inventory_stockout_risk" });
    expect(rebuilt.evidenceRefs).toContainEqual({ id: "e1", type: "query_result", ref: "q1" });
    expect(rebuilt.memoryReads).toEqual(["org: prefers weekly summaries"]);
    expect(rebuilt.contextBundleIds).toContain("cb-1");
    expect(rebuilt.policyDecisions[0]?.policy).toBe("inventory.read");

    expect(summarizeModelRequest(rebuilt).join("\n")).toContain("reconstruction: complete");
  });

  it("flags incomplete streams that must not have been served", async () => {
    const log = new InMemorySessionLog();
    await log.append(sessionEvent("s1", "o1", "session/start", {}, { now }));
    // No model/request, no messages, no tool schemas.

    const r = await log.list("s1");
    const rebuilt = reconstructModelRequest("s1", r);

    expect(rebuilt.complete).toBe(false);
    expect(rebuilt.gaps.length).toBeGreaterThan(0);
    expect(rebuilt.gaps).toContain("no model/request event");
  });
});
