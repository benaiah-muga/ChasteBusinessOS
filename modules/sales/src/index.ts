import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, invoices, salesOrderLines, salesOrders, stockReservations } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { computeInvoiceTotals, evaluateCredit } from "@chaste/erp-core";
import { insertInvoiceWithPosting } from "@chaste/module-accounting";
import { itemBySku, openReserved, recordStockMovement, stockOnHand } from "@chaste/module-inventory";

/**
 * Sales orders (M9, ADR 0036): the contract between sales and inventory.
 *
 * Confirming reserves stock through the existing reservation primitives;
 * delivery consumes the reservation, writes the outgoing stock leg through
 * the shared writer, and invoices what actually shipped via the shared
 * posting path — the same write path quotes and POS use. Backorders are a
 * flag on the order (partial reservation under allowBackorder), never a
 * document zoo.
 */

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

const lineInput = z.object({
  description: z.string().min(1),
  /** Thousandths, matching every other quantity in the system. */
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative().optional(),
  /** Stock-backed line when given; bare descriptions are service lines. */
  sku: z.string().optional(),
});

const orderNumber = async (tx: Tx, orgId: string) => {
  const [row] = await tx
    .select({ maxNum: sql<number>`coalesce(max(${salesOrders.number}), 0)` })
    .from(salesOrders)
    .where(eq(salesOrders.orgId, orgId));
  return Number(row?.maxNum ?? 0) + 1;
};

