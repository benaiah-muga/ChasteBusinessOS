/**
 * Reorder intelligence (M8, ADR 0034's deterministic core). Odoo-parity
 * orderpoint math, expressed over integer thousandths: average demand over
 * a look-back window, variability into safety stock via a service-level z,
 * and a suggested order quantity that never overshoots the target.
 *
 * Every function is pure and total on its documented domain; the AI layer
 * narrates these numbers and never computes them.
 */

export type ServiceLevel = "90" | "95" | "98" | "99";

/** One-sided z-multipliers for the supported service levels. */
export const SERVICE_LEVEL_Z: Record<ServiceLevel, number> = {
  "90": 1.2816,
  "95": 1.6449,
  "98": 2.0537,
  "99": 2.3263,
};

export function averageDailyDemand(totalOutboundThousandths: number, windowDays: number): number {
  if (!Number.isInteger(windowDays) || windowDays <= 0) throw new Error("window must be a positive integer of days");
  if (totalOutboundThousandths < 0) throw new Error("outbound cannot be negative");
  return Math.round(totalOutboundThousandths / windowDays);
}

export function demandOverHorizon(avgDailyThousandths: number, horizonDays: number): number {
  if (!Number.isInteger(horizonDays) || horizonDays < 0) throw new Error("horizon must be a non-negative integer of days");
  if (avgDailyThousandths < 0) throw new Error("demand cannot be negative");
  return Math.round(avgDailyThousandths * horizonDays);
}

/** Population standard deviation of one bucket per day (thousandths). */
export function stdDevDailyThousandths(dailyOutbound: number[]): number {
  if (dailyOutbound.length === 0) return 0;
  const mean = dailyOutbound.reduce((sum, v) => sum + v, 0) / dailyOutbound.length;
  const variance = dailyOutbound.reduce((sum, v) => sum + (v - mean) ** 2, 0) / dailyOutbound.length;
  return Math.sqrt(variance);
}

/** Buffer against demand variability over the replenishment lead time. */
export function safetyStockThousandths(
  stdDevDaily: number,
  leadTimeDays: number,
  level: ServiceLevel = "95",
): number {
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) throw new Error("lead time must be a non-negative integer of days");
  if (stdDevDaily < 0) throw new Error("deviation cannot be negative");
  return Math.round(SERVICE_LEVEL_Z[level] * stdDevDaily * Math.sqrt(leadTimeDays));
}

/** Expected demand across the lead time plus the safety buffer. */
export function reorderPointThousandths(
  avgDailyThousandths: number,
  leadTimeDays: number,
  safetyThousandths: number,
): number {
  if (safetyThousandths < 0) throw new Error("safety stock cannot be negative");
  return demandOverHorizon(avgDailyThousandths, leadTimeDays) + safetyThousandths;
}

/** Where an order should bring the position: reorder point plus review-cycle demand. */
export function targetStockThousandths(
  reorderPointThousandths: number,
  reviewDays: number,
  avgDailyThousandths: number,
): number {
  if (!Number.isInteger(reviewDays) || reviewDays < 0) throw new Error("review period must be a non-negative integer of days");
  return reorderPointThousandths + demandOverHorizon(avgDailyThousandths, reviewDays);
}

/** Never negative, never overshoots the target gap; idempotent by construction. */
export function suggestedOrderQtyThousandths(
  onHandThousandths: number,
  incomingThousandths: number,
  targetThousandths: number,
): number {
  return Math.max(0, targetThousandths - onHandThousandths - incomingThousandths);
}

/** Days the current stock lasts at this demand rate; null when there is no demand. */
export function daysOfCover(onHandThousandths: number, avgDailyThousandths: number): number | null {
  if (avgDailyThousandths <= 0) return null;
  return onHandThousandths / avgDailyThousandths;
}

// ── Governed reorder plan (M8.3) ─────────────────────────────────────────

export interface ReorderPlanItem {
  sku: string;
  name: string;
  onHandThousandths: number;
  incomingThousandths: number;
  targetThousandths: number;
  avgUnitCostMinor: number;
}

export interface ReorderPlanLine {
  sku: string;
  name: string;
  quantityThousandths: number;
  unitCostMinor: number;
}

export interface ReorderPlan {
  lines: ReorderPlanLine[];
  totalCostMinor: number;
}

/**
 * Composes the purchase proposal from per-item stock positions. Only items
 * with a positive gap appear; lines are sorted by SKU so the same stock
 * state always yields the same plan (stable for hashing into approvals).
 */
export function buildReorderPlan(itemsToPlan: ReorderPlanItem[]): ReorderPlan {
  const lines: ReorderPlanLine[] = itemsToPlan
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      quantityThousandths: suggestedOrderQtyThousandths(
        item.onHandThousandths,
        item.incomingThousandths,
        item.targetThousandths,
      ),
      unitCostMinor: item.avgUnitCostMinor,
    }))
    .filter((line) => line.quantityThousandths > 0)
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const totalCostMinor = lines.reduce(
    (sum, line) => sum + Math.round((line.quantityThousandths * line.unitCostMinor) / 1000),
    0,
  );
  return { lines, totalCostMinor };
}

