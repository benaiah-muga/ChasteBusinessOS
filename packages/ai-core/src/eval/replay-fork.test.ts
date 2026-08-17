import { describe, expect, it } from "vitest";
import { InMemorySessionLog } from "../trajectory/index.js";
import { sessionEvent } from "../trajectory/index.js";
import { assertReplayInvariant, ReplayInvariantViolation, replaySession } from "./replay.js";
import { forkSession } from "./fork.js";

const now = () => new Date("2026-08-16T10:00:00Z");

function completeTraceEvents(sessionId: string, organizationId: string) {
  const events = [
    sessionEvent(sessionId, organizationId, "session/start", { channel: "api" }, { now }),
    sessionEvent(
      sessionId,
      organizationId,
      "model/request",
      {
        modelRoute: "planning",
        provider: "eval",
        model: "eval-harness",
        systemPromptSections: ["Policy: act within granted permissions."],
        messages: [{ role: "user", content: "List purchase orders" }],
        toolSchemas: [{ name: "purchasing_list_purchase_orders" }],
        evidenceRefs: [],
        memoryReads: [],
      },
      { now },
    ),
  ];
  return events;
}

describe("replaySession", () => {
  it("reconstructs a complete session into the model-visible request", async () => {
    const log = new InMemorySessionLog();
    for (const e of completeTraceEvents("s1", "o1")) await log.append(e);

    const trace = await replaySession(log, "s1");
    expect(trace.complete).toBe(true);
    expect(trace.gaps).toEqual([]);
    expect(trace.totalEvents).toBe(2);
    expect(trace.reconstructed.messages).toEqual([{ role: "user", content: "List purchase orders" }]);
    expect(trace.reconstructed.toolSchemas).toHaveLength(1);
    expect(trace.reconstructed.modelRoutes).toEqual(["planning"]);
  });

  it("is deterministic — replaying twice gives the same reconstruction", async () => {
    const log = new InMemorySessionLog();
    for (const e of completeTraceEvents("s1", "o1")) await log.append(e);
    const a = await replaySession(log, "s1");
    const b = await replaySession(log, "s1");
    expect(a).toEqual(b);
  });

  it("reports gaps for an incomplete stream without throwing", async () => {
    const log = new InMemorySessionLog();
    await log.append(sessionEvent("s1", "o1", "session/start", {}, { now }));
    const trace = await replaySession(log, "s1");
    expect(trace.complete).toBe(false);
    expect(trace.gaps).toContain("no model/request event");
  });

  it("assertReplayInvariant fails closed on an incomplete stream", async () => {
    const log = new InMemorySessionLog();
    await log.append(sessionEvent("s1", "o1", "session/start", {}, { now }));
    const trace = await replaySession(log, "s1");
    expect(() => assertReplayInvariant(trace)).toThrow(ReplayInvariantViolation);
  });
});

describe("forkSession", () => {
  it("copies events up to the boundary and marks session/forked + session/resumed", async () => {
    const log = new InMemorySessionLog();
    for (const e of completeTraceEvents("s1", "o1")) await log.append(e);

    const result = await forkSession(log, "s1", {
      newSessionId: "s1-fork",
      uptoSeq: 2,
      organizationId: "o1",
      forkedByUserId: "human-1",
      reason: "test fork before decision",
      now,
    });

    expect(result.copied).toBe(2);
    const forkEvents = await log.list("s1-fork");
    expect(forkEvents).toHaveLength(4); // 2 copied + session/forked + session/resumed
    expect(forkEvents[0]!.type).toBe("session/start");
    expect(forkEvents[1]!.type).toBe("model/request");
    expect(forkEvents[2]!.type).toBe("session/forked");
    expect(forkEvents[3]!.type).toBe("session/resumed");

    // The fork replays identically to the source up to the boundary.
    const forkTrace = await replaySession(log, "s1-fork");
    const sourceTrace = await replaySession(log, "s1");
    expect(forkTrace.complete).toBe(true);
    expect(forkTrace.reconstructed).toEqual({
      ...sourceTrace.reconstructed,
      sessionId: forkTrace.sessionId,
    });
  });

  it("is isolated — the source stream is unchanged and the fork has its own id", async () => {
    const log = new InMemorySessionLog();
    for (const e of completeTraceEvents("s1", "o1")) await log.append(e);
    await forkSession(log, "s1", {
      newSessionId: "s1-fork",
      uptoSeq: 1,
      organizationId: "o1",
      forkedByUserId: "human-1",
      now,
    });

    const source = await log.list("s1");
    const fork = await log.list("s1-fork");
    expect(source).toHaveLength(2);
    expect(fork.some((e) => e.id === source[0]!.id)).toBe(false);
    expect(fork[0]!.sessionId).toBe("s1-fork");
  });

  it("rejects unknown sessions and out-of-range boundaries", async () => {
    const log = new InMemorySessionLog();
    await expect(
      forkSession(log, "ghost", {
        newSessionId: "f",
        uptoSeq: 1,
        organizationId: "o1",
        forkedByUserId: "human-1",
      }),
    ).rejects.toThrow(/unknown or empty/);

    for (const e of completeTraceEvents("s1", "o1")) await log.append(e);
    await expect(
      forkSession(log, "s1", {
        newSessionId: "f",
        uptoSeq: 99,
        organizationId: "o1",
        forkedByUserId: "human-1",
      }),
    ).rejects.toThrow(RangeError);
  });
});