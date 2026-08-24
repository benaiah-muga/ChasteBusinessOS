import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CapabilityRegistry } from "@chaste/kernel";
import {
  DefaultPolicyEngine,
  InMemoryLedger,
  KernelExecutor,
  type ActionContext,
  type ModuleGate,
} from "@chaste/kernel";
import { createDb, memberships, organizations, users, type Database } from "@chaste/db";
import { buildRegistry, createDbModuleGate } from "./kernel";

/**
 * Module switchboard contract:
 *  - a disabled module's capabilities are refused by the executor for every
 *    actor type, even with "*" permissions and a valid payload
 *  - scopedToModules removes disabled tools so agent loops never see them
 *  - iam.setModules is identity-class: always approval-gated, reversible via
 *    the previousModules snapshot carried in its output
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let pg: Database;
let db: Database["db"];
let registry: CapabilityRegistry;
let executorAllOn: KernelExecutor;
let executorCrmOff: KernelExecutor;
const orgId = crypto.randomUUID();
let userId: string;
const gateOff: ModuleGate = { isEnabled: (_orgId, m) => m !== "crm" };

function ctxWith(type: "human" | "agent", permissions: string[]): ActionContext {
  return {
    actor: { type, id: userId, orgId, permissions: new Set(permissions) },
    now: new Date(),
    services: {},
  };
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  const [user] = await db
    .insert(users)
    .values({ email: `modules-${orgId.slice(0, 8)}@example.com`, name: "Owner" })
    .returning();
  userId = user!.id;
  await db
    .insert(organizations)
    .values({ id: orgId, name: "Modules Org", slug: `modules-${orgId.slice(0, 8)}`, enabledModules: ["accounting", "iam", "messaging", "support"] });
  await db.insert(memberships).values({ orgId, userId });

  registry = buildRegistry(db);
  // Executor without any module gate: baseline behavior.
  executorAllOn = new KernelExecutor({
    registry,
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
  });
  executorCrmOff = new KernelExecutor({
    registry,
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
    modules: gateOff,
  });
});

afterAll(async () => {
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("module switchboard", () => {
  it("executes normally when every module is enabled", async () => {
    const result = await executorAllOn.execute(
      "crm.createCustomer",
      ctxWith("human", ["crm.write"]),
      { name: "Acme" },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a disabled module's capability even with wildcard permission", async () => {
    for (const actorType of ["human", "agent"] as const) {
      const result = await executorCrmOff.execute(
        "crm.createCustomer",
        ctxWith(actorType, ["*"]),
        { name: "Sneaky" },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('module "crm" is disabled');
    }
  });

  it("checks the module gate before input validation leaks details", async () => {
    // Garbage input on a disabled module reports the module refusal, not a
    // zod dump: availability is the first fact to establish.
    const result = await executorCrmOff.execute(
      "crm.createCustomer",
      ctxWith("human", ["*"]),
      { totallyInvalid: true },
    );
    expect(result.error).toContain("disabled");
  });

  it("scopedToModules removes disabled tools from the agent surface", () => {
    const enabled = new Set(["accounting", "iam"]);
    const scoped = registry.scopedToModules(enabled);
    expect(scoped.get("accounting.createInvoice")).toBeTruthy();
    expect(scoped.get("iam.inviteMember")).toBeTruthy();
    expect(scoped.get("crm.createCustomer")).toBeUndefined();
    expect(scoped.get("hr.requestLeave")).toBeUndefined();
  });

  it("null scope means unrestricted", () => {
    const scoped = registry.scopedToModules(null);
    expect(scoped.all().length).toBe(registry.all().length);
  });
});

describe("iam.setModules governance", () => {
  function makeGatedExecutor() {
    const store = new Map<string, { payload: unknown; capabilityId: string }>();
    let seq = 0;
    const executor = new KernelExecutor({
      registry,
      policy: new DefaultPolicyEngine(),
      ledger: new InMemoryLedger(),
      modules: createDbModuleGate(db),
      approvals: {
        async submit(request) {
          const id = `apr-${++seq}`;
          store.set(id, { payload: request.payload, capabilityId: request.capabilityId });
          return false;
        },
        async verify(approvalId, request) {
          const row = store.get(approvalId);
          return Boolean(row && row.capabilityId === request.capabilityId);
        },
      },
    });
    void seq;
    return executor;
  }

  it("is identity-class: humans and agents are gated, approval applies it", async () => {
    const executor = makeGatedExecutor();

    const humanAttempt = await executor.execute(
      "iam.setModules",
      ctxWith("human", ["iam.admin"]),
      { modules: ["accounting", "crm", "iam"] },
    );
    // Gated attempts come back not-ok with the request attached for the inbox.
    expect(humanAttempt.ok).toBe(false);
    expect(humanAttempt.pendingApproval?.capabilityId).toBe("iam.setModules");

    // Approve the same payload through the governed path.
    const approved = await executor.execute(
      "iam.setModules",
      ctxWith("human", ["iam.admin"]),
      { modules: ["accounting", "crm", "iam"] },
      { approvedApprovalId: "apr-1" },
    );
    expect(approved.ok).toBe(true);
    const data = approved.data as { previousModules: string[] };
    expect(data.previousModules).toContain("support");

    // With crm now on, the gate flips for the next execution.
    const probe = await executor.execute(
      "crm.createCustomer",
      ctxWith("human", ["crm.write"]),
      { name: "Post-toggle Acme" },
    );
    console.log("PROBE", JSON.stringify(probe));
    expect(probe.ok).toBe(true);
  });

  it("carries the previous set for its inverse", async () => {
    const cap = registry.require("iam.setModules");
    expect(cap.risk).toBe("identity");
    expect(cap.inverse?.capabilityId).toBe("iam.restoreModules");
    const restored = cap.inverse!.buildInput({}, { previousModules: ["accounting"], enabledModules: ["x"] });
    expect(restored).toEqual({ modules: ["accounting"] });
  });
});
