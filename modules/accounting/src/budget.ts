import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, budgetLines, budgetScenarios, journalEntries, journalLines, organizations, poLines, purchaseOrders, vendorBillLines, vendorBills, withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { compareBudget, calculateTaxLine, remainingCommitmentMinor } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

interface ModuleDeps {
  db: Database["db"];
}

const assumptionsSchema = z.object({
  collectionDelayDays: z.number().int().safe().min(0).max(180).default(0),
  spendUpliftBasisPoints: z.number().int().safe().min(0).max(20_000).default(0),
  expectedMonthlyInflowMinor: z.number().int().safe().nonnegative().default(0),
  expectedMonthlyOutflowMinor: z.number().int().safe().nonnegative().default(0),
  minimumCashBufferMinor: z.number().int().safe().nonnegative().default(0),
});

const budgetLineInput = z.object({
  month: z.number().int().min(1).max(12),
  accountCode: z.string().regex(/^\d{4}$/),
  plannedMinor: z.number().int().safe().nonnegative(),
  note: z.string().max(300).optional(),
});

const saveBudgetScenario = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.saveBudgetScenario",
    title: "Save budget scenario",
    intent: "Save a named, versioned monthly budget with cash assumptions so the team can compare posted actuals and unbilled commitments against plan",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    inverse: {
      capabilityId: "accounting.undoBudgetScenarioVersion",
      buildInput: (_input, output) => ({ scenarioId: output.scenarioId, previousScenarioId: output.previousScenarioId }),
    },
    input: z.object({
      scenarioKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
      name: z.string().min(2).max(100),
      fiscalYear: z.number().int().min(2000).max(2100),
      currency: z.string().regex(/^[A-Z]{3}$/),
      assumptions: assumptionsSchema.default({
        collectionDelayDays: 0,
        spendUpliftBasisPoints: 0,
        expectedMonthlyInflowMinor: 0,
        expectedMonthlyOutflowMinor: 0,
        minimumCashBufferMinor: 0,
      }),
      lines: z.array(budgetLineInput).min(1).max(240).superRefine((lines, ctx) => {
        const seen = new Set<string>();
        lines.forEach((line, index) => {
          const key = `${line.month}:${line.accountCode}`;
          if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: "account and month may appear once per version" });
          seen.add(key);
        });
      }),
    }),
    output: z.object({ scenarioId: z.string(), version: z.number(), previousScenarioId: z.string().nullable() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.actor.orgId}), hashtext(${input.scenarioKey}))`);
      const [org] = await tx.select({ currency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, ctx.actor.orgId)).limit(1);
      if (org && org.currency !== input.currency) throw new Error(`budget currency must match the organization's base currency (${org.currency})`);
      const codes = [...new Set(input.lines.map((line) => line.accountCode))];
      const known = await tx.select({ code: accounts.code, type: accounts.type }).from(accounts).where(and(eq(accounts.orgId, ctx.actor.orgId), inArray(accounts.code, codes)));
      const valid = new Set(known.filter((account) => account.type === "income" || account.type === "expense").map((account) => account.code));
      const missing = codes.filter((code) => !valid.has(code));
      if (missing.length > 0) throw new Error(`budget lines must reference income or expense accounts: ${missing.join(", ")}`);

      const [previous] = await tx.select({ id: budgetScenarios.id, version: budgetScenarios.version }).from(budgetScenarios)
        .where(and(eq(budgetScenarios.orgId, ctx.actor.orgId), eq(budgetScenarios.scenarioKey, input.scenarioKey), eq(budgetScenarios.isCurrent, true)))
        .orderBy(desc(budgetScenarios.version)).limit(1).for("update");
      const version = (previous?.version ?? 0) + 1;
      if (previous) await tx.update(budgetScenarios).set({ isCurrent: false }).where(eq(budgetScenarios.id, previous.id));
      const [scenario] = await tx.insert(budgetScenarios).values({
        orgId: ctx.actor.orgId,
        scenarioKey: input.scenarioKey,
        name: input.name,
        fiscalYear: input.fiscalYear,
        version,
        currency: input.currency,
        assumptions: input.assumptions,
        createdByActorType: ctx.actor.type,
        createdByActorId: ctx.actor.id,
      }).returning({ id: budgetScenarios.id });
      await tx.insert(budgetLines).values(input.lines.map((line) => ({
        orgId: ctx.actor.orgId,
        scenarioId: scenario!.id,
        month: line.month,
        accountCode: line.accountCode,
        plannedMinor: line.plannedMinor,
        note: line.note ?? null,
      })));
      return { scenarioId: scenario!.id, version, previousScenarioId: previous?.id ?? null };
    }),
  });

