/**
 * BOM-lite: a bill of materials is a flat list of components per assembly
 * item. Production explodes the tree into component requirements, refusing
 * cycles (an assembly containing itself is a config error, not deep math).
 * Quantities are thousandths of a unit throughout.
 */

export interface BomEdge {
  /** The assembled item. */
  assemblyItemId: string;
  componentItemId: string;
  quantityThousandths: number;
}

export interface ComponentRequirement {
  itemId: string;
  quantityThousandths: number;
}

export class BomCycleError extends Error {}

/**
 * Explodes an assembly into leaf-level component requirements. Sub-assemblies
 * are recursively expanded; shared components aggregate. Pure.
 */
export function explodeBom(
  edges: readonly BomEdge[],
  assemblyItemId: string,
  quantityThousandths: number,
  opts: { maxDepth?: number } = {},
): ComponentRequirement[] {
  const byAssembly = new Map<string, BomEdge[]>();
  for (const e of edges) {
    const list = byAssembly.get(e.assemblyItemId) ?? [];
    list.push(e);
    byAssembly.set(e.assemblyItemId, list);
  }

  const totals = new Map<string, number>();
  // Path set catches cycles even when the same sub-assembly appears legally
  // under two different parents.
  const walk = (itemId: string, qty: number, depth: number, path: ReadonlySet<string>): void => {
    if (depth > (opts.maxDepth ?? 16)) throw new BomCycleError(`BOM deeper than ${opts.maxDepth ?? 16} levels`);
    if (path.has(itemId)) throw new BomCycleError("bill of materials contains a cycle");
    const children = byAssembly.get(itemId);
    if (!children || children.length === 0) {
      totals.set(itemId, (totals.get(itemId) ?? 0) + qty);
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(itemId);
    for (const child of children) {
      if (child.quantityThousandths <= 0) continue;
      walk(child.componentItemId, Math.round((child.quantityThousandths * qty) / 1000), depth + 1, nextPath);
    }
  };

  walk(assemblyItemId, quantityThousandths, 0, new Set());
  return [...totals.entries()]
    .map(([itemId, q]) => ({ itemId, quantityThousandths: q }))
    .filter((r) => r.quantityThousandths > 0)
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export interface AvailabilityLine extends ComponentRequirement {
  onHandThousandths: number;
  shortfallThousandths: number;
}

/** What can be checked before any ledger movement happens. Pure. */
export function checkAvailability(
  requirements: readonly ComponentRequirement[],
  onHandByItem: ReadonlyMap<string, number>,
): { producible: boolean; lines: AvailabilityLine[]; totalShortfallThousandths: number } {
  let producible = true;
  let totalShortfall = 0;
  const lines = requirements.map((r) => {
    const onHand = onHandByItem.get(r.itemId) ?? 0;
    const shortfall = Math.max(0, r.quantityThousandths - onHand);
    if (shortfall > 0) {
      producible = false;
      totalShortfall += shortfall;
    }
    return { ...r, onHandThousandths: onHand, shortfallThousandths: shortfall };
  });
  return { producible, lines, totalShortfallThousandths: totalShortfall };
}
