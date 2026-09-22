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
import { PROTECTED_MODULE_IDS as IAM_PROTECTED } from "@chaste/module-iam";
import { ALL_MODULE_IDS, PROTECTED_MODULE_IDS as SHELL_PROTECTED } from "../app/(app)/_shell/modules";
import { buildRegistry, createDbModuleGate } from "./kernel";

/**
 * Module switchboard contract:
 *  - a disabled module's capabilities are refused by the executor for every
 *    actor type, even with "*" permissions and a valid payload
 *  - scopedToModules removes disabled tools so agent loops never see them
 *  - protected spine modules (iam, routines, signals) are always enabled:
 *    the gate reports them on and every save path unions them back in
 *  - iam.setModules is identity-class: a permitted human applies it directly
 *    under their own authority (ADR 0055); agents are gated into the inbox
 *  - the previous set rides along in the output for exact restoration
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
  it("shell catalog and iam module agree on the protected spine", () => {
    expect([...SHELL_PROTECTED].sort()).toEqual([...IAM_PROTECTED].sort());
    for (const id of IAM_PROTECTED) {
      expect(ALL_MODULE_IDS).toContain(id);
    }
  });

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

  it("applies directly for a permitted human; the workmate still needs approval", async () => {
    const executor = makeGatedExecutor();

    // A permitted human IS the human authority: no self-approval detour (ADR 0055).
    const humanApply = await executor.execute(
      "iam.setModules",
      ctxWith("human", ["iam.admin"]),
      { modules: ["accounting", "crm", "iam"] },
    );
    expect(humanApply.ok).toBe(true);
    const data = humanApply.data as { previousModules: string[]; enabledModules: string[] };
    expect(data.previousModules).toContain("support");

    // With crm now on, the gate flips for the next execution.
    const probe = await executor.execute(
      "crm.createCustomer",
      ctxWith("human", ["crm.write"]),
      { name: "Post-toggle Acme" },
    );
    expect(probe.ok).toBe(true);

    // An agent proposing the same change is gated into the inbox.
    const agentAttempt = await executor.execute(
      "iam.setModules",
      ctxWith("agent", ["iam.admin"]),
      { modules: ["accounting"] },
    );
    expect(agentAttempt.ok).toBe(false);
    expect(agentAttempt.pendingApproval?.capabilityId).toBe("iam.setModules");
  });

  it("never drops the protected spine modules, whatever the caller sends", async () => {
    const executor = makeGatedExecutor();

    const applied = await executor.execute(
      "iam.setModules",
      ctxWith("human", ["iam.admin"]),
      // Deliberately omits iam, routines, and signals: the historical
      // deadlock came from exactly this payload shape.
      { modules: ["accounting", "crm"] },
    );
    expect(applied.ok).toBe(true);
    const data = applied.data as { enabledModules: string[] };
    for (const id of ["iam", "routines", "signals"]) {
      expect(data.enabledModules).toContain(id);
    }

    // And the module gate agrees, even reading the raw org row.
    const gate = createDbModuleGate(db);
    for (const id of ["iam", "routines", "signals"]) {
      expect(await gate.isEnabled(orgId, id)).toBe(true);
    }
    expect(await gate.isEnabled(orgId, "messaging")).toBe(false);
  });

  it("carries the previous set for its inverse", async () => {
    const cap = registry.require("iam.setModules");
    expect(cap.risk).toBe("identity");
    expect(cap.inverse?.capabilityId).toBe("iam.restoreModules");
    const restored = cap.inverse!.buildInput({}, { previousModules: ["accounting"], enabledModules: ["x"] });
    expect(restored).toEqual({ modules: ["accounting"] });
  });
});