/** Open (unpaid) receivables for one customer — the credit guard's baseline. */
async function openArMinor(tx: Tx, orgId: string, customerId: string): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<number>`coalesce(sum(${invoices.totalMinor} - ${invoices.paidMinor}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.orgId, orgId),
        eq(invoices.customerId, customerId),
        eq(invoices.status, "sent"),
        sql`${invoices.voidedAt} IS NULL`,
      ),
    );
  return Number(row?.total ?? 0);
}

const orderCreate = (deps: ModuleDeps) =>
  defineCapability({
    id: "sales.createOrder",
    title: "Create sales order",
    intent:
      "Draft a sales order for a customer with priced lines so that confirming it later can reserve stock and ship without retyping anything",
    module: "sales",
    risk: "write",
    permission: "sales.write",
    input: z.object({
      customerId: z.string().uuid(),
      note: z.string().optional(),
      lines: z.array(lineInput).min(1),
    }),
    output: z.object({ orderId: z.string(), orderNumber: z.number() }),
    inverse: {
      capabilityId: "sales.cancelOrder",
      buildInput: (_input, output) => ({ orderId: (output as { orderId: string }).orderId }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [cust] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!cust) throw new Error("customer not found");

        const resolved = [] as Array<{
          itemId: string | null;
          description: string;
          quantity: number;
          unitPriceMinor: number;
          taxMinor: number;
        }>;
        for (const l of input.lines) {
          let itemId: string | null = null;
          if (l.sku) {
            const item = await itemBySku(tx, ctx.actor.orgId, l.sku);
            if (!item) throw new Error(`no item with sku ${l.sku}`);
            itemId = item.id;
          }
          resolved.push({
            itemId,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxMinor: l.taxMinor ?? 0,
          });
        }

        const number = await orderNumber(tx, ctx.actor.orgId);
        const [order] = await tx
          .insert(salesOrders)
          .values({
            orgId: ctx.actor.orgId,
            number,
            customerId: input.customerId,
            status: "draft",
            note: input.note ?? null,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: salesOrders.id });
        await tx.insert(salesOrderLines).values(
          resolved.map((l) => ({
            orgId: ctx.actor.orgId,
            orderId: order!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxMinor: l.taxMinor,
            itemId: l.itemId,
          })),
        );
        return { orderId: order!.id, orderNumber: number };
      });
    },
  });

const orderConfirm = (deps: ModuleDeps) =>
  defineCapability({
    id: "sales.confirmOrder",
    title: "Confirm sales order",
    intent:
      "Commit a draft sales order: check the customer's credit headroom, reserve stock for every stock-backed line, and flag backorders when supply falls short",
    module: "sales",
    risk: "write",
    permission: "sales.write",
    input: z.object({
      orderId: z.string().uuid(),
      /** Reserve what exists and flag the rest instead of refusing. */
      allowBackorder: z.boolean().optional(),
    }),
    output: z.object({
      confirmed: z.literal(true),
      backordered: z.boolean(),
      reservedThousandths: z.number().int(),
    }),
    inverse: {
      capabilityId: "sales.cancelOrder",
      buildInput: (input) => ({ orderId: (input as { orderId: string }).orderId }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(and(eq(salesOrders.id, input.orderId), eq(salesOrders.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!order) throw new Error("order not found");
        if (order.status !== "draft") throw new Error(`order is ${order.status}; only draft orders confirm`);

        const lines = await tx
          .select()
          .from(salesOrderLines)
          .where(eq(salesOrderLines.orderId, order.id))
          .orderBy(salesOrderLines.id);

        const totals = computeInvoiceTotals(
          lines.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, taxMinor: l.taxMinor })),
        );
        const [cust] = await tx
          .select({ creditLimitMinor: customers.creditLimitMinor })
          .from(customers)
          .where(eq(customers.id, order.customerId))
          .limit(1);
        const ar = await openArMinor(tx, ctx.actor.orgId, order.customerId);
        const credit = evaluateCredit(ar, totals.totalMinor, cust?.creditLimitMinor ?? null);
        if (credit.decision === "over") {
          throw new Error(
            `credit limit exceeded: open receivables ${ar} + this order ${totals.totalMinor} exceed the ${credit.creditLimitMinor} limit by ${-(credit.headroomMinor ?? 0)}; record a payment or raise the limit`,
          );
        }

        // Plan every reservation before writing any, so availability math
        // never sees our own partial claims.
        const plan: Array<{ line: (typeof lines)[number]; take: number }> = [];
        let reservedTotal = 0;
        let wantedTotal = 0;
        for (const line of lines) {
          if (!line.itemId) continue;
          wantedTotal += line.quantity;
          const available =
            (await stockOnHand(tx, ctx.actor.orgId, line.itemId)) - (await openReserved(tx, ctx.actor.orgId, line.itemId));
          const take = Math.max(0, Math.min(line.quantity, available));
          plan.push({ line, take });
          reservedTotal += take;
        }
        const backordered = reservedTotal < wantedTotal;
        if (backordered && !input.allowBackorder) {
          throw new Error(
            `insufficient stock: only ${reservedTotal} of ${wantedTotal} thousandths available; confirm with allowBackorder to take what exists, or wait for replenishment`,
          );
        }

        for (const { line, take } of plan) {
          if (take <= 0 || !line.itemId) continue;
          await tx.insert(stockReservations).values({
            orgId: ctx.actor.orgId,
            itemId: line.itemId,
            quantityThousandths: take,
            reason: `sales order #${order.number}`,
            refType: "sales_order",
            refId: order.id,
            status: "open",
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          });
          await tx
            .update(salesOrderLines)
            .set({ reservedThousandths: take })
            .where(eq(salesOrderLines.id, line.id));
        }
        await tx
          .update(salesOrders)
          .set({ status: "confirmed", confirmedAt: ctx.now, backordered })
          .where(eq(salesOrders.id, order.id));

        return { confirmed: true as const, backordered, reservedThousandths: reservedTotal };
      });
    },
  });

