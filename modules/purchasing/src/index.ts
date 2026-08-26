import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  items,
  poLines,
  purchaseOrders,
  purchaseRequests,
  rfqs,
  stockMovements,
  vendorBillLines,
  vendorBills,
  vendorPayments,
  vendors,
} from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import {
  computeAging,
  computeInvoiceTotals,
  matchThreeWay,
} from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { assertPeriodOpen, postEntry } from "@chaste/module-accounting/posting";

export interface ModuleDeps {
  db: Database["db"];
}


const createVendor = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createVendor",
    title: "Create vendor",
    intent: "Register a supplier so bills can be recorded against them",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({ name: z.string().min(1), email: z.string().email().optional() }),
    output: z.object({ vendorId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(vendors)
        .values({ orgId: ctx.actor.orgId, name: input.name, email: input.email ?? null })
        .returning({ id: vendors.id });
      return { vendorId: row!.id };
    },
  });

const billLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().describe("thousandths of a unit"),
  unitPriceMinor: z.number().int().nonnegative(),
  expenseAccountCode: z
    .string()
    .regex(/^\d{4}$/)
    .default("6000")
    .describe("chart-of-accounts code the cost lands on, e.g. 5000 for COGS"),
});

/**
 * Posting rule for bills: DR each line's expense account, CR Accounts Payable.
 * The AP credit is what makes the vendor a creditor until paid.
 */
const createBill = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createBill",
    title: "Record vendor bill",
    intent:
      "Record an invoice received from a supplier; posts the expense and the amount owed to Accounts Payable",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId?: string }).entryId ?? "" }),
    },
    input: z.object({
      vendorId: z.string(),
      vendorRef: z.string().optional(),
      memo: z.string().optional(),
      /** When present, every line is matched against this order before posting. */
      poNumber: z.number().int().positive().optional(),
      lines: z
        .array(
          billLineSchema.extend({
            poLineNumber: z.number().int().positive().optional(),
          }),
        )
        .min(1),
    }),
    output: z.object({ billNumber: z.number(), totalMinor: z.number(), entryId: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);

        // Three-way match when the bill references an order: order ↔ receipts ↔ bill.
        if (input.poNumber !== undefined) {
          const [po] = await tx
            .select()
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
            .limit(1);
          if (!po) throw new Error(`purchase order ${input.poNumber} not found`);
          const poLineRows = await tx.select().from(poLines).where(eq(poLines.poId, po.id)).orderBy(poLines.id);
          for (const bl of input.lines) {
            if (!bl.poLineNumber) {
              throw new Error(`line "${bl.description}" must reference a purchase-order line number`);
            }
            const pol = poLineRows[bl.poLineNumber - 1];
            if (!pol) throw new Error(`no line ${bl.poLineNumber} on order ${input.poNumber}`);
            const [rec] = await tx
              .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
              .from(stockMovements)
              .where(and(eq(stockMovements.refType, "po_line"), eq(stockMovements.refId, pol.id)));
            const [prev] = await tx
              .select({ total: sql<number>`coalesce(sum(${vendorBillLines.quantity}), 0)` })
              .from(vendorBillLines)
              .where(eq(vendorBillLines.poLineId, pol.id));
            // quantities still available on this line after earlier bills
            const priorBilled = Number(prev?.total ?? 0);
            const violations = matchThreeWay({
              orderedQty: pol.quantity - priorBilled,
              receivedQty: Number(rec?.total ?? 0) - priorBilled,
              billedQty: bl.quantity,
              poUnitPriceMinor: pol.unitPriceMinor,
              billUnitPriceMinor: bl.unitPriceMinor,
            });
            if (violations.length > 0) {
              throw new Error(
                `three-way match failed on line ${bl.poLineNumber} (${bl.description}): ` +
                  violations.map((v) => `${v.kind} (${v.detail})`).join("; "),
              );
            }
          }
        }

        const [vendor] = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, input.vendorId), eq(vendors.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!vendor) throw new Error("vendor not found");

        const totals = computeInvoiceTotals(
          input.lines.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, taxMinor: 0 })),
        );

        const [numRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${vendorBills.number}), 0)` })
          .from(vendorBills)
          .where(eq(vendorBills.orgId, ctx.actor.orgId));
        const billNumber = Number(numRow?.maxNum ?? 0) + 1;

        let poLineRowsForLink = new Map<string, string>();
        if (input.poNumber !== undefined) {
          const [poRow] = await tx
            .select({ id: purchaseOrders.id })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
            .limit(1);
          const rows = await tx.select().from(poLines).where(eq(poLines.poId, poRow!.id)).orderBy(poLines.id);
          poLineRowsForLink = new Map(rows.map((r, i) => [`${input.poNumber}:${i + 1}`, r.id]));
        }

        const glLines = [
          ...input.lines.map((l) => ({
            accountCode: l.expenseAccountCode,
            debitMinor: Math.round((l.quantity * l.unitPriceMinor) / 1000),
            creditMinor: 0,
          })),
          { accountCode: "2000", debitMinor: 0, creditMinor: totals.totalMinor },
        ].filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Vendor bill ${billNumber}${input.vendorRef ? ` (${input.vendorRef})` : ""}`,
          sourceType: "vendor_bill",
          lines: glLines,
        });

        const [bill] = await tx
          .insert(vendorBills)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: input.vendorId,
            number: billNumber,
            vendorRef: input.vendorRef ?? null,
            status: "open",
            totalMinor: totals.totalMinor,
            memo: input.memo ?? null,
            entryId,
            billDate: ctx.now,
          })
          .returning({ id: vendorBills.id });

        await tx.insert(vendorBillLines).values(
          input.lines.map((l) => ({
            billId: bill!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            expenseAccountCode: l.expenseAccountCode,
            poLineId:
              input.poNumber !== undefined && l.poLineNumber
                ? (poLineRowsForLink.get(`${input.poNumber}:${l.poLineNumber}`) ?? null)
                : null,
          })),
        );

        return { billNumber, totalMinor: totals.totalMinor, entryId };
      });
    },
  });

