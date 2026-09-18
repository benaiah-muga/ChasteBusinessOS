import { NextResponse } from "next/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, poLines, purchaseOrders } from "@chaste/db";
import { buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * P01 — the calm "My work" home. One ranked list across approvals, receipt
 * remainders and module signals: each card says what changed, why it
 * matters, and carries one primary action. Deterministic ranking first;
 * AI never ranks, it may only summarize the authorized bundle (see
 * /api/my-work/summarize).
 */

export interface WorkCard {
  kind: "approval" | "receipt_remainder" | "signal";
  id: string;
  title: string;
  detail: string;
  whyItMatters: string;
  actionLabel: string;
  actionHref: string;
  createdAt: string | null;
  rank: number;
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const registry = buildRegistry(db);
  const cards: WorkCard[] = [];

  // 1. Pending approvals the viewer has authority to decide — oldest first.
  const { approvals } = await import("@chaste/db");
  const pending = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, resolved.orgId), eq(approvals.status, "pending")))
    .orderBy(asc(approvals.createdAt))
    .limit(20);
  for (const a of pending) {
    const cap = registry.get(a.capabilityId);
    if (!cap || !hasPermissionFor({ permissions: resolved.permissions }, cap.permission)) continue;
    cards.push({
      kind: "approval",
      id: a.id,
      title: `Approval needed: ${a.capabilityId}`,
      detail: a.rationale ?? `${a.riskClass} action waiting for a decision`,
      whyItMatters: "Someone or something asked for a gated action; nothing happens until a human decides.",
      actionLabel: "Review approval",
      actionHref: "/approvals",
      createdAt: a.createdAt.toISOString(),
      rank: 0,
    });
  }

  // 2. Partial purchase orders with undelivered lines — biggest remaining first.
  // Same-org role disclosure: PO numbers and line descriptions are only
  // shown to roles that may read purchasing, like every other surface.
  if (hasPermissionFor({ permissions: resolved.permissions }, "purchasing.read")) {
  const partialPos = await db
    .select({ id: purchaseOrders.id, number: purchaseOrders.number })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.orgId, resolved.orgId), eq(purchaseOrders.status, "partial")))
    .limit(20);
  if (partialPos.length > 0) {
    const poIds = partialPos.map((p) => p.id);
    // NOTE: the correlated id below is written as a literal po_lines.id.
    // Drizzle's sql template renders an embedded column as a bare "id",
    // which the subquery scope resolves to the INNER table's own id —
    // silently summing over an empty set (every remainder read full
    // outstanding). The outer table is unaliased, so the literal qualifies.
    const lines = await db
      .select({
        poId: poLines.poId,
        position: poLines.position,
        description: poLines.description,
        ordered: poLines.quantity,
        itemId: poLines.id,
        accepted: sql<number>`(
          SELECT coalesce(sum(g.accepted_thousandths), 0) FROM goods_receipt_lines g
          WHERE g.po_line_id = po_lines.id
        ) + (
          SELECT coalesce(sum(CASE WHEN m.quantity_delta > 0 THEN m.quantity_delta ELSE 0 END), 0)
          FROM stock_movements m
          WHERE m.ref_type = 'po_line' AND m.ref_id = po_lines.id
        )`,
        rejected: sql<number>`(
          SELECT coalesce(sum(g.rejected_thousandths), 0) FROM goods_receipt_lines g
          WHERE g.po_line_id = po_lines.id
        )`,
        // Delivered means accepted net of returns (returns draw from
        // concrete receipts and demote the order back to partial), so the
        // remainder must add returns back — otherwise a returned delivery
        // reads as fully received here while the domain says partial.
        returned: sql<number>`(
          SELECT coalesce(sum(g.returned_thousandths), 0) FROM goods_receipt_lines g
          WHERE g.po_line_id = po_lines.id
        ) + (
          SELECT coalesce(sum(CASE WHEN m.quantity_delta < 0 THEN -m.quantity_delta ELSE 0 END), 0)
          FROM stock_movements m
          WHERE m.ref_type = 'po_line' AND m.ref_id = po_lines.id
        )`,
      })
      .from(poLines)
      .where(inArray(poLines.poId, poIds));
    const numberById = new Map<string, number>(partialPos.map((p) => [p.id, p.number] as const));
    const remainingByPo = new Map<string, number>();
    for (const l of lines) {
      const remaining = l.ordered - Number(l.accepted) - Number(l.rejected) + Number(l.returned);
      if (remaining > 0) {
        remainingByPo.set(l.poId, (remainingByPo.get(l.poId) ?? 0) + remaining);
      }
    }
    const ordered = [...remainingByPo.entries()].sort((a, b) => b[1] - a[1]);
    for (const [poId, remaining] of ordered) {
      const number = numberById.get(poId)!;
      const poLinesLeft = lines.filter((l) => l.poId === poId && l.ordered - Number(l.accepted) - Number(l.rejected) + Number(l.returned) > 0);
      cards.push({
        kind: "receipt_remainder",
        id: poId,
        title: `PO ${number}: ${formatThousandths(remaining)} still outstanding`,
        detail: poLinesLeft.map((l) => `line ${l.position} "${l.description}"`).join(", "),
        whyItMatters: "The supplier has not delivered everything ordered; the shortfall is visible and can be chased or closed.",
        actionLabel: "Open receiving desk",
        actionHref: `/purchasing/receiving?poNumber=${number}`,
        createdAt: null,
        rank: 1,
      });
    }
  }
  }

  // 3. Module signals, red first (signals.list sorts; keep its order).
  if (hasPermissionFor({ permissions: resolved.permissions }, "signals.read")) {
    const executor = buildExecutor(db, registry);
    const unavailable = () => {
      // Coverage failure shows as unavailable, never as "zero problems".
      cards.push({
        kind: "signal",
        id: "signals-unavailable",
        title: "Signal checks unavailable",
        detail: "The signal sweep could not run right now; this is not a report of zero problems.",
        whyItMatters: "Coverage must be honest: an unavailable check is visible instead of silently passing.",
        actionLabel: "Retry later",
        actionHref: "/",
        createdAt: null,
        rank: 3,
      });
    };
    try {
      const result = await executor.execute("signals.list", { actor: { type: "human", id: resolved.userId, orgId: resolved.orgId, permissions: resolved.permissions }, now: new Date(), services: {} }, {});
      if (result.ok && result.data) {
        const list = ((result.data as { signals?: Array<{ id: string; severity: string; module: string; subject: string; detail: string }> }).signals) ?? [];
        for (const s of list) {
          cards.push({
            kind: "signal",
            id: s.id,
            title: `${s.module}: ${s.subject}`,
            detail: s.detail,
            whyItMatters: "A module check flagged this condition; it stays visible until the underlying state changes.",
            actionLabel: "Open module",
            actionHref: `/${s.module}`,
            createdAt: null,
            rank: 2,
          });
        }
      } else {
        // A returned failure (refusal, unknown outcome) is still a coverage
        // failure — a silent empty list would read as zero problems.
        unavailable();
      }
    } catch {
      unavailable();
    }
  }

  // Deterministic rank groups (approvals, then remainders, then signals);
  // within a group the insertion order stands — signals.list already sorts
  // red first, and Array.sort is stable.
  cards.sort((a, b) => a.rank - b.rank);
  return NextResponse.json({ cards: cards.slice(0, 30), generatedAt: new Date().toISOString() });
}

/** Pilot-facing quantities read in units, not ledger thousandths. */
function formatThousandths(thousandths: number): string {
  const units = thousandths / 1000;
  return `${Number.isInteger(units) ? units.toString() : units.toFixed(3).replace(/0+$/, "")} units`;
}
