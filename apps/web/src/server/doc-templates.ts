import { eq } from "drizzle-orm";
import { docTemplates, withOrgContext, type Database } from "@chaste/db";

/**
 * Built-in templates seed an org's gallery on first visit. This is
 * provisioning, not a business state change, so it writes directly under
 * RLS (platform seam, recorded in docs/UX_TRUST_PLAN.md 1.4). Custom
 * templates made by people or the agent always go through the governed
 * documents.createTemplate capability.
 */

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const ph = (token: string) => `{{${token}}}`;
const heading = (level: number, text: string) => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const emptyP = { type: "paragraph" };

const cell = (text: string) => ({ type: "tableCell", content: [p(text)] });
const headerCell = (text: string) => ({ type: "tableHeader", content: [p(text)] });
const row = (cells: ReturnType<typeof cell>[]) => ({ type: "tableRow", content: cells });

const quoteTable = {
  type: "table",
  content: [
    { type: "tableRow", content: [headerCell("Item"), headerCell("Qty"), headerCell("Unit price"), headerCell("Amount")] },
    {
      type: "tableBody",
      content: [row([cell(ph("quote.item")), cell("1"), cell(ph("quote.unitPrice")), cell(ph("quote.amount"))])],
    },
  ],
};

export interface BuiltinTemplate {
  name: string;
  description: string;
  contentJson: unknown;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: "Blank note",
    description: "An empty page with a title, for anything",
    contentJson: { type: "doc", content: [heading(1, ph("doc.title")), emptyP] },
  },
  {
    name: "Business letter",
    description: "Formal letter with date, recipient and signature blocks",
    contentJson: {
      type: "doc",
      content: [
        p(ph("letter.date")),
        emptyP,
        p(ph("recipient.name")),
        p(ph("recipient.address")),
        emptyP,
        p(`Dear ${ph("recipient.name")},`),
        p(ph("letter.body")),
        emptyP,
        p("Sincerely,"),
        p(ph("sender.name")),
        p(ph("sender.title")),
      ],
    },
  },
  {
    name: "Meeting notes",
    description: "Attendees, agenda, decisions and action items",
    contentJson: {
      type: "doc",
      content: [
        heading(1, `Meeting: ${ph("meeting.topic")}`),
        p(`Date: ${ph("meeting.date")}`),
        p(`Attendees: ${ph("meeting.attendees")}`),
        heading(2, "Agenda"),
        p(ph("meeting.agenda")),
        heading(2, "Decisions"),
        p(ph("meeting.decisions")),
        heading(2, "Action items"),
        p(ph("meeting.actions")),
      ],
    },
  },
  {
    name: "Quote",
    description: "Price quotation with an item table and total",
    contentJson: {
      type: "doc",
      content: [
        heading(1, `Quotation ${ph("quote.number")}`),
        p(`For: ${ph("customer.name")}`),
        p(`Valid until: ${ph("quote.validUntil")}`),
        emptyP,
        p("Thank you for your interest. The following prices apply:"),
        quoteTable,
        emptyP,
        p(`Total: ${ph("quote.total")}`),
        p("Prices exclude taxes where applicable."),
      ],
    },
  },
];

/** Idempotent: seeds only while the org has zero templates. */
export async function ensureBuiltinTemplates(db: Database["db"], orgId: string): Promise<void> {
  return withOrgContext(db, orgId, async (tx) => {
    const existing = await tx.select({ id: docTemplates.id }).from(docTemplates).limit(1);
    if (existing.length > 0) return;
    await tx.insert(docTemplates).values(
      BUILTIN_TEMPLATES.map((t) => ({
        orgId,
        name: t.name,
        description: t.description,
        contentJson: t.contentJson as Record<string, unknown>,
        placeholders: extractTemplatePlaceholders(t.contentJson),
        isSystem: "system",
      })),
    );
  });
}

export function extractTemplatePlaceholders(content: unknown): string[] {
  const found = new Set<string>();
  for (const m of JSON.stringify(content).matchAll(/\{\{\s*([a-zA-Z][\w.]{0,60})\s*\}\}/g)) found.add(m[1]!);
  return [...found];
}

export async function orgTemplateCount(db: Database["db"], orgId: string): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await tx.select({ id: docTemplates.id }).from(docTemplates).where(eq(docTemplates.orgId, orgId));
    return rows.length;
  });
}