/** Posting rule: DR Accounts Payable, CR Cash. Money class → threshold-gated. */
const payBill = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.payBill",
    title: "Pay vendor bill",
    intent:
      "Pay money to a supplier against an outstanding bill and post it to the ledger. Amounts above the policy threshold require approval",
    module: "purchasing",
    risk: "money",
    permission: "purchasing.post",
    moneyThresholdMinor: 50_000,
    moneyAmount: (input) => input.amountMinor,
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId: string }).entryId }),
    },
    input: z.object({
      billNumber: z.number().int().positive(),
      amountMinor: z.number().int().positive(),
      method: z.enum(["cash", "bank_transfer", "card"]).default("bank_transfer"),
    }),
    output: z.object({ paymentId: z.string(), entryId: z.string(), fullyPaid: z.boolean() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const [bill] = await tx
          .select()
          .from(vendorBills)
          .where(and(eq(vendorBills.orgId, ctx.actor.orgId), eq(vendorBills.number, input.billNumber)))
          .limit(1);
        if (!bill) throw new Error("bill not found");
        if (bill.status === "void") throw new Error("bill is void");
        if (bill.paidMinor + input.amountMinor > bill.totalMinor) {
          throw new Error(`overpayment: outstanding is ${bill.totalMinor - bill.paidMinor}`);
        }

        const glLines = [
          { accountCode: "2000", debitMinor: input.amountMinor, creditMinor: 0 },
          { accountCode: "1000", debitMinor: 0, creditMinor: input.amountMinor },
        ];
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Vendor payment for bill ${bill.number} (${input.method})`,
          sourceType: "vendor_payment",
          lines: glLines,
        });

        const [pay] = await tx
          .insert(vendorPayments)
          .values({
            orgId: ctx.actor.orgId,
            billId: bill.id,
            amountMinor: input.amountMinor,
            method: input.method,
            entryId,
          })
          .returning({ id: vendorPayments.id });

        const paidMinor = bill.paidMinor + input.amountMinor;
        await tx
          .update(vendorBills)
          .set({ paidMinor, status: paidMinor >= bill.totalMinor ? "paid" : bill.status })
          .where(eq(vendorBills.id, bill.id));

        return { paymentId: pay!.id, entryId, fullyPaid: paidMinor >= bill.totalMinor };
      });
    },
  });

const apAging = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.apAging",
    title: "AP aging report",
    intent: "Show outstanding vendor bills bucketed by age so you know what you owe and when",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({}),
    output: z.object({
      buckets: z.object({
        current: z.number(),
        d30: z.number(),
        d60: z.number(),
        d90plus: z.number(),
        totalOutstanding: z.number(),
      }),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({ totalMinor: vendorBills.totalMinor, paidMinor: vendorBills.paidMinor, billDate: vendorBills.billDate })
        .from(vendorBills)
        .where(and(eq(vendorBills.orgId, ctx.actor.orgId), gt(vendorBills.totalMinor, vendorBills.paidMinor)));
      const buckets = computeAging(
        rows
          .filter((r) => r.billDate !== null && r.totalMinor - r.paidMinor > 0)
          .map((r) => ({
            invoiceNumber: 0,
            outstandingMinor: r.totalMinor - r.paidMinor,
            issuedAt: r.billDate as Date,
          })),
        ctx.now,
      );
      return { buckets };
    },
  });

const createPO = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createPurchaseOrder",
    title: "Create purchase order",
    intent:
      "Order goods from a vendor with line items and expected prices; receiving and billing are matched against this order later",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      vendorId: z.string(),
      memo: z.string().optional(),
      lines: z
        .array(
          z.object({
            description: z.string().min(1),
            quantity: z.number().int().positive().describe("thousandths of a unit"),
            unitPriceMinor: z.number().int().nonnegative(),
            sku: z.string().optional().describe("links the line to a stocked item for receipts"),
          }),
        )
        .min(1),
    }),
    output: z.object({ poNumber: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [vendor] = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, input.vendorId), eq(vendors.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!vendor) throw new Error("vendor not found");

        const [numRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${purchaseOrders.number}), 0)` })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.orgId, ctx.actor.orgId));
        const poNumber = Number(numRow?.maxNum ?? 0) + 1;

        const itemSkus = input.lines.filter((l) => l.sku).map((l) => l.sku!);
        const itemMap = new Map<string, string>();
        if (itemSkus.length > 0) {
          const rows = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
          for (const r of rows) itemMap.set(r.sku, r.id);
        }

        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: input.vendorId,
            number: poNumber,
            status: "ordered",
            memo: input.memo ?? null,
            orderedAt: ctx.now,
          })
          .returning({ id: purchaseOrders.id });
        await tx.insert(poLines).values(
          input.lines.map((l) => ({
            poId: po!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            itemId: l.sku ? (itemMap.get(l.sku) ?? null) : null,
          })),
        );
        return { poNumber };
      });
    },
  });

