/**
 * Planning arithmetic on top of the BOM primitives (M11, ADR 0038).
 *
 * erp-core/bom.ts already answers availability for a FIXED quantity; this
 * adds the ceiling question — "how many COULD we produce?" — as a pure
 * floor over per-unit component ratios. Deterministic; the agent narrates
 * the arithmetic, never invents it.
 */

export interface PerUnitNeed {
  componentItemId: string;
  /** Per-unit requirement in thousandths (scrap already applied). */
  perUnitThousandths: number;
}

/**
 * Largest whole-unit quantity every component can support. Zero-need
 * components never constrain. Returns thousandths of a unit.
 */
export function maxProducibleUnits(
  perUnitNeeds: readonly PerUnitNeed[],
  stockByItemId: ReadonlyMap<string, number>,
): number {
  let ceiling = Number.POSITIVE_INFINITY;
  for (const need of perUnitNeeds) {
    if (need.perUnitThousandths <= 0) continue;
    const available = stockByItemId.get(need.componentItemId) ?? 0;
    const fromComponent = Math.floor((available / need.perUnitThousandths) * 1000);
    ceiling = Math.min(ceiling, Math.max(0, fromComponent));
  }
  return Number.isFinite(ceiling) ? ceiling : 0;
}
