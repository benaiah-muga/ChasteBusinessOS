import * as aq from "arquero";
import { z } from "zod";

/**
 * Declarative dataframe ops over extracted rows (the "pandas step").
 *
 * The model — or the UI — never writes code: it picks from these verbs and
 * the kernel validates every field. There is no eval, no expression parser,
 * no escape hatch into arbitrary computation, so an analysis can never
 * become a data-exfiltration primitive.
 */
export const frameOpSchema = z.array(
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("filter"),
      column: z.string().min(1),
      matches: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains"]),
      value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    }),
    z.object({
      op: z.literal("sort"),
      by: z.string().min(1),
      desc: z.boolean().default(false),
    }),
    z.object({ op: z.literal("top"), n: z.number().int().min(1).max(500) }),
    z.object({ op: z.literal("pick"), columns: z.array(z.string().min(1)).min(1) }),
    z.object({
      op: z.literal("groupBy"),
      keys: z.array(z.string().min(1)).min(1),
      aggregations: z
        .array(
          z.object({
            column: z.string().min(1).optional(),
            fn: z.enum(["count", "sum", "mean", "min", "max"]),
            as: z.string().min(1),
          }),
        )
        .min(1),
    }),
    z.object({
      op: z.literal("pctOfTotal"),
      column: z.string().min(1),
      as: z.string().min(1),
    }),
  ]),
);

export type FrameOp = z.infer<typeof frameOpSchema>[number];

export interface Frame {
  columns: string[];
  rows: Record<string, unknown>[];
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Applies validated ops to plain JSON rows; pure, IO-free, deterministic. */
export function applyFrameOps(rowsIn: Record<string, unknown>[], ops: FrameOp[]): Frame {
  let table = aq.from(rowsIn.length ? rowsIn : [{}]).reify();
  for (const op of ops) {
    switch (op.op) {
      case "filter": {
        const { column, matches, value } = op;
        // aq.escape keeps this a real JavaScript closure (dynamic column
        // access); arquero's static expression parser would reject d[column].
        table = table.filter(
          aq.escape((d: Record<string, unknown>) => {
            const cell = d[column];
            switch (matches) {
              case "eq":
                return cell === value;
              case "ne":
                return cell !== value;
              case "gt":
                return compare(cell, value) > 0;
              case "gte":
                return compare(cell, value) >= 0;
              case "lt":
                return compare(cell, value) < 0;
              case "lte":
                return compare(cell, value) <= 0;
              case "contains":
                return String(cell ?? "")
                  .toLowerCase()
                  .includes(String(value).toLowerCase());
            }
          }),
        );
        break;
      }
      case "sort": {
        const { by, desc } = op;
        table = table.orderby(desc ? aq.desc(by) : by);
        break;
      }
      case "top": {
        table = table.slice(0, op.n);
        break;
      }
      case "pick": {
        table = table.select(op.columns);
        break;
      }
      case "groupBy": {
        // Arquero refuses escaped closures as rollup values (its expression
        // parser is static-only), so grouping runs as a plain-JS fold. Same
        // guarantees: validated columns, no dynamic code.
        const current = Array.from(table) as Record<string, unknown>[];
        const groups = new Map<string, Record<string, unknown>>();
        for (const row of current) {
          const key = op.keys.map((k) => String(row[k] ?? "")).join("\0");
          let entry = groups.get(key);
          if (!entry) {
            entry = {};
            for (const k of op.keys) entry[k] = row[k] ?? null;
            for (const agg of op.aggregations) entry[agg.as] = agg.fn === "count" ? 0 : null;
            groups.set(key, entry);
          }
          for (const agg of op.aggregations) {
            if (agg.fn === "count") {
              entry[agg.as] = (entry[agg.as] as number) + 1;
              continue;
            }
            if (!agg.column) continue;
            const cell = row[agg.column];
            if (typeof cell !== "number") continue;
            const prev = entry[agg.as];
            switch (agg.fn) {
              case "sum":
                entry[agg.as] = ((prev as number) ?? 0) + cell;
                break;
              case "mean": {
                const state = (prev as { sum: number; n: number } | null) ?? { sum: 0, n: 0 };
                entry[agg.as] = { sum: state.sum + cell, n: state.n + 1 };
                break;
              }
              case "min":
                entry[agg.as] = prev === null ? cell : Math.min(prev as number, cell);
                break;
              case "max":
                entry[agg.as] = prev === null ? cell : Math.max(prev as number, cell);
                break;
            }
          }
        }
        const grouped = [...groups.entries()].map(([, entry]) => {
          const out = { ...entry };
          for (const agg of op.aggregations) {
            const v = out[agg.as];
            if (agg.fn === "mean" && v && typeof v === "object") {
              const state = v as { sum: number; n: number };
              out[agg.as] = state.n === 0 ? null : state.sum / state.n;
            }
          }
          return out;
        });
        if (op.keys.length > 0) {
          grouped.sort((a, b) =>
            compare(a[op.keys[0]!], b[op.keys[0]!]),
          );
        }
        table = aq.from(grouped.length ? grouped : [{}]).reify();
        break;
      }
      case "pctOfTotal": {
        const total = rowsIn.reduce((s, r) => s + (typeof r[op.column] === "number" ? (r[op.column] as number) : 0), 0);
        table = table.derive({ [op.as]: aq.escape((d: Record<string, unknown>) => (total === 0 ? 0 : ((d[op.column] as number) ?? 0) / total)) });
        break;
      }
    }
  }
  const out = Array.from(table);
  // Empty input yields one empty sentinel row inside arquero; drop it.
  const rows = rowsIn.length === 0 && out.length === 1 && Object.values(out[0]!).every((v) => v === null || v === undefined) ? [] : (out as Record<string, unknown>[]);
  return { columns: [...table.columnNames()], rows };
}