const orderDeliver = (deps: ModuleDeps) =>
  defineCapability({
    id: "sales.deliverOrder",
    title: "Deliver sales order",
    intent:
      "Ship all or part of a confirmed order: consume its reservations, write the outgoing stock legs, and raise an invoice for exactly what was delivered",
    // No inverse: delivery consumes real stock and posts real revenue. A
    // mistaken delivery unwinds through the invoice's credit/reversal path,
    // not by rewriting the shipment.
    module: "sales",
    risk: "write",
    permission: "sales.write",
    input: z.object({
      orderId: z.string().uuid(),
      /** Omit to deliver everything still reserved and undelivered. */
      lines: z
        .array(
          z.object({
            lineId: z.string().uuid(),
            quantityThousandths: z.number().int().positive(),
          }),
        )
        .optional(),
    }),
    output: z.object({
      invoiceId: z.string(),
      invoiceNumber: z.number(),
      invoiceTotalMinor: z.number(),
      orderStatus: z.string(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(and(eq(salesOrders.id, input.orderId), eq(salesOrders.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!order) throw new Error("order not found");
        if (order.status !== "confirmed" && order.status !== "delivered") {
          throw new Error(`order is ${order.status}; only confirmed orders deliver`);
        }

        const lines = await tx
          .select()
          .from(salesOrderLines)
          .where(eq(salesOrderLines.orderId, order.id))
          .orderBy(salesOrderLines.id);
        const byId = new Map(lines.map((l) => [l.id, l]));

        const requested =
          input.lines ??
          lines.filter((l) => l.itemId).map((l) => ({ lineId: l.id, quantityThousandths: Number.MAX_SAFE_INTEGER }));
        const invoiceLines: Array<{ description: string; quantity: number; unitPriceMinor: number; taxMinor: number }> = [];

        for (const req of requested) {
          const line = byId.get(req.lineId);
          if (!line) throw new Error(`line ${req.lineId} not on this order`);
          if (!line.itemId) throw new Error(`line "${line.description}" is a service line; deliver it outside inventory`);
          const undelivered = line.reservedThousandths - line.deliveredThousandths;
          if (undelivered <= 0) throw new Error(`line "${line.description}" has nothing left reserved and undelivered`);
          const deliver = req.quantityThousandths === Number.MAX_SAFE_INTEGER ? undelivered : req.quantityThousandths;
          if (deliver > undelivered) {
            throw new Error(
              `line "${line.description}" has only ${undelivered} thousandths reserved and undelivered; asked for ${deliver}`,
            );
          }

          // Consume this line's open reservations oldest-first.
          let remaining = deliver;
          const open = await tx
            .select()
            .from(stockReservations)
            .where(
              and(
                eq(stockReservations.orgId, ctx.actor.orgId),
                eq(stockReservations.itemId, line.itemId),
                eq(stockReservations.refType, "sales_order"),
                eq(stockReservations.refId, order.id),
                eq(stockReservations.status, "open"),
              ),
            )
            .orderBy(stockReservations.createdAt);
          for (const res of open) {
            if (remaining <= 0) break;
            const take = Math.min(remaining, res.quantityThousandths);
            if (take === res.quantityThousandths) {
              await tx.update(stockReservations).set({ status: "consumed" }).where(eq(stockReservations.id, res.id));
            } else {
              await tx
                .update(stockReservations)
                .set({ quantityThousandths: res.quantityThousandths - take })
                .where(eq(stockReservations.id, res.id));
            }
            remaining -= take;
          }
          if (remaining > 0) throw new Error(`reservation for line "${line.description}" vanished; refusing to oversell`);

          await recordStockMovement(tx, {
            orgId: ctx.actor.orgId,
            itemId: line.itemId!,
            quantityDelta: -deliver,
            reason: "sale",
            note: `sales order #${order.number}`,
            refType: "sales_order",
            refId: order.id,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
          await tx
            .update(salesOrderLines)
            .set({ deliveredThousandths: line.deliveredThousandths + deliver })
            .where(eq(salesOrderLines.id, line.id));

          invoiceLines.push({
            description: line.description,
            quantity: deliver,
            unitPriceMinor: line.unitPriceMinor,
            taxMinor: Math.round((line.taxMinor * deliver) / line.quantity),
          });
        }

        // Invoice-on-delivery through the one shared revenue write path
        // (same insert + GL posting as quote acceptance and POS).
        const created = await insertInvoiceWithPosting(tx, ctx, {
          customerId: order.customerId,
          memo: `Sales order #${order.number}`,
          lines: invoiceLines,
        });

        const fresh = await tx
          .select({ quantity: salesOrderLines.quantity, delivered: salesOrderLines.deliveredThousandths })
          .from(salesOrderLines)
          .where(eq(salesOrderLines.orderId, order.id));
        const fullyDelivered = fresh.every((l) => l.delivered >= l.quantity);
        const orderStatus = fullyDelivered ? "delivered" : "confirmed";
        await tx
          .update(salesOrders)
          .set({ status: orderStatus, backordered: fullyDelivered ? false : order.backordered })
          .where(eq(salesOrders.id, order.id));

        return {
          invoiceId: created.invoiceId,
          invoiceNumber: created.invoiceNumber,
          invoiceTotalMinor: created.totalMinor,
          orderStatus,
        };
      });
    },
  });

const orderCancel = (deps: ModuleDeps) =>
  defineCapability({
    id: "sales.cancelOrder",
    title: "Cancel sales order",
    intent:
      "Withdraw a draft or confirmed order before shipment, releasing every stock reservation it still holds so the quantity returns to available-to-promise",
    // No inverse: cancellation is itself the terminal unwind of create and
    // confirm. Reopening a cancelled order would orphan its released stock.
    module: "sales",
    risk: "write",
    permission: "sales.write",
    input: z.object({ orderId: z.string().uuid() }),
    output: z.object({ status: z.literal("cancelled"), releasedThousandths: z.number().int() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(and(eq(salesOrders.id, input.orderId), eq(salesOrders.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!order) throw new Error("order not found");
        if (order.status === "cancelled") throw new Error("order is already cancelled");
        if (order.status === "delivered") {
          throw new Error("order is fully delivered; unwind through invoice reversal instead");
        }

        if (order.status === "confirmed") {
          const [agg] = await tx
            .select({ delivered: sql<number>`coalesce(sum(${salesOrderLines.deliveredThousandths}), 0)` })
            .from(salesOrderLines)
            .where(eq(salesOrderLines.orderId, order.id));
          if (Number(agg?.delivered ?? 0) > 0) {
            throw new Error("order is partially delivered; unwind through invoice reversal instead");
          }
          const released = await tx
            .update(stockReservations)
            .set({ status: "released" })
            .where(
              and(
                eq(stockReservations.orgId, ctx.actor.orgId),
                eq(stockReservations.refType, "sales_order"),
                eq(stockReservations.refId, order.id),
                eq(stockReservations.status, "open"),
              ),
            )
            .returning({ quantityThousandths: stockReservations.quantityThousandths });
          await tx
            .update(salesOrders)
            .set({ status: "cancelled", cancelledAt: ctx.now, backordered: false })
            .where(eq(salesOrders.id, order.id));
          return {
            status: "cancelled" as const,
            releasedThousandths: released.reduce((sum, r) => sum + r.quantityThousandths, 0),
          };
        }

        await tx
          .update(salesOrders)
          .set({ status: "cancelled", cancelledAt: ctx.now })
          .where(eq(salesOrders.id, order.id));
        return { status: "cancelled" as const, releasedThousandths: 0 };
      });
    },
  });

const orderList = (deps: ModuleDeps) =>
  defineCapability({
    id: "sales.listOrders",
    title: "List sales orders",
    intent:
      "Show the organization's sales orders with status, backorder flags, and totals so the team can see what is committed, short, and ready to ship",
    module: "sales",
    risk: "read",
    permission: "sales.read",
    input: z.object({ status: z.enum(["draft", "confirmed", "delivered", "cancelled"]).optional() }),
    output: z.object({
      orders: z.array(
        z.object({
          id: z.string(),
          number: z.number(),
          customerId: z.string(),
          status: z.string(),
          backordered: z.boolean(),
          totalMinor: z.number(),
          createdAt: z.string(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .select()
          .from(salesOrders)
          .where(
            input.status
              ? and(eq(salesOrders.orgId, ctx.actor.orgId), eq(salesOrders.status, input.status))
              : eq(salesOrders.orgId, ctx.actor.orgId),
          )
          .orderBy(desc(salesOrders.number))
          .limit(200);
        const out = [] as Array<{
          id: string;
          number: number;
          customerId: string;
          status: string;
          backordered: boolean;
          totalMinor: number;
          createdAt: string;
        }>;
        for (const o of rows) {
          const lines = await tx
            .select({
              quantity: salesOrderLines.quantity,
              unitPriceMinor: salesOrderLines.unitPriceMinor,
              taxMinor: salesOrderLines.taxMinor,
            })
            .from(salesOrderLines)
            .where(eq(salesOrderLines.orderId, o.id));
          const total = lines.reduce((sum, l) => sum + Math.round((l.quantity * l.unitPriceMinor) / 1000) + l.taxMinor, 0);
          out.push({
            id: o.id,
            number: o.number,
            customerId: o.customerId,
            status: o.status,
            backordered: o.backordered,
            totalMinor: total,
            createdAt: o.createdAt.toISOString(),
          });
        }
        return { orders: out };
      });
    },
  });

export function registerSalesCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(orderCreate(deps));
  registry.register(orderConfirm(deps));
  registry.register(orderDeliver(deps));
  registry.register(orderCancel(deps));
  registry.register(orderList(deps));
}
