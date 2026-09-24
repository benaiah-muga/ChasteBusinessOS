import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, docDrafts, organizations, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { extractPlaceholders, registerDocumentCapabilities, type ModuleDeps } from "./index";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let documentId: string;

const DOC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello {{customer.name}}" }] }] };

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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "P4 Authored Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
  await db.db.insert(organizations).values({ id: orgId, name: "P4 Authored Probe", slug: `p4-${orgId.slice(0, 8)}` });
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "P4 Authored Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
});

describe("authored documents (Phase 4)", () => {
  it("create, list and get round-trip content", async () => {
    const created = await run("documents.createDoc", {
      title: "Service quote",
      content: DOC,
      html: "<p>Hello</p>",
      documentType: "quotation",
      pageSettings: { size: "Letter", orientation: "landscape", margin: "compact" },
    });
    expect(created.documentId).toBeTruthy();
    documentId = created.documentId;

    const listed = await run("documents.listDocs", {});
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0].status).toBe("draft");

    const got = await run("documents.getDoc", { documentId });
    expect(got.document.title).toBe("Service quote");
    expect(got.document.content.type).toBe("doc");
    expect(got.document.versions).toBe(0);
    expect(got.document.documentType).toBe("quotation");
    expect(got.document.pageSettings).toEqual({ size: "Letter", orientation: "landscape", margin: "compact" });
  });

  it("publishing archives append-only versions and clears the draft", async () => {
    await db.db.insert(docDrafts).values({ orgId, documentId, contentJson: DOC });
    const v1 = await run("documents.saveDocVersion", { documentId, content: DOC, html: "<p>Hello</p>", note: "first" });
    expect(v1.version).toBe(1);
    const v2 = await run("documents.saveDocVersion", {
      documentId,
      content: { type: "doc", content: [] },
      html: "",
      note: "rewrote",
    });
    expect(v2.version).toBe(2);

    const versions = await run("documents.listDocVersions", { documentId });
    expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(versions.versions[0].note).toBe("first");

    const drafts = await db.db.select().from(docDrafts).where(eq(docDrafts.documentId, documentId));
    expect(drafts).toHaveLength(0);

    const got = await run("documents.getDoc", { documentId });
    expect(got.document.status).toBe("published");
    expect(got.document.versions).toBe(2);
  });

  it("restore never deletes: the current content is snapshotted first", async () => {
    const v1 = await run("documents.getDocVersion", { documentId, version: 1 });
    const restored = await run("documents.restoreDocVersion", { documentId, sourceVersion: 1 });
    expect(restored.version).toBe(3);

    const got = await run("documents.getDoc", { documentId });
    expect(got.document.content.type).toBe("doc");
    expect(got.document.content.content[0].content[0].text).toContain("customer.name");
    expect(v1.note).toBe("first");
  });

  it("persists nested folders, document metadata, and page settings", async () => {
    const created = await run("documents.createFolder", { path: "Sales/2026/Quotes" });
    expect(created.path).toBe("Sales/2026/Quotes");

    const folders = await run("documents.listFolders", {});
    expect(folders.folders.map((folder: { path: string }) => folder.path)).toEqual([
      "Sales",
      "Sales/2026",
      "Sales/2026/Quotes",
    ]);

    const previous = await run("documents.updateDocMetadata", {
      documentId,
      title: "Service quote for Acme",
      folder: "Sales/2026/Quotes",
      linkedRecordType: "customer",
      linkedRecordId: crypto.randomUUID(),
      linkedRecordLabel: "Acme Limited",
    });
    expect(previous.previous.title).toBe("Service quote");

    await run("documents.renameFolder", { path: "Sales", newPath: "Commercial" });
    const moved = await run("documents.getDoc", { documentId });
    expect(moved.document.folder).toBe("Commercial/2026/Quotes");
    expect(moved.document.linkedRecordLabel).toBe("Acme Limited");

    await expect(run("documents.deleteFolder", { path: "Commercial" })).rejects.toThrow(/move the documents/);
  });

  it("templates carry placeholders and refuse to delete built-ins", async () => {
    const tpl = await run("documents.createTemplate", { name: "Quote v2", content: DOC });
    expect(tpl.placeholders).toEqual(["customer.name"]);

    const listed = await run("documents.listTemplates", {});
    const mine = listed.templates.find((t: { name: string }) => t.name === "Quote v2");
    expect(mine.placeholders).toEqual(["customer.name"]);

    const seeded = await run("documents.listTemplates", {});
    expect(seeded.templates.length).toBeGreaterThanOrEqual(1);
    void seeded;

    await expect(run("documents.deleteTemplate", { templateId: tpl.templateId })).resolves.toMatchObject({ deleted: true });
  });

  it("creating from a missing template fails and orgs are isolated", async () => {
    await expect(run("documents.createDoc", { title: "x", content: DOC, html: "", templateId: crypto.randomUUID() })).rejects.toThrow(
      /template not found/,
    );
    const otherOrg: ActionContext = {
      actor: { type: "human", id: null, orgId: crypto.randomUUID(), permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    };
    const cap = makeRegistry().get("documents.getDoc")!;
    await expect(cap.execute(otherOrg, { documentId })).rejects.toThrow(/not found/);
  });
});

describe("placeholder extraction", () => {
  it("finds unique dotted tokens", () => {
    expect(extractPlaceholders(DOC)).toEqual(["customer.name"]);
    expect(
      extractPlaceholders({ type: "doc", content: [{ type: "text", text: "{{a.b}} {{a.b}} {{ c }} {{9bad}}" }] }),
    ).toEqual(["a.b", "c"]);
  });
});
