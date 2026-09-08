import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, documents, organizations, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerDocumentCapabilities, type ModuleDeps } from "./index";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let documentId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerDocumentCapabilities(registry, deps);
  return registry;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "M12 Docs Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
  await db.db.insert(organizations).values({ id: orgId, name: "M12 Docs Probe", slug: `d12-${orgId.slice(0, 8)}` });
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "M12 Docs Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
});

describe("documents layer (M12.4)", () => {
  it("folder, business-record metadata, and expiry persist at ingest", async () => {
    const doc = await run("documents.createDocument", {
      title: "Lease — depot B",
      text: "Lease agreement text.",
      folder: "contracts/2026",
      refType: "project",
      refId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    documentId = doc.documentId;
    const [row] = await db.db.select().from(documents).where(eq(documents.id, documentId));
    expect(row!.folder).toBe("contracts/2026");
    expect(row!.refType).toBe("project");
    expect(row!.expiresAt).toBeInstanceOf(Date);
  });

  it("versions are append-only and the document becomes the latest", async () => {
    const v1 = await run("documents.addVersion", { documentId, rawText: "Lease v2 with the new clause.", note: "added clause 7" });
    expect(v1.version).toBe(1);
    const v2 = await run("documents.addVersion", { documentId, rawText: "Lease v3.", note: "typo fix" });
    expect(v2.version).toBe(2);
    const versions = await run("documents.listVersions", { documentId });
    expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    const [row] = await db.db.select({ rawText: documents.rawText }).from(documents).where(eq(documents.id, documentId));
    expect(row!.rawText).toBe("Lease v3.");
  });
});
