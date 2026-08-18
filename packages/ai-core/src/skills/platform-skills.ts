import type { SkillRecord } from "../skills.js";

/**
 * Platform-bundled module skills (research doc §Module skills for steering
 * model accuracy). Each skill is a small, domain-scoped doctrine: which bus
 * tools belong to that domain, how to resolve names → ids, and the
 * check-then-write rule (never create an entity that already exists — the
 * natural-key existence gate enforces it mechanically, the skill steers the
 * model to rely on it). Seeded as read-only platform-scoped skills so the
 * per-turn catalog and `loadSkill` see them without a DB migration.
 */

export interface PlatformSkillDef {
  name: string;
  title: string;
  summary: string;
  /** Lowercased substrings that route a request to this skill. */
  keywords: string[];
  instructions: string;
}

export const PLATFORM_SKILL_DEFS: PlatformSkillDef[] = [
  {
    name: "platform.purchasing",
    title: "Purchasing — vendors and purchase orders",
    summary: "Vendors and POs: resolve the vendor via pur.po.list, never re-create an existing vendor.",
    keywords: ["vendor", "vendors", "purchase order", "purchase orders", "po ", "procurement", "supplier", "suppliers"],
    instructions:
      "Domain: purchasing (pur.*).\n" +
      "- Discover vendors with pur.po.list (returns vendors + orders). Resolve a vendor's name to its id from that result before any write.\n" +
      "- pur.vendor.create: only for a vendor that does NOT already exist. The existence gate skips the call and tells you the existing id if it does — reuse that record, never fight the gate.\n" +
      "- pur.po.create: requires a real vendorId (never invented) and a total; a generated number is optional.\n" +
      "- Read questions about what was ordered or from whom are answered from pur.po.list, not by inventing numbers.",
  },
  {
    name: "platform.sales",
    title: "Sales — customers and invoicing",
    summary: "Customers and invoices: resolve the customer via crm.customer.list, never re-create an existing customer.",
    keywords: ["customer", "customers", "invoice", "invoices", "inv-", "bill", "billing", "raise an invoice"],
    instructions:
      "Domain: sales & billing (crm.customer.*, acc.invoice.*).\n" +
      "- Discover customers with crm.customer.list (search by name). Resolve a customer's name to its id before writing an invoice.\n" +
      "- crm.customer.create: only for a customer that does NOT already exist. The existence gate skips the call if it does — reuse the existing record.\n" +
      "- acc.invoice.create: requires a real customerId (never invented) plus a number and total.\n" +
      "- Answer sales questions from crm.customer.list / acc.invoice.list with real org data.",
  },
  {
    name: "platform.inventory",
    title: "Inventory — products, warehouses, stock",
    summary: "Products and stock: resolve skus via inv.stock.list, never re-create an existing product.",
    keywords: ["inventory", "stock", "product", "products", "sku", "warehouse", "warehouses", "restock", "replenish"],
    instructions:
      "Domain: inventory (inv.*).\n" +
      "- Discover products/warehouses with inv.stock.list (returns warehouses, products, levels). Resolve sku/name to id from it.\n" +
      "- inv.product.create: only for a product whose sku does NOT already exist; the existence gate skips duplicates and reports the existing id.\n" +
      "- inv.warehouse.create: requires a unique code; check core.branch-style codes via inv.stock.list warehouses first.\n" +
      "- inv.stock.adjust: needs a real warehouseId + productId — never invent them.\n" +
      "- Restock/replenishment questions are answered from inv.stock.list / core.replenishment.propose, never invented.",
  },
  {
    name: "platform.accounting",
    title: "Accounting — accounts, invoices, journal",
    summary: "Chart of accounts and postings: resolve codes via acc.account.list, never re-create an existing account.",
    keywords: ["account", "accounts", "journal", "post", "gl", "chart of accounts", "ledger", "double entry", "debit", "credit"],
    instructions:
      "Domain: accounting (acc.*).\n" +
      "- Discover accounts with acc.account.list (code + name). Resolve code/name to id before posting.\n" +
      "- acc.account.create: only for a code that does NOT already exist; the gate skips duplicates and reports the existing id.\n" +
      "- acc.invoice.create / acc.journal.post: require real accountIds and customerIds — never invent them. If the request references a name, resolve it via the list tool first.\n" +
      "- Answer accounting questions from acc.account.list / acc.invoice.list with real org data.",
  },
  {
    name: "platform.crm",
    title: "CRM — customers, contacts, interactions",
    summary: "Relationships: resolve customers via crm.customer.list, never re-create an existing customer.",
    keywords: ["crm", "lead", "leads", "contact", "contacts", "interaction", "follow up", "follow-up", "relationship"],
    instructions:
      "Domain: crm (crm.*).\n" +
      "- Discover customers/contacts with crm.customer.list / crm.contact.list. Resolve names to ids before logging interactions.\n" +
      "- crm.customer.create / crm.contact.create: only for records that do NOT already exist; the gate skips duplicates and reports the existing id.\n" +
      "- crm.interaction.log: needs a real customerId — never invent it.\n" +
      "- Answer CRM questions from the list queries with real org data.",
  },
  {
    name: "platform.hr",
    title: "HR & payroll — employees, payroll",
    summary: "People ops: resolve employees via the HR read path, never invent ids.",
    keywords: ["employee", "employees", "staff", "payroll", "salary", "hire", "hiring", "hr"],
    instructions:
      "Domain: hr & payroll (hr.*).\n" +
      "- Discover employees via the HR read path before any write.\n" +
      "- hr.employee.create: only for a person not already on the books; if the gate reports an existing record, reuse it.\n" +
      "- hr.payroll.prepare: runs against real employee records — never invent names or ids.",
  },
  {
    name: "platform.manufacturing",
    title: "Manufacturing — BOMs and work orders",
    summary: "Production: resolve products via inv.stock.list, never invent ids.",
    keywords: ["manufactur", "work order", "work orders", "wo", "bom", "bill of material", "production"],
    instructions:
      "Domain: manufacturing (mfg.*).\n" +
      "- Resolve products via inv.stock.list before mfg.bom.create / mfg.wo.create — never invent productIds.\n" +
      "- Work orders reference a real product and BOM; gather them with reads first.",
  },
  {
    name: "platform.operations",
    title: "Operations — users, roles, branches, partners, settings, workflows, messaging",
    summary: "Platform admin: resolve branches/codes via core.branch.list, never re-create existing codes.",
    keywords: ["user", "users", "role", "roles", "permission", "branch", "branches", "business partner", "partner",
      "setting", "settings", "module", "backup", "workflow", "reminder", "reminders", "followup", "message",
      "apikey", "api key", "invite", "activate", "deactivate", "grant", "revoke"],
    instructions:
      "Domain: operations & platform admin (core.*, messaging.*, workflow.*).\n" +
      "- core.branch.create: requires a unique code (checked by the DB + the existence gate); core.branch.list shows existing branches.\n" +
      "- core.bpartner.create: only when core.bpartner.list shows the partner does not exist; the gate skips duplicates and reports the existing id.\n" +
      "- core.user.create / core.role.create / core.settings.update / module ops / backups: use the exact command and real ids; never invent ids or field names.\n" +
      "- Reminders/follow-ups/messages: prefer the dedicated command (core.reminder.set, core.followup.create, messaging.thread.send) over generic writes.",
  },
];

export function platformSkillRecords(): SkillRecord[] {
  const now = new Date().toISOString();
  return PLATFORM_SKILL_DEFS.map((d) => ({
    name: d.name,
    scope: "platform" as const,
    title: d.title,
    summary: d.summary,
    instructions: d.instructions,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * Deterministic domain routing: which platform skills apply to a user's
 * request, based on lowercase keyword substrings. Cheap, no LLM, no extra
 * latency. Returns the matching skill defs in declaration order.
 */
export function routeDomain(message: string): PlatformSkillDef[] {
  const lower = message.toLowerCase();
  return PLATFORM_SKILL_DEFS.filter((d) => d.keywords.some((k) => lower.includes(k)));
}

/**
 * Inline domain doctrine for a request, appended to the loop system prompt so
 * the matched module's tool-selection guidance steers the model BEFORE it
 * calls any tool. Empty string when no domain matched.
 */
export function domainDoctrineText(message: string): string {
  const matched = routeDomain(message);
  if (matched.length === 0) return "";
  return (
    "\nDomain doctrine for this request — follow it when choosing tools and proposing writes:\n" +
    matched.map((d) => `### ${d.name} — ${d.title}\n${d.instructions}`).join("\n\n")
  );
}