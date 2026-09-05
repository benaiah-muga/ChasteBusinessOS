/**
 * Metric-change decomposition (M12, ADR 0039) — the deterministic core of
 * analytics.explainChange. Given the same metric sliced by a dimension in
 * two periods, attribute the delta across dimension values. Contributions
 * sum to the delta EXACTLY (each key's delta is its own; nothing is
 * estimated or smoothed). Pure; order-independent output.
 */

export interface MetricRow {
  /** Dimension value (customer id, product sku, category…). */
  key: string;
  valueMinor: number;
}

export interface Contribution {
  key: string;
  priorMinor: number;
  currentMinor: number;
  deltaMinor: number;
  /** Share of the total delta; null when the total delta is zero. */
  shareOfDelta: number | null;
}

export interface ChangeDecomposition {
  priorTotalMinor: number;
  currentTotalMinor: number;
  deltaMinor: number;
  contributions: Contribution[];
}

export function explainChange(rowsA: MetricRow[], rowsB: MetricRow[]): ChangeDecomposition {
  const prior = new Map<string, number>();
  for (const r of rowsA) prior.set(r.key, (prior.get(r.key) ?? 0) + r.valueMinor);
  const current = new Map<string, number>();
  for (const r of rowsB) current.set(r.key, (current.get(r.key) ?? 0) + r.valueMinor);

  const keys = [...new Set([...prior.keys(), ...current.keys()])];
  const priorTotalMinor = [...prior.values()].reduce((s, v) => s + v, 0);
  const currentTotalMinor = [...current.values()].reduce((s, v) => s + v, 0);
  const deltaMinor = currentTotalMinor - priorTotalMinor;

  const contributions: Contribution[] = keys.map((key) => {
    const p = prior.get(key) ?? 0;
    const c = current.get(key) ?? 0;
    return {
      key,
      priorMinor: p,
      currentMinor: c,
      deltaMinor: c - p,
      shareOfDelta: deltaMinor === 0 ? null : (c - p) / deltaMinor,
    };
  });
  contributions.sort((a, b) => a.deltaMinor - b.deltaMinor || a.key.localeCompare(b.key));
  return { priorTotalMinor, currentTotalMinor, deltaMinor, contributions };
}
