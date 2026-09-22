import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { DefaultPolicyEngine, InMemoryLedger, KernelExecutor, type ActionContext } from "@chaste/kernel";
import { createDb, memberships, moduleSettings, organizations, policies, users, type Database } from "@chaste/db";
import { PROTECTED_MODULE_IDS as IAM_PROTECTED } from "@chaste/module-iam";
import { buildRegistry, buildPolicyEngine } from "./kernel";

/**
 * Module configuration + org policy contract:
 *  - iam.setModuleConfig validates payloads against the module's registered
 *    schema before storing (the registry injects the schemas kernel-side)
 *  - one row per org per module: upsert, never duplicates
 *  - iam.setOrgPolicy upserts the blanket rule, and the org policy engine
 *    applies strict mode (requiresApprovalFor) to humans immediately
 *  - protected spine stays in sync with the shell catalog
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let pg: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();
let userId: string;

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
    .values({ email: `modcfg-${orgId.slice(0, 8)}@example.com`, name: "Owner" })
    .returning();
  userId = user!.id;
  await db.insert(organizations).values({ id: orgId, name: "Settings Org", slug: `modcfg-${orgId.slice(0, 8)}` });
  await db.insert(memberships).values({ orgId, userId });
});

afterAll(async () => {
  await db.delete(moduleSettings).where(eq(moduleSettings.orgId, orgId));
  await db.delete(policies).where(eq(policies.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("iam.setModuleConfig", () => {
  it("validates against the module's registered schema", async () => {
    const executor = buildExecutorSafe();
    const bad = await executor.execute("iam.setModuleConfig", ctxWith("human", ["iam.admin"]), {
      module: "inventory",
      settings: { defaultUnitLabel: "x".repeat(500) },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("invalid settings");
  });

  it("upserts one row per org and module, schema-checked", async () => {
    const executor = buildExecutorSafe();
    const first = await executor.execute("iam.setModuleConfig", ctxWith("human", ["iam.admin"]), {
      module: "inventory",
      settings: { defaultUnitLabel: "kg" },
    });
    expect(first.ok).toBe(true);
    const again = await executor.execute("iam.setModuleConfig", ctxWith("human", ["iam.admin"]), {
      module: "inventory",
      settings: { defaultUnitLabel: "kg", defaultReorderPointUnits: 12 },
    });
    expect(again.ok).toBe(true);

    const rows = await db
      .select()
      .from(moduleSettings)
      .where(and(eq(moduleSettings.orgId, orgId), eq(moduleSettings.module, "inventory")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.settings).toMatchObject({ defaultUnitLabel: "kg", defaultReorderPointUnits: 12 });

    // Unknown modules store plain records: future modules work before their schema lands.
    const custom = await executor.execute("iam.setModuleConfig", ctxWith("human", ["iam.admin"]), {
      module: "custom_module",
      settings: { anyShape: true },
    });
    expect(custom.ok).toBe(true);
  });

  it("refuses non-admins", async () => {
    const executor = buildExecutorSafe();
    const denied = await executor.execute("iam.setModuleConfig", ctxWith("human", ["crm.write"]), {
      module: "inventory",
      settings: { defaultUnitLabel: "kg" },
    });
    expect(denied.ok).toBe(false);
  });
});

describe("iam.setOrgPolicy", () => {
  it("upserts the blanket rule and the engine applies strict mode", async () => {
    const executor = buildExecutorSafe();
    const applied = await executor.execute("iam.setOrgPolicy", ctxWith("human", ["iam.admin"]), {
      maxRiskAutonomous: "write",
      moneyThresholdMinor: 1234,
      requiresApprovalFor: ["identity"],
    });
    expect(applied.ok).toBe(true);

    const rows = await db
      .select()
      .from(policies)
      .where(and(eq(policies.orgId, orgId), eq(policies.capabilityPattern, "*")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.moneyThresholdMinor).toBe(1234);
    expect(rows[0]?.requiresApprovalFor).toEqual(["identity"]);

    // Strict mode re-gates humans for identity-class actions (ADR 0055).
    const engine = buildPolicyEngine(db);
    const setModulesCap = buildRegistry(db).get("iam.setModules");
    expect(setModulesCap).toBeTruthy();
    const decision = await engine.evaluate(ctxWith("human", ["iam.admin"]), setModulesCap!, {});
    expect(decision.requiresApproval).toBe(true);
  });
});

it("the protected spine matches the iam module's list", () => {
  expect(IAM_PROTECTED).toEqual(["iam", "signals", "routines"]);
});

function buildExecutorSafe() {
  // In-memory ledger + no module gate, like the module tests: this suite
  // exercises capability and policy behavior, not switchboard gating.
  return new KernelExecutor({
    registry: buildRegistry(db),
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
  });
}
