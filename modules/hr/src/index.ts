import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  employees,
  leaveRequests,
  payrollRuns,
  payslips,
  timeEntries,
  type Database,
} from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import {
  buildPayrollEntryLines,
  computePayslips,
  summarizeRun,
  unpaidLeaveDaysInMonth,
  workedFractionThousandths,
} from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { assertPeriodOpen, postEntry } from "@chaste/module-accounting/posting";

export interface ModuleDeps {
  db: Database["db"];
}


const PAYROLL_ACCOUNTS = { expenseCode: "6000", cashCode: "1000", withholdingCode: "2200" };

function calendarDaysBetween(start: Date, end: Date): number {
  const dayMs = 86_400_000;
  return Math.floor((end.getTime() - start.getTime()) / dayMs) + 1;
}

const hireEmployee = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.hireEmployee",
    title: "Hire employee",
    intent:
      "Add an employee with a monthly salary, tax rate and leave entitlement so they can be paid through payroll runs and request leave",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    inverse: {
      capabilityId: "hr.deactivateEmployee",
      buildInput: (_input, output) => ({ employeeId: (output as { employeeId?: string }).employeeId ?? "" }),
    },
    input: z.object({
      name: z.string().min(1).max(120),
      email: z.string().email().optional(),
      title: z.string().max(80).optional(),
      monthlySalaryMinor: z.number().int().nonnegative(),
      taxRateBps: z.number().int().min(0).max(5000).default(1000),
      annualLeaveDays: z.number().int().min(0).max(365).default(21),
    }),
    output: z.object({ employeeId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(employees)
        .values({
          orgId: ctx.actor.orgId,
          name: input.name,
          email: input.email ?? null,
          title: input.title ?? null,
          monthlySalaryMinor: input.monthlySalaryMinor,
          taxRateBps: input.taxRateBps,
          annualLeaveDays: input.annualLeaveDays,
        })
        .returning({ id: employees.id });
      return { employeeId: row!.id };
    },
  });

const deactivateEmployee = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.deactivateEmployee",
    title: "Deactivate employee",
    intent:
      "Mark an employee as no longer active so future payroll runs skip them; history and payslips are preserved",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    // Terminal by design: re-hiring creates a fresh record; the audit trail
    // keeps the old one. No inverse is honest here.
    input: z.object({ employeeId: z.string() }),
    output: z.object({ deactivated: z.boolean() }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(employees)
        .set({ deactivatedAt: ctx.now })
        .where(and(eq(employees.orgId, ctx.actor.orgId), eq(employees.id, input.employeeId)))
        .returning({ id: employees.id });
      return { deactivated: updated.length > 0 };
    },
  });

const requestLeave = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.requestLeave",
    title: "Request leave",
    intent:
      "File a leave request for an employee; approved unpaid leave reduces the next payroll run for the days taken",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    inverse: {
      capabilityId: "hr.cancelLeave",
      buildInput: (_input, output) => ({ requestId: (output as { requestId?: string }).requestId ?? "" }),
    },
    input: z.object({
      employeeId: z.string(),
      kind: z.enum(["annual", "sick", "unpaid"]).default("annual"),
      // ISO strings, not z.date(): models emit strings, and date schemas
      // cannot be presented as JSON Schema tool parameters.
      startDate: z.string().describe("first day of leave as an ISO date (YYYY-MM-DD)"),
      endDate: z.string().describe("last day of leave as an ISO date (YYYY-MM-DD)"),
    }),
    output: z.object({ requestId: z.string(), calendarDays: z.number() }),
    execute: async (ctx, input) => {
      const startDate = new Date(input.startDate);
      const endDate = new Date(input.endDate);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw new Error("leave dates must be valid ISO dates (YYYY-MM-DD)");
      }
      if (endDate.getTime() < startDate.getTime()) throw new Error("leave cannot end before it starts");
      const calendarDays = calendarDaysBetween(startDate, endDate);
      const [row] = await deps.db
        .insert(leaveRequests)
        .values({
          orgId: ctx.actor.orgId,
          employeeId: input.employeeId,
          kind: input.kind,
          startDate,
          endDate,
          calendarDays,
          requestedByActorType: ctx.actor.type,
          requestedByActorId: ctx.actor.id,
        })
        .returning({ id: leaveRequests.id });
      return { requestId: row!.id, calendarDays };
    },
  });