const receivePO = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.receiveGoods",
    title: "Receive goods against purchase order",
    intent:
      "Record that ordered goods physically arrived; adds received quantities to stock for linked items and updates the order status. Receipts feed three-way matching on bills",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      poNumber: z.number().int().positive(),
      lines: z
        .array(
          z.object({
            lineNumber: z.number().int().positive().describe("1-based position on the order"),
            quantity: z.number().int().positive(),
          }),
        )
        .min(1),
    }),
    output: z.object({ received: z.boolean(), fullyReceived: z.boolean() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
          .limit(1);
        if (!po) throw new Error("purchase order not found");
        if (po.status === "void" || po.status === "closed") throw new Error(`order is ${po.status}`);

        const lines = await tx.select().from(poLines).where(eq(poLines.poId, po.id)).orderBy(poLines.id);

        for (const rl of input.lines) {
          const line = lines[rl.lineNumber - 1];
          if (!line) throw new Error(`no line ${rl.lineNumber} on order ${input.poNumber}`);
          if (line.itemId) {
            await tx.insert(stockMovements).values({
              orgId: ctx.actor.orgId,
              itemId: line.itemId,
              quantityDelta: rl.quantity,
              reason: "purchase",
              refType: "po_line",
              refId: line.id,
              note: `Receipt against PO ${input.poNumber}`,
              unitCostMinor: line.unitPriceMinor,
              actorType: ctx.actor.type,
              actorId: ctx.actor.id,
            });
          }
        }

        // status: partial until every line's received qty reaches ordered qty
        let fully = true;
        for (const line of lines) {
          const [rec] = await tx
            .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
            .from(stockMovements)
            .where(and(eq(stockMovements.refType, "po_line"), eq(stockMovements.refId, line.id)));
          if (Number(rec?.total ?? 0) < line.quantity) fully = false;
        }
        await tx
          .update(purchaseOrders)
          .set({ status: fully ? "received" : "partial" })
          .where(eq(purchaseOrders.id, po.id));
        return { received: true, fullyReceived: fully };
      });
    },
  });