const undoBudgetScenarioVersion = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.undoBudgetScenarioVersion",
    title: "Undo budget version",
    intent: "Restore the prior current budget version after an accidental save while retaining the new version in its history",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    inverse: {
      capabilityId: "accounting.restoreBudgetScenarioVersion",
      buildInput: (input) => input,
    },
    input: z.object({ scenarioId: z.string().uuid(), previousScenarioId: z.string().uuid().nullable() }),
    output: z.object({ scenarioId: z.string(), restoredScenarioId: z.string().nullable() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [candidate] = await tx.select({ scenarioKey: budgetScenarios.scenarioKey }).from(budgetScenarios)
        .where(and(eq(budgetScenarios.id, input.scenarioId), eq(budgetScenarios.orgId, ctx.actor.orgId))).limit(1);
      if (!candidate) throw new Error("budget version not found");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.actor.orgId}), hashtext(${candidate.scenarioKey}))`);
      const [scenario] = await tx.select({ id: budgetScenarios.id, scenarioKey: budgetScenarios.scenarioKey, isCurrent: budgetScenarios.isCurrent }).from(budgetScenarios)
        .where(and(eq(budgetScenarios.id, input.scenarioId), eq(budgetScenarios.orgId, ctx.actor.orgId))).limit(1).for("update");
      if (!scenario?.isCurrent) throw new Error("the saved version is no longer current");
      await tx.update(budgetScenarios).set({ isCurrent: false }).where(eq(budgetScenarios.id, scenario.id));
      if (input.previousScenarioId) {
        const restored = await tx.update(budgetScenarios).set({ isCurrent: true }).where(and(
          eq(budgetScenarios.id, input.previousScenarioId), eq(budgetScenarios.orgId, ctx.actor.orgId), eq(budgetScenarios.scenarioKey, scenario.scenarioKey), eq(budgetScenarios.isCurrent, false),
        )).returning({ id: budgetScenarios.id });
        if (restored.length === 0) throw new Error("the prior budget version is no longer available");
      }
      return { scenarioId: scenario.id, restoredScenarioId: input.previousScenarioId };
    }),
  });

const restoreBudgetScenarioVersion = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.restoreBudgetScenarioVersion",
    title: "Restore budget version",
    intent: "Make a previously saved budget version current again while preserving every version in the audit history",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    inverse: { capabilityId: "accounting.undoBudgetScenarioVersion", buildInput: (input) => input },
    input: z.object({ scenarioId: z.string().uuid(), previousScenarioId: z.string().uuid().nullable() }),
    output: z.object({ scenarioId: z.string(), restoredScenarioId: z.string().nullable() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [candidate] = await tx.select({ scenarioKey: budgetScenarios.scenarioKey }).from(budgetScenarios)
        .where(and(eq(budgetScenarios.id, input.scenarioId), eq(budgetScenarios.orgId, ctx.actor.orgId))).limit(1);
      if (!candidate) throw new Error("budget version not found");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.actor.orgId}), hashtext(${candidate.scenarioKey}))`);
      const [scenario] = await tx.select({ id: budgetScenarios.id, scenarioKey: budgetScenarios.scenarioKey }).from(budgetScenarios)
        .where(and(eq(budgetScenarios.id, input.scenarioId), eq(budgetScenarios.orgId, ctx.actor.orgId))).limit(1).for("update");
      if (!scenario) throw new Error("budget version not found");
      await tx.update(budgetScenarios).set({ isCurrent: false }).where(and(eq(budgetScenarios.orgId, ctx.actor.orgId), eq(budgetScenarios.scenarioKey, scenario.scenarioKey)));
      await tx.update(budgetScenarios).set({ isCurrent: true }).where(eq(budgetScenarios.id, scenario.id));
      return { scenarioId: scenario.id, restoredScenarioId: input.previousScenarioId };
    }),
  });

const listBudgetScenarios = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.listBudgetScenarios",
    title: "List budget scenarios",
    intent: "List saved budget versions for a fiscal year so the team can switch between plans and inspect the version history",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ fiscalYear: z.number().int().min(2000).max(2100).optional() }),
    output: z.object({ scenarios: z.array(z.object({ id: z.string(), key: z.string(), name: z.string(), fiscalYear: z.number(), version: z.number(), currency: z.string(), isCurrent: z.boolean(), assumptions: assumptionsSchema, createdAt: z.string() })) }),
    execute: async (ctx, input) => {
      const rows = await deps.db.select().from(budgetScenarios).where(and(
        eq(budgetScenarios.orgId, ctx.actor.orgId),
        input.fiscalYear ? eq(budgetScenarios.fiscalYear, input.fiscalYear) : sql`true`,
      )).orderBy(asc(budgetScenarios.scenarioKey), desc(budgetScenarios.version));
      return { scenarios: rows.map((row) => ({
        id: row.id,
        key: row.scenarioKey,
        name: row.name,
        fiscalYear: row.fiscalYear,
        version: row.version,
        currency: row.currency,
        isCurrent: row.isCurrent,
        assumptions: assumptionsSchema.parse(row.assumptions),
        createdAt: row.createdAt.toISOString(),
      })) };
    },
  });

