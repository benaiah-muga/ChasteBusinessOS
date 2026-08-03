import { describe, expect, it } from "vitest";
import {
  selfWakeTools,
  WakeStore,
  type WakeKind,
  type WakeRecord,
  type WakeState,
} from "./selfwake.js";
import { ChannelSessionStore } from "./channels.js";

describe("WakeStore", () => {
  it("adds a timer wake and fires only after the fireAt passes", () => {
    const start = new Date("2026-08-01T10:00:00Z");
    const store = new WakeStore({ now: () => start });

    const w = store.addTimer("s1", new Date("2026-08-01T11:00:00Z"), { note: "weekly" });
    expect(w.kind).toBe<WakeKind>("timer");
    expect(w.state).toBe<WakeState>("pending");
    expect(w.fireAt).toBe("2026-08-01T11:00:00.000Z");
    expect(store.due(start)).toEqual([]); // not yet
    expect(store.due(new Date("2026-08-01T11:30:00Z")).map((x) => x.id)).toEqual([w.id]);
    store.markFired(w.id);
    expect(store.due(new Date("2026-08-01T12:00:00Z"))).toEqual([]);
  });

  it("completion wakes are inert until completeJob marks the same jobId due", () => {
    const store = new WakeStore();
    const w = store.addCompletion("s1", "job-7");
    expect(store.due()).toEqual([]);
    const marked = store.completeJob("other-job");
    expect(marked).toEqual([]);
    const due = store.completeJob("job-7");
    expect(due.map((x) => x.id)).toEqual([w.id]);
    expect(store.due().map((x) => x.id)).toEqual([w.id]);
    store.markFired(w.id);
    expect(store.due()).toEqual([]);
  });

  it("event wakes fire when fireEvent matches the eventKey", () => {
    const store = new WakeStore();
    const w = store.addEvent("s1", "hr.payroll.completed");
    expect(store.fireEvent("something.else")).toEqual([]);
    const marked = store.fireEvent("hr.payroll.completed");
    expect(marked.map((x) => x.id)).toEqual([w.id]);
    expect(store.due().map((x) => x.id)).toEqual([w.id]);
  });

  it("preserves stable createdAt order across mixed kinds", () => {
    const t0 = new Date("2026-08-01T10:00:00Z");
    const t1 = new Date("2026-08-01T10:05:00Z");
    const store = new WakeStore({ now: () => t0 });
    const a = store.addTimer("s1", t1);
    const b = store.addCompletion("s1", "j1");
    // b's createdAt is also t0; both pending. Fire them and the order must keep createdAt-stable
    store.completeJob("j1");
    const due = store.due(new Date("2026-08-01T11:00:00Z"));
    // both fire; expect them in insertion order by createdAt (both equal -> stable sort returns insertion order)
    expect(due.map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it("`pending(sessionId)` filters by session and excludes fired", () => {
    const store = new WakeStore();
    const a = store.addTimer("s1", new Date(Date.now() + 1000));
    const b = store.addTimer("s2", new Date(Date.now() + 1000));
    store.markFired(a.id);
    expect(store.pending("s1")).toEqual([]);
    expect(store.pending("s2").map((x) => x.id)).toEqual([b.id]);
  });
});

describe("selfWakeTools", () => {
  it("returns the same durable record the store holds", () => {
    const store = new WakeStore();
    const tools = selfWakeTools(store, "s1", { taskId: "task-1" });
    const r1 = tools.sleepFor(60, "weekly digest");
    expect(store.pending("s1").some((w) => w.id === r1.wakeId)).toBe(true);

    const t = tools.sleepUntil("2026-09-01T08:00:00Z");
    expect(t.fireAt).toBe("2026-09-01T08:00:00.000Z");

    const c = tools.wakeOnJob("job-42");
    expect(c.jobId).toBe("job-42");

    const e = tools.wakeOnEvent("hr.payroll.completed");
    expect(e.eventKey).toBe("hr.payroll.completed");
  });

  it("sleepUntil rejects malformed timestamps (never silently fires immediately)", () => {
    const store = new WakeStore();
    const tools = selfWakeTools(store, "s1");
    expect(() => tools.sleepUntil("not-a-date")).toThrow(/invalid iso timestamp/);
  });
});

describe("ChannelSessionStore (inbound mentions, R10)", () => {
  it("puts and looks up by thread target; upserts preserve createdAt", () => {
    const t0 = new Date("2026-08-01T10:00:00Z");
    const store = new ChannelSessionStore({ now: () => t0 });
    const first = store.set("slack:C0123:1700", "s1", "slack:C0123", {
      organizationId: "o1",
      branchId: "b1",
    });
    expect(first.createdAt).toBe(t0.toISOString());

    const second = store.set("slack:C0123:1700", "s2", "slack:C0123", {
      organizationId: "o2",
    });
    expect(second.createdAt).toBe(t0.toISOString()); // preserved
    expect(store.get("slack:C0123:1700")?.sessionId).toBe("s2");
  });

  it("drops all of a session's thread mappings on session deletion", () => {
    const store = new ChannelSessionStore();
    store.set("slack:C1:ts1", "s1", "slack:C1", { organizationId: "o1" });
    store.set("slack:C2:ts2", "s1", "slack:C2", { organizationId: "o1" });
    store.set("slack:C3:ts3", "s2", "slack:C3", { organizationId: "o1" });

    expect(store.targetsFor("s1").sort()).toEqual(["slack:C1:ts1", "slack:C2:ts2"]);
    expect(store.removeSession("s1")).toBe(2);
    expect(store.get("slack:C1:ts1")).toBeUndefined();
    expect(store.targetsFor("s1")).toEqual([]);
    // other session untouched
    expect(store.get("slack:C3:ts3")?.sessionId).toBe("s2");
  });

  it("overwriting a thread target re-homes it to the new session without poisoning the old index", () => {
    // Regression: re-binding a thread target to a NEW session must remove it
    // from the OLD session's bySession index. Otherwise deleting the old
    // session would delete the brand-new binding too.
    const store = new ChannelSessionStore();
    store.set("slack:C1:ts1", "s1", "slack:C1", { organizationId: "o1" });
    // Re-home the same thread to session s2 (e.g. a respawn).
    const rebound = store.set("slack:C1:ts1", "s2", "slack:C1", { organizationId: "o1" });
    expect(rebound.sessionId).toBe("s2");

    // The old session should no longer claim this thread target.
    expect(store.targetsFor("s1")).toEqual([]);
    // Deleting the old session must NOT clobber the new binding.
    expect(store.removeSession("s1")).toBe(0);
    expect(store.get("slack:C1:ts1")?.sessionId).toBe("s2");
  });

  it("removeSession only deletes threads the owning session still actually owns", () => {
    const store = new ChannelSessionStore();
    store.set("slack:A:t1", "s1", "slack:A", { organizationId: "o1" });
    store.set("slack:A:t2", "s1", "slack:A", { organizationId: "o1" });
    // s1 loses ownership of A:t1 to s3; s1 still owns A:t2 exclusively.
    store.set("slack:A:t1", "s3", "slack:A", { organizationId: "o1" });

    expect(store.removeSession("s1")).toBe(1); // only A:t2
    expect(store.get("slack:A:t1")?.sessionId).toBe("s3");
    expect(store.get("slack:A:t2")).toBeUndefined();
  });

  it("filters by organization and channel", () => {
    const store = new ChannelSessionStore();
    store.set("slack:A:t1", "s1", "slack:A", { organizationId: "o1" });
    store.set("slack:B:t2", "s2", "slack:B", { organizationId: "o1" });
    store.set("slack:A:t3", "s3", "slack:A", { organizationId: "o2" });

    expect(store.list({ organizationId: "o1" }).map((t) => t.threadTarget)).toEqual([
      "slack:A:t1",
      "slack:B:t2",
    ]);
    expect(store.list({ channel: "slack:A" }).map((t) => t.threadTarget)).toEqual([
      "slack:A:t1",
      "slack:A:t3",
    ]);
  });
});
