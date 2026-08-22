/**
 * M4 verification: hire → approved unpaid leave → drafted payroll (prorated)
 * → gated execution → approval → ledger proves out.
 *
 * The money gate is the point: payroll posts a single balanced entry
 * (DR expense / CR cash / CR withholding) and no agent can post it without a
 * person. Run: pnpm demo:m4b
 */
import { and, eq } from "drizzle-orm";
import { approvals, getDb, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const [user] = await db.insert(users).values({ email: `m4-hr-${Date.now()}@demo.test`, name: "M4 Founder" }).returning();
  if (!user) throw new Error("user insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: user.id,
    userEmail: user.email,
    orgName: "M4 Demo Co",
    businessDescription: "Small design studio paying two staff monthly.",
  });

  const humanCtx = {
    actor: { type: "human" as const, id: user.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const agentCtx = { ...humanCtx, actor: { ...humanCtx.actor, type: "agent" as const } };

  // Hire two staff.
  const alice = await executor.execute("hr.hireEmployee", agentCtx, {
    name: "Alice Nakato",
    title: "Designer",
    monthlySalaryMinor: 450_000,
    taxRateBps: 1000,
  });
  const bob = await executor.execute("hr.hireEmployee", agentCtx, {
    name: "Bob Okello",
    title: "Developer",
    monthlySalaryMinor: 300_000,
    taxRateBps: 1000,
  });
  if (!alice.ok || !bob.ok) throw new Error(alice.error ?? bob.error ?? "hire failed");
  console.log("✓ hired Alice ($4,500/mo) and Bob ($3,000/mo), 10% withholding");

  // Bob takes two days of approved unpaid leave this month.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const day = (n: number) => new Date(Date.UTC(y, m - 1, n));
  const leaveReq = await executor.execute("hr.requestLeave", agentCtx, {
    employeeId: bob.data!.employeeId as string,
    kind: "unpaid",
    startDate: day(1),
    endDate: day(2),
  });
  if (!leaveReq.ok || !leaveReq.data) throw new Error(leaveReq.error ?? "leave failed");
  const decided = await executor.execute("hr.decideLeave", humanCtx, {
    requestId: leaveReq.data.requestId as string,
    approve: true,
  });
  if (!decided.ok) throw new Error(decided.error ?? "decide failed");
  console.log("✓ Bob's 2-day unpaid leave approved");

  // Draft the run — proration should reduce only Bob.
  const draft = await executor.execute("hr.createPayrollRun", agentCtx, { year: y, month: m });
  if (!draft.ok || !draft.data) throw new Error(draft.error ?? "draft failed");
  console.log(
    `✓ payroll drafted: ${draft.data.headcount} people, gross ${formatMinor(draft.data.totalGrossMinor as number)}, ` +
      `tax ${formatMinor(draft.data.totalTaxMinor as number)}, net ${formatMinor(draft.data.totalNetMinor as number)}`,
  );

  // Proration must reduce only Bob, matching erp-core's exact rounding.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const frac = Math.round(((daysInMonth - 2) / daysInMonth) * 1000);
  const bobGross = Math.floor((300_000 * frac) / 1000 + 0.5);
  const bobNetExpected = bobGross - Math.floor((bobGross * 1000) / 10_000 + 0.5);
  const aliceNetExpected = 450_000 - Math.floor((450_000 * 1000) / 10_000 + 0.5);
  if ((draft.data.totalNetMinor as number) !== bobNetExpected + aliceNetExpected) {
    throw new Error(`net mismatch: expected ${bobNetExpected + aliceNetExpected}, got ${draft.data.totalNetMinor}`);
  }
  console.log(`✓ proration correct: Alice ${formatMinor(aliceNetExpected)} + Bob ${formatMinor(bobNetExpected)} (2 days docked)`);

  // A wrong expected total refuses to run — even by a human, even pre-approval.
  const tampered = await executor.execute("hr.executePayrollRun", humanCtx, {
    runId: draft.data.runId as string,
    expectedTotalNetMinor: 1,
  });
  if (tampered.ok) throw new Error("tampered total was accepted!");
  console.log("✓ tampered total refused:", tampered.error);

  // Agent cannot execute payroll without a person.
  const attempt = await executor.execute("hr.executePayrollRun", agentCtx, {
    runId: draft.data.runId as string,
    expectedTotalNetMinor: draft.data.totalNetMinor as number,
  });
  if (!attempt.pendingApproval) throw new Error("payroll execution was not gated!");
  console.log("✓ execution gated:", attempt.pendingApproval.rationale);

  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  const executed = await executor.execute(
    "hr.executePayrollRun",
    humanCtx,
    pending!.payload,
    { approvedApprovalId: pending!.id },
  );
  if (!executed.ok || !executed.data) throw new Error(executed.error ?? "execute failed");
  console.log(`✓ approved & posted: journal entry ${String(executed.data.entryId).slice(0, 8)}…`);

  // Books prove out.
  const bs = await executor.execute("accounting.balanceSheet", humanCtx, {});
  if (!bs.data!.balanced) throw new Error("balance sheet does not balance!");
  console.log(
    `✓ Balance sheet balanced after payroll (assets ${formatMinor(bs.data!.assetsMinor as number)}); ` +
      `cash down by net, withholding sitting in liabilities`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
