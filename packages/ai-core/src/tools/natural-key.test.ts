import { createQueryRegistry, createRequestContext, defineQuery, type Actor } from "@chaste/kernel";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { dedupeCreateSteps, findExistingForCreate } from "./natural-key.js";

const actor: Actor = {
  kind: "user",
  userId: "user-1",
  organizationId: "org-1",
  permissions: new Set([
    "pur.po.read",
    "crm.customer.read",
    "core.bpartner.read",
    "inv.stock.read",
    "core.branch.read",
    "acc.account.read",
  ]),
};

const store = {
  vendors: [{ id: "v1", name: "Acme Trading" }],
  customers: [{ id: "c1", name: "Nairobi Coffee Roasters" }],
  bpartners: [{ id: "bp1", name: "Acme Trading", type: "organization" }],
  products: [{ id: "p1", sku: "SKU-100", name: "Widget" }],
  branches: [{ id: "b1", name: "Headquarters", code: "HQ" }],
  accounts: [{ id: "a1", code: "1000", name: "Cash" }],
};

function sampleQueries() {
  const queries = createQueryRegistry();
  queries.register(
    defineQuery({
      name: "pur.po.list",
      permissions: ["pur.po.read"],
      input: z.object({}).default({}),
      output: z.object({
        vendors: z.array(z.object({ id: z.string(), name: z.string() })),
        orders: z.array(z.any()),
      }),
      handler: async () => ({ vendors: store.vendors, orders: [] }),
    }),
  );
  queries.register(
    defineQuery({
      name: "crm.customer.list",
      permissions: ["crm.customer.read"],
      input: z.object({ search: z.string().optional() }).default({}),
      output: z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),
      handler: async ({ search }) => ({
        items: search ? store.customers.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())) : store.customers,
      }),
    }),
  );
  queries.register(
    defineQuery({
      name: "core.bpartner.list",
      permissions: ["core.bpartner.read"],
      input: z.object({ search: z.string().optional(), type: z.string().optional() }).default({}),
      output: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })) }),
      handler: async ({ search, type }) => ({
        items: store.bpartners.filter(
          (b) => (!search || b.name.toLowerCase().includes(search.toLowerCase())) && (!type || b.type === type),
        ),
      }),
    }),
  );
  queries.register(
    defineQuery({
      name: "inv.stock.list",
      permissions: ["inv.stock.read"],
      input: z.object({}).default({}),
      output: z.object({
        warehouses: z.array(z.any()),
        products: z.array(z.object({ id: z.string(), sku: z.string(), name: z.string() })),
        levels: z.array(z.any()),
      }),
      handler: async () => ({ warehouses: [], products: store.products, levels: [] }),
    }),
  );
  queries.register(
    defineQuery({
      name: "core.branch.list",
      permissions: ["core.branch.read"],
      input: z.object({}).default({}),
      output: z.object({
        branches: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
      }),
      handler: async () => ({ branches: store.branches }),
    }),
  );
  queries.register(
    defineQuery({
      name: "acc.account.list",
      permissions: ["acc.account.read"],
      input: z.object({}).default({}),
      output: z.object({ items: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })) }),
      handler: async () => ({ items: store.accounts }),
    }),
  );
  return queries;
}

const ctx = createRequestContext({ actor });

describe("findExistingForCreate", () => {
  const queries = sampleQueries();

  it("matches an existing vendor by exact name", async () => {
    const hit = await findExistingForCreate("pur.vendor.create", { name: "Acme Trading" }, queries, ctx);
    expect(hit).toEqual({ id: "v1", label: "Acme Trading", entity: "Vendor" });
  });

  it("matches case-insensitively and by partial name", async () => {
    expect(await findExistingForCreate("pur.vendor.create", { name: "acme trading" }, queries, ctx)).not.toBeNull();
    expect(await findExistingForCreate("pur.vendor.create", { name: "Acme" }, queries, ctx)).not.toBeNull();
  });

  it("returns null when no candidate matches", async () => {
    expect(await findExistingForCreate("pur.vendor.create", { name: "Brand New Ltd" }, queries, ctx)).toBeNull();
  });

  it("matches a product by sku and an account by code", async () => {
    expect(await findExistingForCreate("inv.product.create", { sku: "sku-100", name: "Widget" }, queries, ctx)).toEqual({
      id: "p1",
      label: "SKU-100",
      entity: "Product",
    });
    expect(await findExistingForCreate("acc.account.create", { code: "1000" }, queries, ctx)).toEqual({
      id: "a1",
      label: "1000",
      entity: "Account",
    });
  });

  it("matches a branch by code", async () => {
    expect(await findExistingForCreate("core.branch.create", { name: "New Branch", code: "HQ" }, queries, ctx)).toEqual({
      id: "b1",
      label: "HQ",
      entity: "Branch",
    });
  });

  it("respects the bpartner type filter", async () => {
    const match = await findExistingForCreate(
      "core.bpartner.create",
      { name: "Acme Trading", type: "organization" },
      queries,
      ctx,
    );
    expect(match).not.toBeNull();
    const person = await findExistingForCreate(
      "core.bpartner.create",
      { name: "Acme Trading", type: "person" },
      queries,
      ctx,
    );
    expect(person).toBeNull();
  });

  it("returns null for an unknown command (no rule)", async () => {
    expect(await findExistingForCreate("pur.po.create", { vendorId: "v1" }, queries, ctx)).toBeNull();
  });

  it("returns null when the natural key is missing or empty", async () => {
    expect(await findExistingForCreate("pur.vendor.create", {}, queries, ctx)).toBeNull();
    expect(await findExistingForCreate("pur.vendor.create", { name: "  " }, queries, ctx)).toBeNull();
  });

  it("never throws when the read query fails (missing read permission)", async () => {
    const denied: Actor = { ...actor, permissions: new Set([]) };
    const deniedCtx = createRequestContext({ actor: denied });
    const result = await findExistingForCreate("pur.vendor.create", { name: "Acme Trading" }, queries, deniedCtx);
    expect(result).toBeNull();
  });
});

describe("dedupeCreateSteps", () => {
  const queries = sampleQueries();

  it("drops create steps whose natural key already resolves, keeping the rest", async () => {
    const steps = [
      { command: "pur.vendor.create", input: { name: "Acme Trading" } },
      { command: "pur.vendor.create", input: { name: "Brand New Ltd" } },
      { command: "crm.customer.create", input: { name: "Nairobi Coffee Roasters" } },
    ];
    const deduped = await dedupeCreateSteps(queries, ctx, steps);
    expect(deduped.map((s) => s.input.name)).toEqual(["Brand New Ltd"]);
  });

  it("leaves non-create commands untouched", async () => {
    const steps = [{ command: "pur.po.create", input: { vendorId: "v1" } }];
    const deduped = await dedupeCreateSteps(queries, ctx, steps);
    expect(deduped).toHaveLength(1);
  });
});