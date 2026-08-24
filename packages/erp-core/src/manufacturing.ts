/**
 * Manufacturing planning math that sits on top of BOM-lite: scrap/yield
 * scaling, available-to-promise, production cost previews, cycle-count
 * variances, and lot traceability trees. Everything here is pure so the
 * financial-relevant invariants are property-testable without a database.
 */

import type { ComponentRequirement } from "./bom";

/** Percentages are stored as thousandths of a percent: 5% = 5_000. */
export const PCT_SCALE = 1_000_000;

/**
 * Scales one requirement up by a scrap allowance and rounds up — you can
 * consume half a part, so shortfall math must always err on the safe side.
 */
export function applyScrap(quantityThousandths: number, scrapPctThousandths: number): number {
  if (quantityThousandths <= 0) return 0;
  if (scrapPctThousandths <= 0) return quantityThousandths;
  return Math.ceil((quantityThousandths * (PCT_SCALE + scrapPctThousandths)) / PCT_SCALE);
}

/** Per-item scrap allowances keyed by itemId (missing = no scrap). */
export type ScrapByItem = ReadonlyMap<string, number>;

/** Applies every item's scrap allowance to an exploded requirement list. */
export function requirementsWithScrap(
  requirements: readonly ComponentRequirement[],
  scrapByItem: ScrapByItem,
): ComponentRequirement[] {
  return requirements.map((r) => ({
    ...r,
    quantityThousandths: applyScrap(r.quantityThousandths, scrapByItem.get(r.itemId) ?? 0),
  }));
}

/**
 * Good output expected from a planned run at a yield percentage. Rounded
 * down: promising more good units than the process reliably yields is the
 * direction that hurts downstream promises.
 */
export function plannedGoodQuantity(
  plannedThousandths: number,
  yieldPctThousandths: number,
): number {
  if (plannedThousandths <= 0) return 0;
  const y = Math.min(Math.max(yieldPctThousandths, 0), PCT_SCALE);
  return Math.floor((plannedThousandths * y) / PCT_SCALE);
}

/** Sellable stock: what is on hand minus what open commitments already claim. */
export function availableToPromise(
  onHandThousandths: number,
  reservedOpenThousandths: number,
): number {
  return Math.max(0, onHandThousandths - Math.max(0, reservedOpenThousandths));
}

export interface CostPreviewLine {
  itemId: string;
  requiredThousandths: number;
  unitCostMinor: number;
  costMinor: number;
}

export interface ProductionCostPreview {
  lines: CostPreviewLine[];
  totalCostMinor: number;
}

/**
 * What producing `requirements` would cost at current moving-average unit
 * costs, before any movement is written. Line cost rounds per line; the
 * preview total must equal the sum of the shown lines so the UI never
 * displays a number the ledger could not reproduce exactly.
 */
export function previewProductionCost(
  requirements: readonly ComponentRequirement[],
  avgUnitCostMinorByItem: ReadonlyMap<string, number>,
): ProductionCostPreview {
  const lines: CostPreviewLine[] = requirements.map((r) => {
    const unitCost = avgUnitCostMinorByItem.get(r.itemId) ?? 0;
    return {
      itemId: r.itemId,
      requiredThousandths: r.quantityThousandths,
      unitCostMinor: unitCost,
      costMinor: Math.round((r.quantityThousandths * unitCost) / 1000),
    };
  });
  return {
    lines,
    totalCostMinor: lines.reduce((sum, l) => sum + l.costMinor, 0),
  };
}

export interface CycleCountVarianceInput {
  expectedThousandths: number;
  countedThousandths: number | null; // null = not counted yet
}

export interface CycleCountVariance {
  varianceThousandths: number; // counted − expected
}

/** Counted − expected for every line that has actually been counted. */
export function cycleCountVariances(
  lines: readonly CycleCountVarianceInput[],
): CycleCountVariance[] {
  return lines
    .filter((l) => l.countedThousandths !== null)
    .map((l) => ({ varianceThousandths: l.countedThousandths! - l.expectedThousandths }));
}

// ── Lot traceability ─────────────────────────────────────────────────────

export interface LotTraceEdge {
  /** Lot that received stock (the produced assembly's lot). */
  consumerLotId: string;
  /** Lot that supplied stock (the consumed component's lot). */
  sourceLotId: string;
  quantityThousandths: number;
  /** Free-form provenance, e.g. the work order reference. */
  viaRef?: string | undefined;
}

export interface LotTraceNode {
  lotId: string;
  quantityThousandths: number;
  viaRef?: string | undefined;
  children: LotTraceNode[];
}

const MAX_TRACE_DEPTH = 32;

/**
 * Recursively expands everything that fed a lot, and everything that fed
 * those lots, upstream. Guards against malformed graphs (cycles) with both
 * a visited set and a hard depth limit; a corrupt graph degrades to a
 * truncated answer rather than hanging the request.
 */
export function traceLotUpstream(
  edges: readonly LotTraceEdge[],
  rootLotId: string,
): LotTraceNode {
  const byConsumer = new Map<string, LotTraceEdge[]>();
  for (const e of edges) {
    const list = byConsumer.get(e.consumerLotId) ?? [];
    list.push(e);
    byConsumer.set(e.consumerLotId, list);
  }

  const walk = (lotId: string, depth: number, path: ReadonlySet<string>): LotTraceNode => {
    if (depth > MAX_TRACE_DEPTH || path.has(lotId)) {
      return { lotId, quantityThousandths: 0, children: [] };
    }
    const nextPath = new Set(path);
    nextPath.add(lotId);
    const children = (byConsumer.get(lotId) ?? []).map((e) => ({
      ...walk(e.sourceLotId, depth + 1, nextPath),
      quantityThousandths: e.quantityThousandths,
      viaRef: e.viaRef,
    }));
    return { lotId, quantityThousandths: 0, children };
  };

  return walk(rootLotId, 0, new Set());
}
