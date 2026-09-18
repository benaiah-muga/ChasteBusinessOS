import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvals,
  createDb,
  goodsReceiptLines,
  goodsReceipts,
  items,
  memberships,
  organizations,
  purchaseOrders,
  purgeTenantFinancials,
  vendors,
  type Database,
} from "@chaste/db";

/**
 * W0.5 pilot surfaces: the My Work home composes one ranked list from
 * approvals and receipt remainders with deterministic ordering; the
 * receiving desk's API actions carry accepted/rejected lines and refusal
 * detail; and the NL brief degrades honestly without an OpenRouter key.
 * Route handlers are called directly with a mocked session resolution.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

const state = vi.hoisted(() => ({
  current: null as {
    userId: string;
    email: string;
    name: string | null;
    orgId: string | null;
    permissions: Set<string>;
  } | null,
}));

vi.mock("@/server/session", () => ({
  getResolvedUser: async () => state.current,
}));

const { GET: myWorkGET } = await import("@/app/api/my-work/route");
const { POST: summarizePOST } = await import("@/app/api/my-work/summarize/route");
const { POST: purchasingPOST } = await import("@/app/api/purchasing/route");

let db: Database;
const orgId = crypto.randomUUID();
let adminUserId: string;
let vendorId: string;
let poNumber: number;

const post = (body: unknown): Request =>
  new Request("http://localhost/api/purchasing", { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  db = createDb(url);
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Pilot Surface Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
  await db.db.insert(organizations).values({ id: orgId, name: "Pilot Surface Probe", slug: `pt-${orgId.slice(0, 8)}` });
  const { users } = await import("@chaste/db");
  const [user] = await db.db.insert(users).values({ email: `pilot-${orgId.slice(0, 8)}@probe.test`, name: "Pilot Clerk" }).returning({ id: users.id });
  adminUserId = user!.id;
  await db.db.insert(memberships).values({ orgId, userId: adminUserId });
  const [vendor] = await db.db.insert(vendors).values({ orgId, name: "Pilot Vendor" }).returning({ id: vendors.id });
  vendorId = vendor!.id;
  state.current = {
    userId: adminUserId,
    email: `pilot-${orgId.slice(0, 8)}@probe.test`,
    name: "Pilot Clerk",
    orgId,
    permissions: new Set(["purchasing.write", "purchasing.post", "purchasing.read", "inventory.write", "signals.read"]),
  };

  // The pilot chain: order 10 of one item, receive 6 accepted + 2 rejected.
  const [item] = await db.db.insert(items).values({ orgId, sku: `PT-${orgId.slice(0, 6)}`, name: "Pilot widget", salePriceMinor: 100 }).returning({ id: items.id });
  const [po] = await db.db
    .insert(purchaseOrders)
    .values({ orgId, vendorId: vendorId!, number: 1, status: "partial" })
    .returning({ id: purchaseOrders.id, number: purchaseOrders.number });
  poNumber = po!.number;
  await db.db.execute(
    // poLines insert through the module keeps positions; seed one line here.
    // eslint-disable-next-line -- raw seed for a focused route test
    (await import("drizzle-orm")).sql`INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, item_id, position, service_accepted_thousandths)
      VALUES (${po!.id}, 'Pilot widget crate', 10000, 500, ${item!.id}, 1, NULL)`,
  );
  const { poLines } = await import("@chaste/db");
  const [line] = await db.db.select({ id: poLines.id }).from(poLines).where(eq(poLines.poId, po!.id));
  const [receipt] = await db.db
    .insert(goodsReceipts)
    .values({ orgId, poId: po!.id, number: 1, receivedByActorType: "human", receivedByActorId: adminUserId })
    .returning({ id: goodsReceipts.id });
  await db.db.insert(goodsReceiptLines).values({
    orgId,
    receiptId: receipt!.id,
    poLineId: line!.id,
    position: 1,
    acceptedThousandths: 6_000,
    rejectedThousandths: 2_000,
    rejectionNote: "wet packaging",
  });

  // One pending approval the clerk has authority over.
  await db.db.insert(approvals).values({
    orgId,
    capabilityId: "purchasing.payBill",
    riskClass: "money",
    payload: { billNumber: 1, amountMinor: 1 },
    rationale: "pay the pilot vendor",
  });
});

afterAll(async () => {
  state.current = null;
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Pilot Surface Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
});

describe("pilot surfaces (P01/P05)", () => {
  it("composes a ranked My Work list: the approval first, then the receipt remainder", async () => {
    const res = await myWorkGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: Array<{ kind: string; title: string; detail: string; actionHref: string }> };
    expect(body.cards[0]!.kind).toBe("approval");
    expect(body.cards[0]!.title).toContain("purchasing.payBill");
    const remainder = body.cards.find((c) => c.kind === "receipt_remainder");
    expect(remainder).toBeTruthy();
    expect(remainder!.title).toContain(`PO ${poNumber}`);
    expect(remainder!.detail).toContain("Pilot widget crate");
    expect(remainder!.actionHref).toContain(`/purchasing/receiving?poNumber=${poNumber}`);
  });

  it("the receiving desk records accepted and rejected quantities and shows what remains", async () => {
    const detail = await purchasingPOST(post({ action: "receiptDetail", poNumber }));
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { data: { receipts: Array<{ lines: Array<{ acceptedThousandths: number; rejectedThousandths: number }> }>; orderLines: Array<{ remainingThousandths: number }> } };
    expect(detailBody.data.receipts[0]!.lines[0]).toMatchObject({ acceptedThousandths: 6_000, rejectedThousandths: 2_000 });
    expect(detailBody.data.orderLines[0]!.remainingThousandths).toBe(2_000);

    // Receive the remaining 2_000: the order completes.
    const received = await purchasingPOST(post({ action: "receiveGoods", poNumber, lines: [{ lineNumber: 1, quantity: 2_000 }] }));
    expect(received.status).toBe(200);
    const receivedBody = (await received.json()) as { data: { received: boolean; fullyReceived: boolean; receiptNumber: number } };
    expect(receivedBody.data.fullyReceived).toBe(true);
    expect(receivedBody.data.receiptNumber).toBe(2);

    // The rejection path demands its reason at the same boundary.
    const refused = await purchasingPOST(
      post({ action: "receiveGoods", poNumber, lines: [{ lineNumber: 1, quantity: 0, rejected: 1 }] }),
    );
    expect(refused.status).toBe(422);
    const refusedBody = (await refused.json()) as { error: string };
    expect(refusedBody.error).toContain("rejectionNote");
  });

  it("degrades the AI brief honestly when no OpenRouter key is configured", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await summarizePOST(new Request("http://localhost/api/my-work/summarize", { method: "POST", body: JSON.stringify({ cards: [{ kind: "approval", title: "x", detail: "y" }] }) }));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { hint: string };
      expect(body.hint).toContain("does not depend on it");
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }

    const empty = await summarizePOST(new Request("http://localhost/api/my-work/summarize", { method: "POST", body: JSON.stringify({ cards: [] }) }));
    expect(empty.status).toBe(400);
  });
});