// ── Purchasing workflow: request → review → RFQ → quotes → award ───────

const createPurchaseRequest = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createPurchaseRequest",
    title: "Create purchase request",
    intent:
      "Raise an internal purchase request for review and approval before anything is ordered; the first step of the procure-to-pay workflow",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      title: z.string().min(3).max(200),
      justification: z.string().min(10).max(4000),
      estimatedAmountMinor: z.number().int().nonnegative().optional(),
    }),
    output: z.object({ requestId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(purchaseRequests)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          justification: input.justification,
          estimatedAmountMinor: input.estimatedAmountMinor ?? null,
          requestedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
        })
        .returning({ id: purchaseRequests.id });
      return { requestId: row!.id };
    },
  });

const decidePurchaseRequest = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.decidePurchaseRequest",
    title: "Approve or reject purchase request",
    intent:
      "Record a reviewer's approve or reject decision on a pending purchase request; only approved requests may go out as RFQs",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      requestId: z.string(),
      decision: z.enum(["approve", "reject"]),
      reason: z.string().max(1000).optional(),
    }),
    output: z.object({ status: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [req] = await tx
          .select({ id: purchaseRequests.id, status: purchaseRequests.status })
          .from(purchaseRequests)
          .where(and(eq(purchaseRequests.id, input.requestId), eq(purchaseRequests.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!req) throw new Error("purchase request not found");
        if (req.status !== "pending_review") throw new Error(`request is already ${req.status}`);
        const status = input.decision === "approve" ? "approved" : "rejected";
        await tx
          .update(purchaseRequests)
          .set({
            status,
            decidedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
            decisionReason: input.reason ?? null,
            decidedAt: ctx.now,
          })
          .where(eq(purchaseRequests.id, req.id));
        return { status };
      });
    },
  });

const createRfq = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createRfq",
    title: "Send RFQ to vendors",
    intent:
      "Request competitive quotes from one or more vendors for an approved purchase request, creating one tracked RFQ per vendor",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      requestId: z.string(),
      vendorIds: z.array(z.string()).min(1).max(10),
    }),
    output: z.object({ rfqIds: z.array(z.string()) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [req] = await tx
          .select({ id: purchaseRequests.id, status: purchaseRequests.status })
          .from(purchaseRequests)
          .where(and(eq(purchaseRequests.id, input.requestId), eq(purchaseRequests.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!req) throw new Error("purchase request not found");
        if (req.status !== "approved") throw new Error("only approved requests can go out as RFQs");

        const vendorRows = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.orgId, ctx.actor.orgId));
        const known = new Set(vendorRows.map((v) => v.id));
        const unknown = input.vendorIds.filter((v) => !known.has(v));
        if (unknown.length > 0) throw new Error("unknown vendor id(s)");

        const rows = await tx
          .insert(rfqs)
          .values(input.vendorIds.map((vendorId) => ({ orgId: ctx.actor.orgId, requestId: req.id, vendorId })))
          .returning({ id: rfqs.id });
        return { rfqIds: rows.map((r) => r.id) };
      });
    },
  });

const recordQuote = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.recordQuote",
    title: "Record a vendor quote",
    intent:
      "Log a vendor's quote (amount, lead time, notes) against an open RFQ so bids can be compared and a winner selected",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      rfqId: z.string(),
      amountMinor: z.number().int().positive(),
      leadTimeDays: z.number().int().nonnegative().optional(),
      notes: z.string().max(2000).optional(),
    }),
    output: z.object({ status: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [rfq] = await tx
          .select({ id: rfqs.id, status: rfqs.status })
          .from(rfqs)
          .where(and(eq(rfqs.id, input.rfqId), eq(rfqs.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!rfq) throw new Error("RFQ not found");
        if (rfq.status === "won" || rfq.status === "lost") throw new Error("this RFQ is already decided");
        await tx
          .update(rfqs)
          .set({
            status: "quoted",
            quoteAmountMinor: input.amountMinor,
            quoteLeadTimeDays: input.leadTimeDays ?? null,
            quoteNotes: input.notes ?? null,
            quotedAt: ctx.now,
          })
          .where(eq(rfqs.id, rfq.id));
        return { status: "quoted" };
      });
    },
  });

