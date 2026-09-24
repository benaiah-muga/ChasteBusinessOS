import { and, eq, inArray } from "drizzle-orm";
import { docTemplates, withOrgContext, type Database } from "@chaste/db";
import { DOCUMENT_TEMPLATE_CATALOG, templateKit as kit } from "@/lib/document-templates";

/**
 * Built-in templates seed an org's gallery on first visit, and refresh when
 * their design moves on (system templates are code-owned; custom templates
 * are never touched). This is provisioning, not a business state change, so
 * it writes directly under RLS (platform seam, recorded in docs/UX_TRUST_PLAN.md
 * 1.4). Custom templates made by people or the agent always go through the
 * governed documents.createTemplate capability.
 */

const ph = (token: string) => `{{${token}}}`;

const RETIRED_REFERENCE_TEMPLATE_NAMES = [
  "Quote",
  "Quotation - Clean estimate", "Quotation - Detailed scope", "Quotation - Retainer",
  "Receipt - Counter sale", "Receipt - Service payment", "Receipt - Deposit received",
  "Sales invoice - Standard", "Sales invoice - Milestone", "Sales invoice - Tax summary",
  "Delivery note - Standard", "Delivery note - Partial shipment", "Delivery note - Signed handoff",
];

export interface BuiltinTemplate {
  name: string;
  description: string;
  contentJson: unknown;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: "Blank note",
    description: "An empty page with a title, for anything",
    contentJson: kit.doc(kit.h(1, ph("doc.title")), kit.p()),
  },
  {
    name: "Business letter",
    description: "Formal letter with date, recipient and signature blocks",
    contentJson: kit.doc(
      kit.letterhead("BUSINESS LETTER", ["Ref. " + ph("letter.reference"), "Date: " + ph("document.date")]),
      kit.rule,
      kit.parties(kit.party("TO", [ph("recipient.name"), ph("recipient.address")])),
      kit.p(""),
      kit.p(`Dear ${ph("recipient.name")},`),
      kit.p(ph("letter.body")),
      kit.p(""),
      kit.signatures(["WRITTEN BY", ph("sender.name"), ph("sender.title")], ["COUNTERSIGNED", ph("reviewer.name"), "Reviewer"]),
    ),
  },
  {
    name: "Meeting notes",
    description: "Attendees, agenda, decisions and action items",
    contentJson: kit.doc(
      kit.letterhead("MEETING NOTES", ["Date: " + ph("meeting.date"), "Recorded by: " + ph("meeting.recorder")]),
      kit.rule,
      kit.parties(kit.party("TOPIC", [ph("meeting.topic")]), kit.party("ATTENDEES", [ph("meeting.attendees")])),
      kit.h(2, "Agenda"),
      kit.p(ph("meeting.agenda")),
      kit.h(2, "Decisions"),
      kit.p(ph("meeting.decisions")),
      kit.h(2, "Action items"),
      kit.p(ph("meeting.actions")),
    ),
  },
  {
    name: "Quote",
    description: "A minimal one-page price quote with an item table and total",
    contentJson: kit.doc(
      kit.letterhead("QUOTATION", ["No. " + ph("quote.number"), "Date: " + ph("document.date"), "Valid until: " + ph("quote.validUntil")]),
      kit.rule,
      kit.parties(kit.party("PREPARED FOR", [ph("customer.name"), ph("customer.email")])),
      kit.dataTable(["Description", "Qty", "Rate", "Amount"], kit.itemRows("quote")),
      kit.totals([["Total", ph("quote.total")]]),
      kit.p("Prices exclude taxes where applicable."),
      kit.signatures(["ISSUED BY", ph("sender.name")], ["ACCEPTED BY", ph("customer.name")]),
    ),
  },
  ...DOCUMENT_TEMPLATE_CATALOG.map((template) => ({
    name: template.name,
    description: template.description,
    contentJson: template.contentJson,
  })),
];

/** Idempotent: adds missing built-ins and refreshes outdated system ones. */
export async function ensureBuiltinTemplates(db: Database["db"], orgId: string): Promise<void> {
  return withOrgContext(db, orgId, async (tx) => {
    await tx.delete(docTemplates).where(and(eq(docTemplates.orgId, orgId), eq(docTemplates.isSystem, "system"), inArray(docTemplates.name, RETIRED_REFERENCE_TEMPLATE_NAMES)));
    const existing = await tx
      .select({
        id: docTemplates.id,
        name: docTemplates.name,
        contentJson: docTemplates.contentJson,
        isSystem: docTemplates.isSystem,
      })
      .from(docTemplates)
      .where(eq(docTemplates.orgId, orgId));
    const names = new Set(existing.map((row) => row.name));
    const systemByName = new Map(existing.filter((row) => row.isSystem === "system").map((row) => [row.name, row]));

    const missing = BUILTIN_TEMPLATES.filter((template) => !names.has(template.name));
    if (missing.length > 0) {
      await tx.insert(docTemplates).values(
        missing.map((t) => ({
          orgId,
          name: t.name,
          description: t.description,
          contentJson: t.contentJson as Record<string, unknown>,
          placeholders: extractTemplatePlaceholders(t.contentJson),
          isSystem: "system",
        })),
      );
    }

    for (const template of BUILTIN_TEMPLATES) {
      const row = systemByName.get(template.name);
      if (!row || JSON.stringify(row.contentJson) === JSON.stringify(template.contentJson)) continue;
      await tx
        .update(docTemplates)
        .set({
          description: template.description,
          contentJson: template.contentJson as Record<string, unknown>,
          placeholders: extractTemplatePlaceholders(template.contentJson),
        })
        .where(eq(docTemplates.id, row.id));
    }
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
