import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  customers,
  invoiceShares,
  invoices,
  memberships,
  organizations,
  purgeTenantFinancials,
  roles,
  rolePermissions,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "./kernel";
import { documentOutstanding, sumOutstanding } from "./balances";
import { GET as portalGET } from "@/app/api/portal/invoice/[token]/route";

/**
 * N11 reconciliation: one invoice, one outstanding number, every surface.
 * A 1,000.00 invoice with 400.00 credited and 100.00 paid must show
 * 500.00 outstanding from the pure contract, the aging reports, the
 * support projection, the customer portal, and the web balance helper.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const TOTAL = 1_000_00;
const CREDITED = 400_00;
const PAID = 100_00;
const OUTSTANDING = 500_00;

let db: Database["db"];
const orgId = crypto.randomUUID();
let userId: string;
let customerId: string;
let invoiceId: string;
let invoiceNumber: number;
let shareToken: string;

beforeAll(async () => {
  db = createDb(url).db;
  const orgs = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Reconcile Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db, o.id);
    await db.delete(organizations).where(eq(organizations.id, o.id));
  }
  await db.insert(organizations).values({ id: orgId, name: "Reconcile Probe", slug: `rec-${orgId.slice(0, 8)}` });
  const [u] = await db
    .insert(users)
    .values({ email: `reconcile-${Date.now()}@probe.test`, name: "Reconciler" })
    .returning({ id: users.id });
  userId = u!.id;
  await db.insert(memberships).values({ orgId, userId });
  const [role] = await db.insert(roles).values({ orgId, key: "owner", name: "Owner", isSystem: true }).returning();
  await db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "*", orgId });
  await db.insert(userRoles).values({ userId, roleId: role!.id, orgId });
  const [cust] = await db.insert(customers).values({ orgId, name: "Reconcile Customer" }).returning({ id: customers.id });
  customerId = cust!.id;
  const [inv] = await db
    .insert(invoices)
    .values({
      orgId,
      customerId,
      number: 7_700_001,
      status: "sent",
      subtotalMinor: TOTAL,
      taxMinor: 0,
      totalMinor: TOTAL,
      creditedMinor: CREDITED,
      paidMinor: PAID,
      issuedAt: new Date(),
    })
    .returning({ id: invoices.id, number: invoices.number });
  invoiceId = inv!.id;
  invoiceNumber = inv!.number;
  shareToken = `rec-share-${crypto.randomUUID().replaceAll("-", "")}`;
  await db.insert(invoiceShares).values({
    orgId,
    invoiceId,
    token: shareToken,
    createdByActorType: "human",
    createdByActorId: userId,
  });
});

afterAll(async () => {
  await purgeTenantFinancials(db, orgId);
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

describe("N11 cross-surface reconciliation", () => {
  const ctx = {
    actor: { type: "human" as const, id: userId, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };

  it("pure contract and web helper agree", () => {
    const row = { totalMinor: TOTAL, creditedMinor: CREDITED, paidMinor: PAID };
    expect(documentOutstanding(row)).toBe(OUTSTANDING);
    expect(sumOutstanding([row])).toBe(OUTSTANDING);
    // over-allocation clamps instead of hiding credit behind a negative
    expect(documentOutstanding({ totalMinor: 100, creditedMinor: 80, paidMinor: 40 })).toBe(0);
  });

  it("arAging reports the same outstanding", async () => {
    const executor = buildExecutor(db, buildRegistry(db));
    const aging = await executor.execute("accounting.arAging", ctx, {});
    if (!aging.ok) throw new Error(aging.error);
    const data = aging.data as { buckets: { totalOutstanding: number }; invoices: { number: number; outstandingMinor: number }[] };
    expect(data.buckets.totalOutstanding).toBe(OUTSTANDING);
    expect(data.invoices.find((i) => i.number === invoiceNumber)).toMatchObject({ outstandingMinor: OUTSTANDING });
  });

  it("analytics aging aggregates the same balance", async () => {
    const executor = buildExecutor(db, buildRegistry(db));
    const aging = await executor.execute("analytics.invoiceAging", ctx, {});
    if (!aging.ok) throw new Error(aging.error);
    const rows = (aging.data as { rows: Record<string, unknown>[] }).rows;
    const total = rows.reduce((s, r) => s + Number(r.balanceMinor), 0);
    expect(total).toBe(OUTSTANDING);
  });

  it("support invoice lookup shows the same balance", async () => {
    const executor = buildExecutor(db, buildRegistry(db));
    const started = await executor.execute("support.startConversation", ctx, {
      customerId,
      subject: "Balance check",
    });
    if (!started.ok) throw new Error(started.error);
    const { conversationId } = started.data as { conversationId: string };
    const lookup = await executor.execute("support.lookupOrderStatus", ctx, { conversationId });
    if (!lookup.ok) throw new Error(lookup.error);
    const data = lookup.data as { invoices: { number: number; outstandingMinor: number }[] };
    expect(data.invoices.find((i) => i.number === invoiceNumber)).toMatchObject({ outstandingMinor: OUTSTANDING });
  });

  it("customer portal shows the credit-adjusted outstanding", async () => {
    const res = await portalGET(new Request(`http://localhost/api/portal/invoice/${shareToken}`), {
      params: Promise.resolve({ token: shareToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invoice: { outstandingMinor: number; creditedMinor: number } };
    expect(body.invoice.outstandingMinor).toBe(OUTSTANDING);
    expect(body.invoice.creditedMinor).toBe(CREDITED);
  });
});