const cancelLeave = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.cancelLeave",
    title: "Cancel leave request",
    intent: "Cancel a pending leave request before a manager decides on it",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    input: z.object({ requestId: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(leaveRequests)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(leaveRequests.orgId, ctx.actor.orgId),
            eq(leaveRequests.id, input.requestId),
            eq(leaveRequests.status, "pending"),
          ),
        )
        .returning({ id: leaveRequests.id });
      if (updated.length === 0) throw new Error("no pending leave request with that id");
      return { cancelled: true };
    },
  });

const decideLeave = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.decideLeave",
    title: "Decide leave request",
    intent: "Approve or reject a pending leave request; approval is final and feeds payroll proration",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    // A decision is final by definition; reversing one means filing a new
    // request. The ledger records who decided.
    input: z.object({
      requestId: z.string(),
      approve: z.boolean(),
      comment: z.string().max(500).optional(),
    }),
    output: z.object({ status: z.enum(["approved", "rejected"]) }),
    execute: async (ctx, input) => {
      const status = input.approve ? "approved" : "rejected";
      const updated = await deps.db
        .update(leaveRequests)
        .set({
          status,
          decidedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
          decidedAt: ctx.now,
        })
        .where(
          and(
            eq(leaveRequests.orgId, ctx.actor.orgId),
            eq(leaveRequests.id, input.requestId),
            eq(leaveRequests.status, "pending"),
          ),
        )
        .returning({ id: leaveRequests.id });
      if (updated.length === 0) throw new Error("no pending leave request with that id");
      return { status };
    },
  });

const createPayrollRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.createPayrollRun",
    title: "Draft payroll run",
    intent:
      "Draft a month's payroll: prorated payslips for every active employee, reduced by approved unpaid leave, ready for execution",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    inverse: {
      capabilityId: "hr.voidPayrollRun",
      buildInput: (_input, output) => ({ runId: (output as { runId?: string }).runId ?? "" }),
    },
    input: z.object({
      year: z.number().int().min(2020).max(2100),
      month: z.number().int().min(1).max(12),
    }),
    output: z.object({
      runId: z.string(),
      headcount: z.number(),
      totalGrossMinor: z.number(),
      totalTaxMinor: z.number(),
      totalNetMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [dupe] = await tx
          .select({ id: payrollRuns.id })
          .from(payrollRuns)
          .where(and(eq(payrollRuns.orgId, ctx.actor.orgId), eq(payrollRuns.year, input.year), eq(payrollRuns.month, input.month)))
          .limit(1);
        if (dupe) throw new Error(`a payroll run for ${input.year}-${String(input.month).padStart(2, "0")} already exists`);

        const staff = await tx
          .select()
          .from(employees)
          .where(and(eq(employees.orgId, ctx.actor.orgId), sql`${employees.deactivatedAt} is null`))
          .orderBy(asc(employees.name));
        if (staff.length === 0) throw new Error("no active employees to pay");

        const lines: Parameters<typeof computePayslips>[0] = [];
        for (const e of staff) {
          const unpaid = await tx
            .select({ startDate: leaveRequests.startDate, endDate: leaveRequests.endDate })
            .from(leaveRequests)
            .where(
              and(
                eq(leaveRequests.employeeId, e.id),
                eq(leaveRequests.kind, "unpaid"),
                eq(leaveRequests.status, "approved"),
                lte(leaveRequests.startDate, new Date(Date.UTC(input.year, input.month, 1))),
                gte(leaveRequests.endDate, new Date(Date.UTC(input.year, input.month - 1, 1))),
              ),
            );
          const worked = workedFractionThousandths(input.year, input.month, unpaidLeaveDaysInMonth(unpaid, input.year, input.month));
          lines.push({
            employeeRef: e.id,
            monthlySalaryMinor: e.monthlySalaryMinor,
            workedFractionThousandths: worked,
            taxRateBps: e.taxRateBps,
          });
        }

        const computed = computePayslips(lines);
        const summary = summarizeRun(computed);

        const [run] = await tx
          .insert(payrollRuns)
          .values({
            orgId: ctx.actor.orgId,
            year: input.year,
            month: input.month,
            totalGrossMinor: summary.totalGrossMinor,
            totalTaxMinor: summary.totalTaxMinor,
            totalNetMinor: summary.totalNetMinor,
            headcount: summary.headcount,
          })
          .returning({ id: payrollRuns.id });
        if (!run) throw new Error("run insert failed");

        await tx.insert(payslips).values(
          computed.map((p, i) => ({
            orgId: ctx.actor.orgId,
            runId: run.id,
            employeeId: staff[i]!.id,
            grossMinor: p.grossMinor,
            taxMinor: p.taxMinor,
            netMinor: p.netMinor,
            workedFractionThousandths: lines[i]!.workedFractionThousandths,
          })),
        );

        return {
          runId: run.id,
          headcount: summary.headcount,
          totalGrossMinor: summary.totalGrossMinor,
          totalTaxMinor: summary.totalTaxMinor,
          totalNetMinor: summary.totalNetMinor,
        };
      });
    },
  });

const executePayrollRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.executePayrollRun",
    title: "Execute payroll run",
    intent:
      "Post an approved month's payroll to the general ledger as one balanced entry, salary expense debited, cash credited for net, withholding liability for tax",
    module: "hr",
    risk: "money",
    permission: "hr.write",
    moneyThresholdMinor: 0,
    // Caller-asserted total must match the drafted run (execution refuses
    // mismatches), so it is the honest gating amount.
    moneyAmount: (input) => input.expectedTotalNetMinor,
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId?: string }).entryId ?? "" }),
    },
    input: z.object({
      runId: z.string(),
      expectedTotalNetMinor: z.number().int().nonnegative().describe("must match the drafted total; wrong values refuse to run"),
    }),
    output: z.object({ entryId: z.string(), totalGrossMinor: z.number(), totalNetMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [run] = await tx
          .select()
          .from(payrollRuns)
          .where(and(eq(payrollRuns.orgId, ctx.actor.orgId), eq(payrollRuns.id, input.runId)))
          .limit(1);
        if (!run) throw new Error(`no payroll run ${input.runId}`);
        if (run.status !== "draft") throw new Error(`run is ${run.status}, not draft`);
        if (input.expectedTotalNetMinor !== run.totalNetMinor) {
          throw new Error(`total mismatch: draft says ${run.totalNetMinor}, caller expected ${input.expectedTotalNetMinor}`);
        }
        // Mid-month date representing the run's payroll period; the shared
        // guard rejects posting when that month has been sealed.
        await assertPeriodOpen(tx, ctx.actor.orgId, new Date(Date.UTC(run.year, run.month - 1, 15)));

        const summary = {
          totalGrossMinor: run.totalGrossMinor,
          totalTaxMinor: run.totalTaxMinor,
          totalNetMinor: run.totalNetMinor,
          headcount: run.headcount,
        };
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `payroll ${run.year}-${String(run.month).padStart(2, "0")}`,
          sourceType: "payroll_run",
          sourceId: run.id,
          lines: buildPayrollEntryLines(PAYROLL_ACCOUNTS, summary),
        });

        await tx
          .update(payrollRuns)
          .set({
            status: "executed",
            entryId,
            executedByActorType: ctx.actor.type,
            executedByActorId: ctx.actor.id,
            executedAt: ctx.now,
          })
          .where(eq(payrollRuns.id, run.id));

        return { entryId, totalGrossMinor: run.totalGrossMinor, totalNetMinor: run.totalNetMinor };
      });
    },
  });

const voidPayrollRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.voidPayrollRun",
    title: "Void payroll run",
    intent:
      "Discard a drafted payroll run that has not been posted; executed runs must be reversed in the ledger instead",
    module: "hr",
    risk: "destructive",
    permission: "hr.write",
    input: z.object({ runId: z.string() }),
    output: z.object({ voided: z.boolean() }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(payrollRuns)
        .set({ status: "voided", voidedAt: ctx.now })
        .where(
          and(
            eq(payrollRuns.orgId, ctx.actor.orgId),
            eq(payrollRuns.id, input.runId),
            eq(payrollRuns.status, "draft"),
          ),
        )
        .returning({ id: payrollRuns.id });
      if (updated.length === 0) throw new Error("no draft payroll run with that id (executed runs reverse via accounting.reverseEntry)");
      return { voided: true };
    },
  });

const listEmployees = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.listEmployees",
    title: "List employees",
    intent: "Show every employee with salary, tax rate and active status so payroll scope is visible",
    module: "hr",
    risk: "read",
    permission: "hr.read",
    input: z.object({}),
    output: z.object({
      employees: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          title: z.string().nullable(),
          monthlySalaryMinor: z.number(),
          taxRateBps: z.number(),
          active: z.boolean(),
        }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select()
        .from(employees)
        .where(eq(employees.orgId, ctx.actor.orgId))
        .orderBy(desc(employees.hiredAt))
        .limit(200);
      return {
        employees: rows.map((e) => ({
          id: e.id,
          name: e.name,
          title: e.title,
          monthlySalaryMinor: e.monthlySalaryMinor,
          taxRateBps: e.taxRateBps,
          active: e.deactivatedAt === null,
        })),
      };
    },
  });


// ── Timesheets ──────────────────────────────────────────────────────────

