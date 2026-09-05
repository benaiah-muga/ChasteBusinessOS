import { and, desc, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { embed, extractBillLinesFromText, parseDocumentImage } from "@chaste/ai";
import {
  accounts,
  documentSuggestions,
  documents,
  documentVersions,
  memories,
  type Database,
} from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import { suggestExpenseAccount, type AccountType, type CoderAccount } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const BASE64_CHARS_PER_BYTE = 4 / 3;

/** Best-effort org-memory write; retrieval degrades gracefully without a key. */
async function embedDocChunk(tx: Tx | ModuleDeps["db"], orgId: string, documentId: string, title: string, text: string): Promise<void> {
  const vec = await embed([text.slice(0, 8000)], { inputType: "passage" })
    .then((rows) => rows[0])
    .catch(() => undefined);
  const dim = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
  await tx.insert(memories).values({
    orgId,
    kind: "doc_chunk",
    source: `document:${documentId}`,
    content: text.slice(0, 8000),
    embedding: vec ?? new Array(dim).fill(0),
    metadata: { documentId, title },
  });
}

const createDocument = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.createDocument",
    title: "Ingest document",
    intent:
      "Register a business document (vendor bill, receipt, statement) either as pasted text or an uploaded file so it can be parsed into the org's memory",
    module: "documents",
    risk: "write",
    permission: "documents.write",
    inverse: {
      capabilityId: "documents.deleteDocument",
      buildInput: (_input, output) => ({ documentId: (output as { documentId?: string }).documentId ?? "" }),
    },
    input: z
      .object({
        title: z.string().min(1).max(200),
        folder: z.string().max(300).optional(),
        refType: z.string().max(40).optional(),
        refId: z.string().uuid().optional(),
        expiresAt: z.string().datetime().optional(),
        text: z.string().min(1).max(100_000).optional().describe("pasted document text"),
        fileBase64: z.string().max(Math.ceil(MAX_UPLOAD_BYTES * BASE64_CHARS_PER_BYTE)).optional(),
        mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
      })
      .refine((v) => Boolean(v.text) !== Boolean(v.fileBase64), "provide exactly one of text or fileBase64")
      .refine((v) => !v.fileBase64 || v.mimeType, "uploads need a mime type"),
    output: z.object({ documentId: z.string() }),
    execute: async (ctx, input) => {
      const bytes = input.fileBase64 ? Math.floor(input.fileBase64.length / BASE64_CHARS_PER_BYTE) : null;
      if (bytes !== null && bytes > MAX_UPLOAD_BYTES) throw new Error("file exceeds the 5MB limit");
      const [row] = await deps.db
        .insert(documents)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          sourceType: input.fileBase64 ? "upload" : "text",
          mimeType: input.mimeType ?? null,
          sizeBytes: bytes,
          contentBase64: input.fileBase64 ?? null,
          rawText: input.text ?? null,
          createdByActorType: ctx.actor.type,
          createdByActorId: ctx.actor.id,
        folder: (input as { folder?: string }).folder ?? null,
    refType: (input as { refType?: string }).refType ?? null,
    refId: (input as { refId?: string }).refId ?? null,
    expiresAt: (input as { expiresAt?: Date | string }).expiresAt ? new Date((input as { expiresAt?: Date | string }).expiresAt as string) : null,})
        .returning({ id: documents.id });
      return { documentId: row!.id };
    },
  });

const deleteDocument = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.deleteDocument",
    title: "Delete ingested document",
    intent:
      "Permanently remove an ingested document and its coding suggestions; used to reverse accidental ingestion",
    module: "documents",
    risk: "destructive",
    permission: "documents.write",
    input: z.object({ documentId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
    execute: async (ctx, input) => {
      const deleted = await deps.db
        .delete(documents)
        .where(and(eq(documents.orgId, ctx.actor.orgId), eq(documents.id, input.documentId)))
        .returning({ id: documents.id });
      return { deleted: deleted.length > 0 };
    },
  });

