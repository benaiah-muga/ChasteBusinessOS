/**
 * Platform module catalog: the switchboard of what an organization runs.
 * Client-safe constants (no server imports) so the nav, the settings UI,
 * and server-side enforcement share one source of truth.
 *
 * Enforcement lives at the kernel executor (`organizations.enabled_modules`),
 * so a disabled module disappears from human routes, agent tool lists, and
 * the job queue simultaneously. NULL in the database means "all of these".
 */
export interface ModuleInfo {
  id: string;
  label: string;
  description: string;
  /** Primary page; null for headless modules reachable through others. */
  href: string | null;
}

export const MODULE_CATALOG: ModuleInfo[] = [
  { id: "accounting", label: "Accounting", description: "Ledger, invoicing, bills, payments, reports", href: "/accounting" },
  { id: "analytics", label: "Analytics", description: "Governed datasets, charts, downloadable reports", href: "/analytics" },
  { id: "pos", label: "Point of sale", description: "Register sessions and instant sales", href: "/pos" },
  { id: "inventory", label: "Inventory", description: "Stock ledger, valuation, counting, reorder alerts", href: "/inventory" },
  { id: "manufacturing", label: "Manufacturing", description: "BOMs, work orders, production runs, traceability", href: "/manufacturing" },
  { id: "purchasing", label: "Purchasing", description: "Vendors, purchase orders, receipts, bills, AP aging", href: "/purchasing" },
  { id: "crm", label: "CRM", description: "Customers and deal pipeline", href: "/crm" },
  { id: "documents", label: "Documents", description: "Ingestion, OCR, coding suggestions, org memory", href: "/documents" },
  { id: "hr", label: "HR & Payroll", description: "Employees, leave, payroll runs", href: "/hr" },
  { id: "messaging", label: "Messages", description: "Internal channels and DMs with agent participation", href: "/messages" },
  { id: "support", label: "Customer care", description: "Support desk with AI-drafted replies", href: "/support" },
  { id: "creator", label: "Creator & marketplace", description: "Capability proposals and signed plugins", href: "/proposals" },
];

export const ALL_MODULE_IDS = MODULE_CATALOG.map((m) => m.id);

/** The effective enabled set for an org row value (null = everything). */
export function resolveEnabledModules(value: string[] | null | undefined): Set<string> {
  if (!value) return new Set(ALL_MODULE_IDS);
  return new Set(value.filter((id) => ALL_MODULE_IDS.includes(id)));
}