const selectWinningQuote = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.selectWinningQuote",
    title: "Select winning quote and raise PO",
    intent:
      "Award an approved request to a vendor's quoted price: marks that RFQ won, its siblings lost, and raises the purchase order so receiving and billing can proceed",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({ rfqId: z.string() }),
    output: z.object({ poNumber: z.number(), vendorId: z.string(), quoteAmountMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [winner] = await tx
          .select()
          .from(rfqs)
          .where(and(eq(rfqs.id, input.rfqId), eq(rfqs.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!winner) throw new Error("RFQ not found");
        if (winner.status !== "quoted") throw new Error("record this vendor's quote before awarding");
        const [req] = await tx
          .select({ status: purchaseRequests.status, title: purchaseRequests.title })
          .from(purchaseRequests)
          .where(and(eq(purchaseRequests.id, winner.requestId), eq(purchaseRequests.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!req) throw new Error("purchase request not found");
        if (req.status !== "approved") throw new Error("request is no longer approvable into an order");

        // Sibling bids lose; the winner converts into a purchase order.
        await tx.update(rfqs).set({ status: "lost" }).where(
          and(eq(rfqs.requestId, winner.requestId), eq(rfqs.orgId, ctx.actor.orgId)),
        );
        await tx.update(rfqs).set({ status: "won" }).where(eq(rfqs.id, winner.id));

        const [numRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${purchaseOrders.number}), 0)` })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.orgId, ctx.actor.orgId));
        const poNumber = Number(numRow?.maxNum ?? 0) + 1;
        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: winner.vendorId,
            number: poNumber,
            status: "ordered",
            memo: `From RFQ award · ${req.title}`,
            orderedAt: ctx.now,
          })
          .returning({ id: purchaseOrders.id });
        await tx.insert(poLines).values({
          poId: po!.id,
          description: req.title,
          quantity: 1000,
          unitPriceMinor: winner.quoteAmountMinor ?? 0,
        });

        await tx
          .update(purchaseRequests)
          .set({ status: "converted", decidedAt: ctx.now })
          .where(eq(purchaseRequests.id, winner.requestId));
        return { poNumber, vendorId: winner.vendorId, quoteAmountMinor: winner.quoteAmountMinor ?? 0 };
      });
    },
  });

const listPurchaseWorkflow = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.listPurchaseWorkflow",
    title: "List purchase requests and RFQs",
    intent:
      "List recent internal purchase requests with their approval state and every RFQ bid on them, so you can review, chase quotes, or award a winner",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({}),
    output: z.object({
      requests: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          justification: z.string(),
          estimatedAmountMinor: z.number().nullable(),
          status: z.string(),
          createdAt: z.string(),
          rfqs: z.array(
            z.object({
              id: z.string(),
              vendorId: z.string(),
              status: z.string(),
              quoteAmountMinor: z.number().nullable(),
              quoteLeadTimeDays: z.number().nullable(),
            }),
          ),
        }),
      ),
    }),
    execute: async (ctx) => {
      const reqRows = await deps.db
        .select()
        .from(purchaseRequests)
        .where(eq(purchaseRequests.orgId, ctx.actor.orgId))
        .orderBy(desc(purchaseRequests.createdAt))
        .limit(50);
      const rfqRows = reqRows.length
        ? await deps.db.select().from(rfqs).where(eq(rfqs.orgId, ctx.actor.orgId))
        : [];
      return {
        requests: reqRows.map((r) => ({
          id: r.id,
          title: r.title,
          justification: r.justification,
          estimatedAmountMinor: r.estimatedAmountMinor,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          rfqs: rfqRows
            .filter((f) => f.requestId === r.id)
            .map((f) => ({
              id: f.id,
              vendorId: f.vendorId,
              status: f.status,
              quoteAmountMinor: f.quoteAmountMinor,
              quoteLeadTimeDays: f.quoteLeadTimeDays,
            })),
        })),
      };
    },
  });

export function registerPurchasingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createVendor(deps));
  registry.register(createPO(deps));
  registry.register(receivePO(deps));
  registry.register(createBill(deps));
  registry.register(payBill(deps));
  registry.register(apAging(deps));
  registry.register(createPurchaseRequest(deps));
  registry.register(decidePurchaseRequest(deps));
  registry.register(createRfq(deps));
  registry.register(recordQuote(deps));
  registry.register(selectWinningQuote(deps));
  registry.register(listPurchaseWorkflow(deps));
}
