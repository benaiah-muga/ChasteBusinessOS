import { executeQuery, type QueryRegistry, type RequestContext } from "@chaste/kernel";

/**
 * Natural-key existence gate for entity-create commands.
 *
 * A create command's Zod contract validates *shape* but is stateless: it
 * cannot know that "Acme Trading" already exists. Models therefore
 * intermittently propose redundant creates (research doc §Preventing
 * superfluous writes). This module gives each create command a deterministic
 * existence check backed by the SAME read-query bus a human uses — no dual
 * write path, no invented ids, and never a DB bypass. If the read query fails
 * (e.g. the actor lacks the read permission) the gate returns `null` so the
 * write proceeds as before: a best-effort guard, never a write blocker.
 */

export interface NaturalKeyRule {
  /** Bus command this rule guards, e.g. `pur.vendor.create`. */
  command: string;
  /** Bus query that lists existing records. */
  checkQuery: string;
  /** Create-input field holding the natural key. */
  keyField: string;
  /** Build the check-query input from the create args (e.g. search/type). */
  checkInputFrom?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Extract candidate records (id + natural-key label) from the query result. */
  pick: (data: unknown) => { id: string; label: string }[];
  /** Entity label for messages, e.g. "Vendor". */
  entity: string;
}

const NATURAL_KEY_RULES: NaturalKeyRule[] = [
  {
    command: "pur.vendor.create",
    checkQuery: "pur.po.list",
    keyField: "name",
    pick: (data) => {
      const vendors = ((data as { vendors?: { id: string; name: string }[] }).vendors ?? []) as {
        id: string;
        name: string;
      }[];
      return vendors.map((v) => ({ id: v.id, label: v.name }));
    },
    entity: "Vendor",
  },
  {
    command: "crm.customer.create",
    checkQuery: "crm.customer.list",
    keyField: "name",
    checkInputFrom: (args) => ({
      search: typeof args.name === "string" ? args.name : undefined,
    }),
    pick: (data) => {
      const items = ((data as { items?: { id: string; name: string }[] }).items ?? []) as {
        id: string;
        name: string;
      }[];
      return items.map((c) => ({ id: c.id, label: c.name }));
    },
    entity: "Customer",
  },
  {
    command: "core.bpartner.create",
    checkQuery: "core.bpartner.list",
    keyField: "name",
    checkInputFrom: (args) => {
      const input: Record<string, unknown> = {
        search: typeof args.name === "string" ? args.name : undefined,
      };
      if (typeof args.type === "string") input.type = args.type;
      return input;
    },
    pick: (data) => {
      const items = ((data as { items?: { id: string; name: string }[] }).items ?? []) as {
        id: string;
        name: string;
      }[];
      return items.map((b) => ({ id: b.id, label: b.name }));
    },
    entity: "Business partner",
  },
  {
    command: "inv.product.create",
    checkQuery: "inv.stock.list",
    keyField: "sku",
    pick: (data) => {
      const products = ((data as { products?: { id: string; sku: string }[] }).products ?? []) as {
        id: string;
        sku: string;
      }[];
      return products.map((p) => ({ id: p.id, label: p.sku }));
    },
    entity: "Product",
  },
  {
    command: "core.branch.create",
    checkQuery: "core.branch.list",
    keyField: "code",
    pick: (data) => {
      const branches = ((data as { branches?: { id: string; code: string }[] }).branches ?? []) as {
        id: string;
        code: string;
      }[];
      return branches.map((b) => ({ id: b.id, label: b.code }));
    },
    entity: "Branch",
  },
  {
    command: "acc.account.create",
    checkQuery: "acc.account.list",
    keyField: "code",
    pick: (data) => {
      const items = ((data as { items?: { id: string; code: string }[] }).items ?? []) as {
        id: string;
        code: string;
      }[];
      return items.map((a) => ({ id: a.id, label: a.code }));
    },
    entity: "Account",
  },
];

export function naturalKeyRuleFor(command: string): NaturalKeyRule | undefined {
  return NATURAL_KEY_RULES.find((r) => r.command === command);
}

export interface ExistingRecord {
  id: string;
  label: string;
  entity: string;
}

/**
 * Best-effort existence check for a create command's natural key. Returns the
 * matching existing record or `null` (no rule, missing key, no match, or the
 * read query failed). Never throws — the gate must not block a legitimate write.
 */
export async function findExistingForCreate(
  command: string,
  args: Record<string, unknown>,
  queries: QueryRegistry,
  ctx: RequestContext,
): Promise<ExistingRecord | null> {
  const rule = naturalKeyRuleFor(command);
  if (!rule) return null;
  const key = args[rule.keyField];
  if (typeof key !== "string" || key.trim() === "") return null;
  const needle = key.trim().toLowerCase();

  let data: unknown;
  try {
    const res = await executeQuery(queries, rule.checkQuery, rule.checkInputFrom?.(args) ?? {}, ctx);
    data = res.data;
  } catch {
    return null;
  }

  const candidates = rule.pick(data);
  const exact = candidates.find((c) => c.label.trim().toLowerCase() === needle);
  if (exact) return { id: exact.id, label: exact.label, entity: rule.entity };
  const partial = candidates.find((c) => {
    const n = c.label.trim().toLowerCase();
    return n.includes(needle) || needle.includes(n);
  });
  if (partial) return { id: partial.id, label: partial.label, entity: rule.entity };
  return null;
}

/**
 * Plan-dedupe at confirmation: drop write steps for create commands whose
 * natural key already resolves to an existing record (checked through the same
 * read-query bus as {@link findExistingForCreate}). Prevents a confirm card
 * from proposing a redundant create — the target already exists, so there is
 * nothing for the step to do. Best-effort: an unresolvable check leaves the
 * step untouched. Never throws.
 */
export async function dedupeCreateSteps<T extends { command: string; input: Record<string, unknown> }>(
  queries: QueryRegistry,
  ctx: RequestContext,
  steps: T[],
): Promise<T[]> {
  const out: T[] = [];
  for (const step of steps) {
    const existing = await findExistingForCreate(step.command, step.input, queries, ctx);
    if (!existing) out.push(step);
  }
  return out;
}