const parseDocument = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.parseDocument",
    title: "Parse document to markdown",
    intent:
      "Run OCR over an uploaded document or normalize pasted text into structured markdown, store it, and index it into org memory for retrieval",
    module: "documents",
    risk: "write",
    permission: "documents.write",
    // No inverse: parsing produces derived, recomputable state (markdown +
    // doc_chunk memory); re-parsing is the undo. Debt accepted deliberately.
    input: z.object({ documentId: z.string() }),
    output: z.object({ status: z.enum(["parsed", "failed"]), chars: z.number() }),
    execute: async (ctx, input) => {
      const [doc] = await deps.db
        .select()
        .from(documents)
        .where(and(eq(documents.orgId, ctx.actor.orgId), eq(documents.id, input.documentId)))
        .limit(1);
      if (!doc) throw new Error(`no document ${input.documentId}`);

      let markdown = "";
      try {
        if (doc.contentBase64 && doc.mimeType) {
          const bytes = Uint8Array.from(Buffer.from(doc.contentBase64, "base64"));
          markdown = await parseDocumentImage(bytes, doc.mimeType);
          if (!markdown.trim()) throw new Error("OCR returned no text");
        } else if (doc.rawText) {
          markdown = doc.rawText;
        } else {
          throw new Error("document has neither a file nor pasted text");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps.db
          .update(documents)
          .set({ status: "failed", parseError: message, updatedAt: new Date() })
          .where(eq(documents.id, doc.id));
        throw new Error(`parse failed: ${message}`);
      }

      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await tx
          .update(documents)
          .set({ parsedMarkdown: markdown, status: "parsed", parseError: null, updatedAt: new Date() })
          .where(eq(documents.id, doc.id));
        await tx.delete(memories).where(and(eq(memories.orgId, ctx.actor.orgId), eq(memories.source, `document:${doc.id}`)));
        await embedDocChunk(tx, ctx.actor.orgId, doc.id, doc.title, markdown);
        return { status: "parsed" as const, chars: markdown.length };
      });
    },
  });

const suggestionLineSchema = z.object({
  description: z.string().min(1),
  quantityThousandths: z.number().int().positive().default(1000),
  unitPriceMinor: z.number().int().nonnegative(),
});

const suggestCoding = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.suggestCoding",
    title: "Suggest expense coding",
    intent:
      "Propose expense-account codes for a document's line items against the org chart of accounts, replacing any previous open suggestions",
    module: "documents",
    risk: "write",
    permission: "documents.write",
    // No inverse: suggestions are derived advice that is fully replaced on
    // every run; dismissing or re-suggesting is the reversal.
    input: z.object({
      documentId: z.string(),
      lines: z.array(suggestionLineSchema).min(1).max(50).optional().describe("omit to extract lines from the parsed text via model"),
    }),
    output: z.object({
      suggestions: z.array(
        z.object({
          description: z.string(),
          quantityThousandths: z.number(),
          unitPriceMinor: z.number(),
          suggestedAccountCode: z.string(),
          matchScore: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const [doc] = await deps.db
        .select()
        .from(documents)
        .where(and(eq(documents.orgId, ctx.actor.orgId), eq(documents.id, input.documentId)))
        .limit(1);
      if (!doc) throw new Error(`no document ${input.documentId}`);

      let lines = input.lines;
      if (!lines) {
        const text = doc.parsedMarkdown ?? doc.rawText;
        if (!text?.trim()) throw new Error("document has no parsed text yet, parse it first");
        lines = await extractBillLinesFromText(text);
      }
      if (lines.length === 0) throw new Error("no bill lines could be extracted from this document");

      const rows = await deps.db
        .select({ code: accounts.code, name: accounts.name, type: accounts.type })
        .from(accounts)
        .where(eq(accounts.orgId, ctx.actor.orgId));
      const coa: CoderAccount[] = rows.map((a) => ({ ...a, type: a.type as AccountType }));

      const coded = lines.map((line) => {
        const match = suggestExpenseAccount(line.description, coa);
        return { ...line, suggestedAccountCode: match.code, matchScore: match.score };
      });

      await withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await tx
          .delete(documentSuggestions)
          .where(and(eq(documentSuggestions.orgId, ctx.actor.orgId), eq(documentSuggestions.documentId, doc.id)));
        await tx.insert(documentSuggestions).values(
          coded.map((s) => ({
            orgId: ctx.actor.orgId,
            documentId: doc.id,
            description: s.description,
            quantityThousandths: s.quantityThousandths,
            unitPriceMinor: s.unitPriceMinor,
            suggestedAccountCode: s.suggestedAccountCode,
            matchScore: s.matchScore,
            matchedOn: [],
          })),
        );
      });

      return {
        suggestions: coded.map((s) => ({
          description: s.description,
          quantityThousandths: s.quantityThousandths,
          unitPriceMinor: s.unitPriceMinor,
          suggestedAccountCode: s.suggestedAccountCode,
          matchScore: s.matchScore,
        })),
      };
    },
  });