const MAX_MINUTES_PER_DAY = 24 * 60;

const logTime = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.logTime",
    title: "Log time entry",
    intent:
      "Record hours an employee worked on a specific date with a short note, submitted for supervisor approval before it counts anywhere",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    input: z.object({
      employeeId: z.string().uuid(),
      /** ISO strings, not z.date(): models emit strings, and date schemas are not JSON-serializable. */
      workDate: z.string().describe("ISO date (YYYY-MM-DD)"),
      minutes: z.number().int().positive().max(MAX_MINUTES_PER_DAY),
      note: z.string().max(300).optional(),
    }),
    output: z.object({ entryId: z.string(), status: z.literal("submitted") }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [emp] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.id, input.employeeId), eq(employees.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!emp) throw new Error("employee not found");
        if (new Date(input.workDate).getTime() > ctx.now.getTime() + 86_400_000) {
          throw new Error("cannot log time more than a day in the future");
        }
        const [row] = await tx
          .insert(timeEntries)
          .values({
            orgId: ctx.actor.orgId,
            employeeId: emp.id,
            workDate: new Date(input.workDate),
            minutes: input.minutes,
            note: input.note ?? null,
          })
          .returning({ id: timeEntries.id });
        return { entryId: row!.id, status: "submitted" as const };
      });
    },
  });

const decideTimeEntry = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.decideTimeEntry",
    title: "Approve time entry",
    intent:
      "Approve or reject a submitted timesheet entry so only verified hours flow into reports",
    module: "hr",
    risk: "write",
    permission: "hr.write",
    input: z.object({
      entryId: z.string().uuid(),
      decision: z.enum(["approved", "rejected"]),
    }),
    output: z.object({ entryId: z.string(), status: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .update(timeEntries)
          .set({
            status: input.decision,
            decidedByActorType: ctx.actor.type,
            decidedByActorId: ctx.actor.id,
          })
          .where(
            and(
              eq(timeEntries.id, input.entryId),
              eq(timeEntries.orgId, ctx.actor.orgId),
              eq(timeEntries.status, "submitted"),
            ),
          )
          .returning({ id: timeEntries.id });
        if (rows.length === 0) throw new Error("entry not found or already decided");
        return { entryId: input.entryId, status: input.decision };
      });
    },
  });

const timeReport = (deps: ModuleDeps) =>
  defineCapability({
    id: "hr.timeReport",
    title: "Time report",
    intent:
      "Summarize approved hours per employee over a date range for payroll review and client billing decisions",
    module: "hr",
    risk: "read",
    permission: "hr.read",
    input: z.object({
      from: z.string().describe("range start, ISO date (YYYY-MM-DD)"),
      to: z.string().describe("range end, ISO date (YYYY-MM-DD)"),
      employeeId: z.string().uuid().optional(),
    }),
    output: z.object({
      rows: z.array(
        z.object({
          employeeId: z.string(),
          approvedMinutes: z.number(),
          pendingMinutes: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (_tx) => {
        void _tx;
        const rows = await deps.db
          .select({
            employeeId: timeEntries.employeeId,
            status: timeEntries.status,
            minutes: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)`,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.orgId, ctx.actor.orgId),
              gte(timeEntries.workDate, new Date(input.from)),
              lte(timeEntries.workDate, new Date(input.to)),
              input.employeeId ? eq(timeEntries.employeeId, input.employeeId) : undefined,
            ),
          )
          .groupBy(timeEntries.employeeId, timeEntries.status);
        const byEmp = new Map<string, { approvedMinutes: number; pendingMinutes: number }>();
        for (const r of rows) {
          const cur = byEmp.get(r.employeeId) ?? { approvedMinutes: 0, pendingMinutes: 0 };
          if (r.status === "approved") cur.approvedMinutes += Number(r.minutes);
          else if (r.status === "submitted") cur.pendingMinutes += Number(r.minutes);
          byEmp.set(r.employeeId, cur);
        }
        return {
          rows: [...byEmp.entries()].map(([employeeId, v]) => ({ employeeId, ...v })),
        };
      });
    },
  });

export function registerHrCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(logTime(deps));
  registry.register(decideTimeEntry(deps));
  registry.register(timeReport(deps));
  registry.register(hireEmployee(deps));
  registry.register(deactivateEmployee(deps));
  registry.register(requestLeave(deps));
  registry.register(cancelLeave(deps));
  registry.register(decideLeave(deps));
  registry.register(createPayrollRun(deps));
  registry.register(executePayrollRun(deps));
  registry.register(voidPayrollRun(deps));
  registry.register(listEmployees(deps));
}
