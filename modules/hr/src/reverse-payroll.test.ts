import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  employees,
  journalEntries,
  journalLines,
  organizations,
  payrollRuns,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerHrCapabilities, type ModuleDeps } from "./index";

/**
 * Payroll compensation (N12, ADR 0051): an executed run is undone by
 * hr.reversePayrollPosting — it mirrors the posting in the original
 * currency AND repairs the run lifecycle, which the generic journal mirror
 * never did (the ledger and the run status used to disagree).
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerHrCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Payroll Reversal Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Payroll Reversal Probe", slug: `prr-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "6000", name: "Salary Expense", type: "expense" },
    { orgId, code: "2200", name: "Withholding Payable", type: "liability" },
  ]);
  await db.db.insert(employees).values({
    orgId,
    name: "Probe Employee",
    monthlySalaryMinor: 120_000,
    taxRateBps: 2000,
  });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
  await db.db.$client.end();
});

let nextMonth = 7;

async function executedRun(): Promise<{ runId: string; entryId: string; totalNetMinor: number }> {
  nextMonth += 1;
  const draft = await run("hr.createPayrollRun", { year: 2026, month: nextMonth });
  const execution = await run("hr.executePayrollRun", {
    runId: draft.runId,
    expectedTotalNetMinor: draft.totalNetMinor,
  });
  return { runId: draft.runId, entryId: execution.entryId, totalNetMinor: draft.totalNetMinor };
}

describe("N12 payroll compensation", () => {
  it("reversing an executed run mirrors the posting and repairs the lifecycle", async () => {
    const { runId, entryId, totalNetMinor } = await executedRun();

    const reversal = await run("hr.reversePayrollPosting", { runId, reason: "wrong month drafted" });
    expect(reversal.reversedNetMinor).toBe(totalNetMinor);

    const [runRow] = await db.db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
    expect(runRow!.status).toBe("reversed");
    expect(runRow!.reversedAt).toBeTruthy();

    const [mirror] = await db.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.reversalOfId, entryId));
    expect(mirror!.sourceType).toBe("payroll_reversal");
    expect(mirror!.currency).toBe("USD");

    // The original posts DR expense gross / CR cash net / CR withholding —
    // the mirror swaps every side at the same gross amount.
    const lines = await db.db.select().from(journalLines).where(eq(journalLines.entryId, mirror!.id));
    let net = 0;
    for (const l of lines) net += l.debitMinor - l.creditMinor;
    expect(net).toBe(0);
    expect(lines.reduce((s, l) => s + l.debitMinor, 0)).toBe(runRow!.totalGrossMinor);
  });

  it("refuses a second reversal, a draft reversal, and routes void guidance", async () => {
    const { runId } = await executedRun();
    await run("hr.reversePayrollPosting", { runId, reason: "first reversal" });
    // The lifecycle guard refuses first: a reversed run is not executed.
    await expect(
      run("hr.reversePayrollPosting", { runId, reason: "replayed reversal" }),
    ).rejects.toThrow("only executed runs can be reversed");

    const draft = await run("hr.createPayrollRun", { year: 2026, month: 12 });
    await expect(
      run("hr.reversePayrollPosting", { runId: draft.runId, reason: "draft cannot reverse" }),
    ).rejects.toThrow("only executed runs can be reversed");

    // The old guidance pointed at the generic mirror; it must name the
    // domain compensation now.
    const executed = await executedRun();
    await expect(run("hr.voidPayrollRun", { runId: executed.runId })).rejects.toThrow(
      /hr\.reversePayrollPosting/,
    );

    const [runRow] = await db.db.select().from(payrollRuns).where(eq(payrollRuns.id, draft.runId));
    expect(runRow!.status).toBe("draft");
  });
});
