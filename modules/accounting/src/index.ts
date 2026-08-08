import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { defineCommand, defineQuery, type BusinessModule, ValidationError } from "@chaste/kernel";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

const accountSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  isActive: z.boolean(),
});

const invoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  customerId: z.string().nullable().optional(),
  createdAt: z.string(),
});

export function createAccountingModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "accounting",
      name: "Accounting",
      version: "0.1.0",
      description: "General ledger, journals, invoices",
      dependencies: [],
      permissions: [
        "acc.account.manage",
        "acc.account.read",
        "acc.journal.post",
        "acc.invoice.manage",
        "acc.invoice.read",
      ],
      capabilities: ["acc.ledger", "acc.invoices"],
      specialist: {
        id: "accounting",
        displayName: "Accounting Agent",
        description: "Ledger, invoices, financial postings",
        toolTags: ["accounting"],
      },
    },
    register({ commands, queries }) {
      queries.register(
        defineQuery({
          name: "acc.account.list",
          permissions: ["acc.account.read"],
          tags: ["accounting"],
          input: z.object({}).default({}),
          output: z.object({ items: z.array(accountSchema) }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select()
              .from(schema.accAccounts)
              .where(eq(schema.accAccounts.organizationId, ctx.actor.organizationId));
            return {
              items: rows.map((r) => ({
                id: r.id,
                code: r.code,
                name: r.name,
                type: r.type,
                isActive: r.isActive,
              })),
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "acc.account.create",
          permissions: ["acc.account.manage"],
          tags: ["accounting"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            code: z.string().min(1).max(32),
            name: z.string().min(1),
            type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
          }),
          output: accountSchema,
          handler: async (input, ctx) => {
            const [row] = await db
              .insert(schema.accAccounts)
              .values({
                organizationId: ctx.actor.organizationId,
                code: input.code,
                name: input.name,
                type: input.type,
              })
              .returning();
            return {
              id: row!.id,
              code: row!.code,
              name: row!.name,
              type: row!.type,
              isActive: row!.isActive,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "acc.journal.post",
          permissions: ["acc.journal.post"],
          tags: ["accounting"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            reference: z.string().min(1),
            memo: z.string().optional(),
            lines: z
              .array(
                z.object({
                  accountId: z.string().uuid(),
                  debit: z.number().nonnegative().default(0),
                  credit: z.number().nonnegative().default(0),
                }),
              )
              .min(2),
          }),
          output: z.object({ id: z.string(), reference: z.string(), status: z.string() }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const totalDebit = input.lines.reduce((s, l) => s + l.debit, 0);
            const totalCredit = input.lines.reduce((s, l) => s + l.credit, 0);
            if (Math.abs(totalDebit - totalCredit) > 0.001) {
              throw new ValidationError("Journal entry must balance (debits = credits)", {
                totalDebit,
                totalCredit,
              });
            }
            const [entry] = await tx
              .insert(schema.accJournalEntries)
              .values({
                organizationId: ctx.actor.organizationId,
                reference: input.reference,
                memo: input.memo,
                status: "posted",
              })
              .returning();
            for (const line of input.lines) {
              await tx.insert(schema.accJournalLines).values({
                entryId: entry!.id,
                accountId: line.accountId,
                debit: line.debit.toFixed(2),
                credit: line.credit.toFixed(2),
              });
            }
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "acc.journal.posted",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { entryId: entry!.id, reference: entry!.reference },
              correlationId: ctx.requestId,
            });
            return { id: entry!.id, reference: entry!.reference, status: entry!.status };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "acc.invoice.create",
          permissions: ["acc.invoice.manage"],
          tags: ["accounting"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            number: z.string().min(1),
            customerId: z.string().uuid().optional(),
            currency: z.string().default("USD"),
            total: z.number().nonnegative(),
          }),
          output: invoiceSchema,
          handler: async (input, ctx, helpers) => {
            const [row] = await db
              .insert(schema.accInvoices)
              .values({
                organizationId: ctx.actor.organizationId,
                number: input.number,
                customerId: input.customerId,
                currency: input.currency,
                total: input.total.toFixed(2),
                status: "draft",
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "acc.invoice.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { invoiceId: row!.id, number: row!.number },
              correlationId: ctx.requestId,
            });
            return {
              id: row!.id,
              number: row!.number,
              status: row!.status,
              currency: row!.currency,
              total: row!.total,
              customerId: row!.customerId,
              createdAt: row!.createdAt.toISOString(),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "acc.invoice.list",
          permissions: ["acc.invoice.read"],
          tags: ["accounting"],
          input: z.object({}).default({}),
          output: z.object({ items: z.array(invoiceSchema) }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select()
              .from(schema.accInvoices)
              .where(eq(schema.accInvoices.organizationId, ctx.actor.organizationId))
              .orderBy(desc(schema.accInvoices.createdAt));
            return {
              items: rows.map((r) => ({
                id: r.id,
                number: r.number,
                status: r.status,
                currency: r.currency,
                total: r.total,
                customerId: r.customerId,
                createdAt: r.createdAt.toISOString(),
              })),
            };
          },
        }),
      );
    },
  };
}
