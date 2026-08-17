import { describe, expect, it } from "vitest";
import {
  InMemoryPlanStore,
  fromPendingPlanRecord,
  pendingPlanRecordSchema,
  toPendingPlanRecord,
  type PendingPlanEntry,
} from "./plan-store.js";
import type { Actor } from "@chaste/kernel";

function entry(overrides: Partial<PendingPlanEntry> = {}): PendingPlanEntry {
  const actor: Actor = {
    kind: "user",
    userId: "u1",
    organizationId: "o1",
    permissions: new Set(["crm.customer.create", "acc.invoice.create"]),
  };
  return {
    plan: {
      id: "plan-1",
      objective: "Create customer and invoice",
      assumptions: [],
      steps: [
        { id: "s1", title: "Create customer", command: "crm.customer.create" },
        { id: "s2", title: "Invoice", command: "acc.invoice.create", dependsOn: ["s1"] },
      ],
      requiredApprovals: [],
      risks: [],
      evidenceNeeded: [],
      stopConditions: [],
    },
    itemId: "item-1",
    params: {
      sessionId: "sess-1",
      organizationId: "o1",
      actor,
      plan: undefined as unknown as PendingPlanEntry["plan"],
      correlationId: "corr-1",
      causationId: "caused-1",
      origin: "agent",
      reason: "Automate onboarding",
      evidenceRefs: [{ id: "e1", type: "query_result", ref: "customers/1" }],
      policyContext: { branchId: "b1" },
    },
    approverUserId: "u2",
    ...overrides,
  };
}

describe("plan-store serialization", () => {
  it("round-trips a live entry through its storable record", () => {
    const live = entry();
    const record = toPendingPlanRecord(live);

    // permissions Set → array on the way in.
    expect(record.params.actor.permissions).toEqual(["crm.customer.create", "acc.invoice.create"]);
    expect(record.plan.id).toBe("plan-1");

    const parsed = pendingPlanRecordSchema.parse(record);
    const back = fromPendingPlanRecord(parsed);
    expect(back.plan.id).toBe("plan-1");
    expect(back.itemId).toBe("item-1");
    expect(back.params.actor.userId).toBe("u1");
    expect(back.params.correlationId).toBe("corr-1");
    expect(back.params.evidenceRefs?.[0]?.ref).toBe("customers/1");
    expect(back.params.policyContext).toEqual({ branchId: "b1" });
    // permissions array → Set on the way out; authority is preserved.
    expect([...back.params.actor.permissions]).toEqual([
      "crm.customer.create",
      "acc.invoice.create",
    ]);
    // The plan is restored onto params so a replayed run is self-contained.
    expect(back.params.plan.id).toBe("plan-1");
  });

  it("rejects a record with an invalid plan shape", () => {
    const record = toPendingPlanRecord(entry());
    const bad = { ...record, plan: { ...record.plan, steps: [] } };
    expect(pendingPlanRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe("InMemoryPlanStore", () => {
  it("saves, looks up by item/plan id, lists, and removes", async () => {
    const store = new InMemoryPlanStore();
    const a = entry();
    const b = entry({ plan: { ...entry().plan, id: "plan-2" }, itemId: "item-2" });
    await store.save(a);
    await store.save(b);

    expect((await store.getByItemId("item-1"))?.plan.id).toBe("plan-1");
    expect((await store.getByPlanId("plan-2"))?.itemId).toBe("item-2");
    expect((await store.listByOrg("o1")).length).toBe(2);
    expect((await store.listAll()).length).toBe(2);
    expect(await store.getByItemId("nope")).toBeUndefined();

    await store.remove("item-1");
    expect(await store.getByItemId("item-1")).toBeUndefined();
    expect((await store.listAll()).length).toBe(1);
  });

  it("returns defensive copies of stored entries", async () => {
    const store = new InMemoryPlanStore();
    const a = entry();
    await store.save(a);
    a.params.actor.permissions.add("extra.perm");
    expect([...(await store.getByItemId("item-1"))!.params.actor.permissions]).toEqual([
      "crm.customer.create",
      "acc.invoice.create",
    ]);
  });
});