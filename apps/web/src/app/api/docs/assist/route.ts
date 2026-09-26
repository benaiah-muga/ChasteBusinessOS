import { NextResponse } from "next/server";
import { and, eq, like } from "drizzle-orm";
import { z } from "zod";
import { authoredDocs, docTemplates, getDb, memories, withOrgContext } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { runtimeAiConfig } from "@/server/ai-settings";
import { resolveClient } from "@chaste/ai";
import { generateWithCodingPlanText } from "@/server/coding-agent-adapter";

/**
 * AI writing assist for authored documents (Phase 4). Selection actions,
 * continue-drafting, template prefill grounded in org memory, and
 * chat-with-document. Read-shaped: the model returns text, the editor
 * decides where it lands; nothing here mutates a document.
 *
 * Auth + basic rate sanity only; the capability pipeline is not involved
 * because these calls neither change org state nor touch the ledger - they
 * are the model speaking back to the person already typing.
 */

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("selection"),
    action: z.enum(["improve", "grammar", "tone", "shorten", "expand", "translate"]),
    text: z.string().min(1).max(12_000),
    language: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal("continue"),
    before: z.string().max(12_000),
    after: z.string().max(4_000).optional(),
  }),
  z.object({ kind: z.literal("prefill"), templateId: z.string().uuid() }),
  z.object({
    kind: z.literal("chat"),
    documentId: z.string().uuid(),
    question: z.string().min(1).max(2_000),
  }),
]);

const ACTION_PROMPTS: Record<string, string> = {
  improve: "Improve the writing: clearer, tighter, better flow. Keep the meaning and the language.",
  grammar: "Fix grammar, spelling and punctuation only. Do not change style or meaning.",
  tone: "Rewrite in a professional, warm and confident business tone. Keep the meaning.",
  shorten: "Say the same thing in fewer words. Keep every essential fact.",
  expand: "Expand this with useful detail and specificity, without inventing facts, numbers or commitments.",
  translate: "Translate the text as instructed by the language field. Reply with only the translation.",
};

/** Plain text out of a Tiptap JSON tree. */
export function docPlainText(content: unknown): string {
  let out = "";
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === "text" && n.text) out += n.text + " ";
    else if (n.type === "paragraph" || n.type === "heading") out += "\n";
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(content);
  return out.replace(/[ \t]+/g, " ").trim();
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const runtime = await runtimeAiConfig(db, resolved.orgId, resolved.userId);
  const fastModel = runtime.models.fast;
  const call = async (system: string, user: string): Promise<string> => {
    if (runtime.codingAgentConnection) {
      return (await generateWithCodingPlanText({ db, connection: runtime.codingAgentConnection, system, prompt: user })).text;
    }
    const res = await resolveClient(fastModel, runtime.runtime).chat.completions.create({
      model: fastModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 2_000,
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  };

  try {
    switch (parsed.data.kind) {
      case "selection": {
        const instruction =
          parsed.data.action === "translate"
            ? `Translate the text into ${parsed.data.language ?? "English"}. Reply with only the translation.`
            : ACTION_PROMPTS[parsed.data.action]!;
        const text = await call(
          "You are a precise writing assistant inside a business document editor. Reply with ONLY the rewritten text, no preamble, no quotes around it.",
          `${instruction}\n\n---\n${parsed.data.text}`,
        );
        if (!text) return NextResponse.json({ error: "the model returned nothing, try again" }, { status: 502 });
        return NextResponse.json({ ok: true, text });
      }
      case "continue": {
        const text = await call(
          "You continue the user's business document. Continue naturally from where the text stops, matching its tone and formatting. Reply with ONLY the continuation, 1-3 sentences unless more is obviously needed.",
          `${parsed.data.before}${parsed.data.after ? `\n[...]\n${parsed.data.after}` : ""}`,
        );
        if (!text) return NextResponse.json({ error: "the model returned nothing, try again" }, { status: 502 });
        return NextResponse.json({ ok: true, text });
      }
      case "prefill": {
        const { templateId } = parsed.data;
        return withOrgContext(db, resolved.orgId, async () => {
          const [tpl] = await db
            .select({ id: docTemplates.id, name: docTemplates.name, contentJson: docTemplates.contentJson, placeholders: docTemplates.placeholders })
            .from(docTemplates)
            .where(and(eq(docTemplates.id, templateId), eq(docTemplates.orgId, resolved.orgId!)))
            .limit(1);
          if (!tpl) return NextResponse.json({ error: "template not found" }, { status: 404 });
          const placeholders = (tpl.placeholders as string[]) ?? [];
          if (placeholders.length === 0) return NextResponse.json({ ok: true, values: {} });

          const facts = await db
            .select({ content: memories.content })
            .from(memories)
            .where(and(eq(memories.orgId, resolved.orgId!), like(memories.kind, "%profile%")))
            .limit(6);
          const known = facts.map((f) => f.content).join("\n");
          const raw = await call(
            "You fill in document template placeholders for a business. Use ONLY the facts provided; if a value is unknown, use an empty string. " +
              "Reply with ONLY a JSON object mapping placeholder path to string value.",
            `Business facts:\n${known || "(none recorded)"}\n\nTemplate: ${tpl.name}\nPlaceholders: ${placeholders.join(", ")}`,
          );
          const start = raw.indexOf("{");
          const end = raw.lastIndexOf("}");
          if (start === -1 || end === -1) return NextResponse.json({ ok: true, values: {} });
          try {
            const values = JSON.parse(raw.slice(start, end + 1)) as Record<string, string>;
            const safe = Object.fromEntries(
              placeholders.filter((p) => typeof values[p] === "string").map((p) => [p, values[p]!]),
            );
            return NextResponse.json({ ok: true, values: safe });
          } catch {
            return NextResponse.json({ ok: true, values: {} });
          }
        });
      }
      case "chat": {
        const [doc] = await db
          .select({ title: authoredDocs.title, contentJson: authoredDocs.contentJson })
          .from(authoredDocs)
          .where(and(eq(authoredDocs.id, parsed.data.documentId), eq(authoredDocs.orgId, resolved.orgId)))
          .limit(1);
        if (!doc) return NextResponse.json({ error: "document not found" }, { status: 404 });
        const docText = docPlainText(doc.contentJson).slice(0, 12_000);
        if (!docText) return NextResponse.json({ error: "the document is empty" }, { status: 422 });
        const answer = await call(
          "Answer questions about the document the user is writing. Ground every answer in the document; say honestly when it does not contain the answer. Be concise.",
          `Document "${doc.title}":\n${docText}\n\nQuestion: ${parsed.data.question}`,
        );
        return NextResponse.json({ ok: true, text: answer });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "assist failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