const budgetActualVsPlan = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.budgetActualVsPlan",
    title: "Compare budget to actuals",
    intent: "Compare monthly budget amounts with posted general-ledger actuals and remaining unbilled purchase-order commitments, without double counting bills already posted",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ scenarioId: z.string().uuid() }),
    output: z.object({ scenarioId: z.string(), name: z.string(), fiscalYear: z.number(), currency: z.string(), unconvertedEntryCount: z.number(), months: z.array(z.object({ month: z.number(), lines: z.array(z.object({ accountCode: z.string(), accountName: z.string(), accountType: z.string(), planMinor: z.number(), actualMinor: z.number(), committedMinor: z.number(), projectedMinor: z.number(), varianceMinor: z.number(), utilizationBps: z.number().nullable() })) })) }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [scenario] = await tx.select().from(budgetScenarios).where(and(eq(budgetScenarios.id, input.scenarioId), eq(budgetScenarios.orgId, ctx.actor.orgId))).limit(1);
      if (!scenario) throw new Error("budget scenario not found");
      const planRows = await tx.select({ month: budgetLines.month, accountCode: budgetLines.accountCode, planMinor: budgetLines.plannedMinor })
        .from(budgetLines).where(and(eq(budgetLines.orgId, ctx.actor.orgId), eq(budgetLines.scenarioId, scenario.id)));
      const actualRows = await tx.select({
        month: sql<number>`extract(month from ${journalEntries.postedAt})::integer`,
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        debitMinor: sql<string>`coalesce(sum(${journalLines.debitMinor}), 0)::text`,
        creditMinor: sql<string>`coalesce(sum(${journalLines.creditMinor}), 0)::text`,
      }).from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(and(
          eq(journalEntries.orgId, ctx.actor.orgId),
          eq(journalEntries.currency, scenario.currency),
          gte(journalEntries.postedAt, new Date(Date.UTC(scenario.fiscalYear, 0, 1))),
          lt(journalEntries.postedAt, new Date(Date.UTC(scenario.fiscalYear + 1, 0, 1))),
          inArray(accounts.type, ["income", "expense"]),
          sql`${journalEntries.entryKind} <> 'year_end_close'`,
        )).groupBy(sql`extract(month from ${journalEntries.postedAt})`, accounts.code, accounts.name, accounts.type);
      const foreignEntries = await tx.select({ count: sql<number>`count(distinct ${journalEntries.id})::integer` })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(and(
          eq(journalEntries.orgId, ctx.actor.orgId),
          sql`${journalEntries.currency} <> ${scenario.currency}`,
          gte(journalEntries.postedAt, new Date(Date.UTC(scenario.fiscalYear, 0, 1))),
          lt(journalEntries.postedAt, new Date(Date.UTC(scenario.fiscalYear + 1, 0, 1))),
          inArray(accounts.type, ["income", "expense"]),
        ));

      const poRows = await tx.select({
        id: poLines.id,
        poId: poLines.poId,
        monthAt: sql<Date>`coalesce(${purchaseOrders.promisedAt}, ${purchaseOrders.orderedAt}, ${purchaseOrders.createdAt})`,
        accountCode: poLines.expenseAccountCode,
        quantity: poLines.quantity,
        unitPriceMinor: poLines.unitPriceMinor,
      }).from(poLines).innerJoin(purchaseOrders, eq(purchaseOrders.id, poLines.poId)).where(and(
        eq(purchaseOrders.orgId, ctx.actor.orgId),
        inArray(purchaseOrders.status, ["ordered", "partial", "received"]),
        sql`${purchaseOrders.voidedAt} is null`,
        gte(sql<Date>`coalesce(${purchaseOrders.promisedAt}, ${purchaseOrders.orderedAt}, ${purchaseOrders.createdAt})`, new Date(Date.UTC(scenario.fiscalYear, 0, 1))),
        lt(sql<Date>`coalesce(${purchaseOrders.promisedAt}, ${purchaseOrders.orderedAt}, ${purchaseOrders.createdAt})`, new Date(Date.UTC(scenario.fiscalYear + 1, 0, 1))),
      ));
      const poLineIds = poRows.map((row) => row.id);
      const billedRows = poLineIds.length ? await tx.select({
        poLineId: vendorBillLines.poLineId,
        quantity: vendorBillLines.quantity,
        unitPriceMinor: vendorBillLines.unitPriceMinor,
        taxMinor: vendorBillLines.taxMinor,
        taxRateBasisPoints: vendorBillLines.taxRateBasisPoints,
        priceIncludesTax: vendorBillLines.priceIncludesTax,
      }).from(vendorBillLines)
        .innerJoin(vendorBills, eq(vendorBills.id, vendorBillLines.billId))
        .where(and(inArray(vendorBillLines.poLineId, poLineIds), eq(vendorBills.orgId, ctx.actor.orgId), sql`${vendorBills.status} <> 'void'`)) : [];
      const billedByLine = new Map<string, bigint>();
      for (const row of billedRows) {
        if (!row.poLineId) continue;
        const billedBase = calculateTaxLine(row.quantity, row.unitPriceMinor, row.taxRateBasisPoints ?? 0, row.priceIncludesTax).netMinor;
        const billedTotal = (billedByLine.get(row.poLineId) ?? 0n) + BigInt(billedBase);
        if (billedTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("billed purchase commitment exceeds the supported amount range");
        billedByLine.set(row.poLineId, billedTotal);
      }
      const committed = new Map<string, number>();
      for (const po of poRows) {
        const ordered = BigInt(calculateTaxLine(po.quantity, po.unitPriceMinor, 0).netMinor);
        const billed = Number(billedByLine.get(po.id) ?? 0n);
        const remaining = remainingCommitmentMinor(Number(ordered), billed);
        if (remaining === 0) continue;
        const month = new Date(po.monthAt).getUTCMonth() + 1;
        const key = `${month}:${po.accountCode}`;
        const next = BigInt(committed.get(key) ?? 0) + BigInt(remaining);
        if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("purchase commitments exceed the supported amount range");
        committed.set(key, Number(next));
      }

      const accountRows = await tx.select({ code: accounts.code, name: accounts.name, type: accounts.type }).from(accounts)
        .where(and(eq(accounts.orgId, ctx.actor.orgId), inArray(accounts.code, [...new Set(planRows.map((row) => row.accountCode).concat([...committed.keys()].map((key) => key.split(":")[1]!)))])));
      const accountByCode = new Map(accountRows.map((row) => [row.code, row]));
      const actualByKey = new Map<string, number>();
      for (const row of actualRows) {
        const debit = Number(row.debitMinor);
        const credit = Number(row.creditMinor);
        const amount = row.accountType === "income" ? credit - debit : debit - credit;
        actualByKey.set(`${row.month}:${row.accountCode}`, amount);
      }
      const months = Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        const keys = new Set([
          ...planRows.filter((row) => row.month === month).map((row) => row.accountCode),
          ...[...committed.keys()].filter((key) => key.startsWith(`${month}:`)).map((key) => key.split(":")[1]!),
          ...actualRows.filter((row) => row.month === month).map((row) => row.accountCode),
        ]);
        return {
          month,
          lines: [...keys].sort().map((accountCode) => {
            const account = accountByCode.get(accountCode);
            const planMinor = Number(planRows.find((row) => row.month === month && row.accountCode === accountCode)?.planMinor ?? 0);
            const actualMinor = actualByKey.get(`${month}:${accountCode}`) ?? 0;
            const committedMinor = committed.get(`${month}:${accountCode}`) ?? 0;
            const comparison = compareBudget({ planMinor, actualMinor, committedMinor });
            return { accountCode, accountName: account?.name ?? accountCode, accountType: account?.type ?? "expense", planMinor, actualMinor, committedMinor, projectedMinor: comparison.projectedMinor, varianceMinor: comparison.varianceMinor, utilizationBps: comparison.utilizationBps };
          }),
        };
      });
      return { scenarioId: scenario.id, name: scenario.name, fiscalYear: scenario.fiscalYear, currency: scenario.currency, unconvertedEntryCount: Number(foreignEntries[0]?.count ?? 0), months };
    }),
  });

export function registerBudgetCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(saveBudgetScenario(deps));
  registry.register(undoBudgetScenarioVersion(deps));
  registry.register(restoreBudgetScenarioVersion(deps));
  registry.register(listBudgetScenarios(deps));
  registry.register(budgetActualVsPlan(deps));
}