const searchMemory = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.searchMemory",
    title: "Search org memory",
    intent:
      "Search the organization's remembered knowledge, ingested documents, policies, SOPs and business profile, to ground answers in real facts before claiming not to know",
    module: "documents",
    risk: "read",
    permission: "documents.read",
    input: z.object({
      query: z.string().min(2).max(500),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    output: z.object({
      mode: z.enum(["semantic", "text"]),
      results: z.array(
        z.object({
          kind: z.string(),
          source: z.string().nullable(),
          title: z.string().nullable(),
          content: z.string(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      // Semantic first; degrade to plain-text matching when embeddings or the
      // model key are unavailable, retrieval must never hard-fail.
      try {
        const [vec] = await embed([input.query], { inputType: "query" });
        if (vec) {
          const literal = JSON.stringify(vec);
          const rows = await deps.db
            .select({
              kind: memories.kind,
              source: memories.source,
              content: memories.content,
              title: sql<string | null>`${memories.metadata}->>'title'`,
            })
            .from(memories)
            .where(and(eq(memories.orgId, ctx.actor.orgId), isNotNull(memories.embedding)))
            .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
            .limit(input.limit);
          if (rows.length > 0) {
            return { mode: "semantic" as const, results: rows };
          }
        }
      } catch {
        // fall through to text search
      }
      const needle = `%${input.query.replace(/[%_]/g, "").trim()}%`;
      const rows = await deps.db
        .select({
          kind: memories.kind,
          source: memories.source,
          content: memories.content,
          title: sql<string | null>`${memories.metadata}->>'title'`,
        })
        .from(memories)
        .where(and(eq(memories.orgId, ctx.actor.orgId), ilike(memories.content, needle)))
        .limit(input.limit);
      return { mode: "text" as const, results: rows };
    },
  });

const listDocuments = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.listDocuments",
    title: "List ingested documents",
    intent:
      "Show every ingested document with its parse status and how many open coding suggestions are waiting, so staff know what still needs review",
    module: "documents",
    risk: "read",
    permission: "documents.read",
    input: z.object({}),
    output: z.object({
      documents: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          sourceType: z.string(),
          openSuggestions: z.number(),
          createdAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({
          id: documents.id,
          title: documents.title,
          status: documents.status,
          sourceType: documents.sourceType,
          createdAt: documents.createdAt,
          openSuggestions: sql<number>`(
            select count(*)::int from ${documentSuggestions}
            where ${documentSuggestions.documentId} = ${documents.id}
              and ${documentSuggestions.status} = 'open'
          )`,
        })
        .from(documents)
        .where(eq(documents.orgId, ctx.actor.orgId))
        .orderBy(desc(documents.createdAt))
        .limit(100);
      return { documents: rows.map((r) => ({ ...r, openSuggestions: Number(r.openSuggestions) })) };
    },
  });


// ── M12: version history ───────────────────────────────────────────────

const addVersion = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.addVersion",
    title: "Add document version",
    intent:
      "Replace a document's content with a new version: the old content is archived in an append-only history and the document becomes the latest",
    module: "documents",
    risk: "write",
    permission: "documents.write",
    input: z.object({
      documentId: z.string().uuid(),
      contentBase64: z.string().optional(),
      rawText: z.string().optional(),
      note: z.string().max(500).optional(),
    }),
    output: z.object({ version: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [doc] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, input.documentId), eq(documents.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!doc) throw new Error("document not found");
        if (!input.contentBase64 && !input.rawText) throw new Error("a version needs contentBase64 or rawText");
        const [maxRow] = await tx
          .select({ maxV: sql<number>`coalesce(max(${documentVersions.version}), 0)` })
          .from(documentVersions)
          .where(eq(documentVersions.documentId, doc.id));
        const nextVersion = Number(maxRow?.maxV ?? 0) + 1;
        await tx.insert(documentVersions).values({
          orgId: ctx.actor.orgId,
          documentId: doc.id,
          version: nextVersion,
          contentBase64: doc.contentBase64,
          rawText: doc.rawText,
          note: input.note ?? null,
          createdByActorType: ctx.actor.type,
          createdByActorId: ctx.actor.id,
        });
        await tx
          .update(documents)
          .set({ contentBase64: input.contentBase64 ?? doc.contentBase64, rawText: input.rawText ?? doc.rawText, updatedAt: ctx.now })
          .where(eq(documents.id, doc.id));
        return { version: nextVersion };
      });
    },
  });

const listVersions = (deps: ModuleDeps) =>
  defineCapability({
    id: "documents.listVersions",
    title: "List document versions",
    intent: "Show a document's append-only version history, oldest to newest",
    module: "documents",
    risk: "read",
    permission: "documents.read",
    input: z.object({ documentId: z.string().uuid() }),
    output: z.object({ versions: z.array(z.object({ version: z.number(), note: z.string().nullable(), createdAt: z.string() })) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .select({ version: documentVersions.version, note: documentVersions.note, createdAt: documentVersions.createdAt })
          .from(documentVersions)
          .where(and(eq(documentVersions.orgId, ctx.actor.orgId), eq(documentVersions.documentId, input.documentId)))
          .orderBy(documentVersions.version);
        return { versions: rows.map((r) => ({ version: r.version, note: r.note, createdAt: r.createdAt.toISOString() })) };
      });
    },
  });
export function registerDocumentCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createDocument(deps));
  registry.register(deleteDocument(deps));
  registry.register(parseDocument(deps));
  registry.register(suggestCoding(deps));
  registry.register(listDocuments(deps));
  registry.register(searchMemory(deps));
  registry.register(addVersion(deps));
  registry.register(listVersions(deps));
}
export { createDocumentSignalProducer } from "./signals";
