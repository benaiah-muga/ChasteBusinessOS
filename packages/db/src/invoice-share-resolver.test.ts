import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { customers, invoiceShares, invoices, organizations } from "./schema/index";
import { ensureAppRole } from "./roles";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
const token = "invoice-share-resolver-test-token-1234";

let admin: ReturnType<typeof createDb>;
let app: ReturnType<typeof createDb>;
let invoiceId: string;

beforeAll(async () => {
  admin = createDb(url);
  await admin.db.insert(organizations).values({
    id: orgId,
    name: "Invoice Share Resolver Test",
    slug: `invoice-share-resolver-${orgId.slice(0, 8)}`,
  });
  const [customer] = await admin.db.insert(customers).values({ orgId, name: "Resolver Test Customer" }).returning({ id: customers.id });
  const [invoice] = await admin.db.insert(invoices).values({
    orgId,
    customerId: customer!.id,
    number: 1,
    subtotalMinor: 100,
    taxMinor: 0,
    totalMinor: 100,
  }).returning({ id: invoices.id });
  invoiceId = invoice!.id;
  await admin.db.insert(invoiceShares).values({
    orgId,
    invoiceId,
    token,
    createdByActorType: "human",
  });

  const { runtimeUrl } = await ensureAppRole({ databaseUrl: url });
  app = createDb(runtimeUrl);
});

afterAll(async () => {
  await app?.client.end();
  await admin?.db.delete(invoiceShares).where(eq(invoiceShares.orgId, orgId));
  await admin?.db.delete(invoices).where(eq(invoices.orgId, orgId));
  await admin?.db.delete(customers).where(eq(customers.orgId, orgId));
  await admin?.db.delete(organizations).where(eq(organizations.id, orgId));
  await admin?.client.end();
});

describe("Go public invoice share token resolver", () => {
  it("returns only the tenant for an active share and hides revoked or malformed tokens", async () => {
    const active = await app.db.execute<{ org_id: string }>(
      sql`SELECT org_id::text FROM public.chaste_resolve_invoice_share_token(${token})`,
    );
    expect(active.map((row) => row.org_id)).toEqual([orgId]);

    await admin.db.update(invoiceShares)
      .set({ revokedAt: new Date() })
      .where(eq(invoiceShares.token, token));
    const revoked = await app.db.execute<{ org_id: string }>(
      sql`SELECT org_id::text FROM public.chaste_resolve_invoice_share_token(${token})`,
    );
    const malformed = await app.db.execute<{ org_id: string }>(
      sql`SELECT org_id::text FROM public.chaste_resolve_invoice_share_token(${"short"})`,
    );
    expect(revoked).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("grants execution to chaste_app without granting it to PUBLIC", async () => {
    const privileges = await admin.db.execute<{ appCanExecute: boolean; publicCanExecute: boolean }>(sql`
      SELECT has_function_privilege('chaste_app', 'public.chaste_resolve_invoice_share_token(text)', 'EXECUTE') AS "appCanExecute",
             EXISTS (
               SELECT 1
               FROM pg_proc AS proc,
                    aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
               WHERE proc.oid = 'public.chaste_resolve_invoice_share_token(text)'::regprocedure
                 AND acl.grantee = 0
                 AND acl.privilege_type = 'EXECUTE'
             ) AS "publicCanExecute"
    `);
    expect(privileges[0]?.appCanExecute).toBe(true);
    expect(privileges[0]?.publicCanExecute).toBe(false);
  });
});
