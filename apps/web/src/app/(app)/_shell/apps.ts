/**
 * The application catalog: every business module is an independent app with
 * its own identity. This is the single source shared by the Apps Launcher,
 * the command palette, and the OS rail.
 */
import type { ComponentType, CSSProperties, SVGProps } from "react";
import {
  IconBox,
  IconCart,
  IconChartBar,
  IconFactory,
  IconFileText,
  IconHash,
  IconLandmark,
  IconLifeBuoy,
  IconListTree,
  IconMessage,
  IconPullRequest,
  IconSend,
  IconSettings,
  IconShieldCheck,
  IconStore,
  IconTrendingUp,
  IconTruck,
  IconUser,
  IconUsers,
} from "@/components/icons";


export interface AppInfo {
  id: string;
  name: string;
  /** One quiet line under the name in the launcher; omitted when noise. */
  tagline: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Per-app tile hue (oklch hue angle). Restrained tint, not decoration. */
  hue: number;
  /** When set, hidden unless this module is enabled for the org. */
  moduleId?: string;
  /** System-level apps render in their own quiet group at the end. */
  system?: boolean;
}

export const APPS: AppInfo[] = [
  { id: "accounting", name: "Accounting", tagline: "Books, invoices, bills, reports", href: "/accounting", icon: IconLandmark, hue: 25, moduleId: "accounting" },
  { id: "crm", name: "CRM", tagline: "Customers & deal pipeline", href: "/crm", icon: IconTrendingUp, hue: 145, moduleId: "crm" },
  { id: "sales", name: "Sales", tagline: "Quotes, orders & customers", href: "/sales", icon: IconSend, hue: 120, moduleId: "sales" },
  { id: "pos", name: "Point of sale", tagline: "Registers & instant sales", href: "/pos", icon: IconCart, hue: 60, moduleId: "pos" },
  { id: "inventory", name: "Inventory", tagline: "Stock, valuation, reordering", href: "/inventory", icon: IconBox, hue: 95, moduleId: "inventory" },
  { id: "products", name: "Products", tagline: "Catalog & pricing", href: "/products", icon: IconStore, hue: 85, moduleId: "inventory" },
  { id: "manufacturing", name: "Manufacturing", tagline: "BOMs & production runs", href: "/manufacturing", icon: IconFactory, hue: 40, moduleId: "manufacturing" },
  { id: "purchasing", name: "Purchasing (Procurement)", tagline: "Vendors & purchase orders", href: "/purchasing", icon: IconTruck, hue: 210, moduleId: "purchasing" },
  { id: "hr", name: "HR & Payroll", tagline: "People, leave, payroll runs", href: "/hr", icon: IconUser, hue: 330, moduleId: "hr" },
  { id: "documents", name: "Documents", tagline: "Ingestion & org memory", href: "/documents", icon: IconFileText, hue: 260, moduleId: "documents" },
  { id: "analytics", name: "Analytics", tagline: "Governed datasets & charts", href: "/analytics", icon: IconChartBar, hue: 190, moduleId: "analytics" },
  { id: "messaging", name: "Messages", tagline: "Channels with agent participation", href: "/messages", icon: IconMessage, hue: 170, moduleId: "messaging" },
  { id: "support", name: "Customer care", tagline: "Support desk, AI-drafted replies", href: "/support", icon: IconLifeBuoy, hue: 15, moduleId: "support" },
  { id: "creator", name: "Creator", tagline: "Capability proposals & plugins", href: "/proposals", icon: IconPullRequest, hue: 280, moduleId: "creator" },
  { id: "approvals", name: "Approvals", tagline: "Actions waiting on you", href: "/approvals", icon: IconShieldCheck, hue: 0, system: true },
  { id: "ledger", name: "Ledger", tagline: "The append-only event trail", href: "/ledger", icon: IconHash, hue: 0, system: true },
  { id: "sessions", name: "Agent sessions", tagline: "What your workmate did", href: "/sessions", icon: IconListTree, hue: 0, system: true },
  { id: "team", name: "Team & roles", tagline: "People and permissions", href: "/team", icon: IconUsers, hue: 0, system: true },
  { id: "settings", name: "Settings", tagline: "Appearance, pins, workspace", href: "/settings", icon: IconSettings, hue: 0, system: true },
];

/** Marketplace is reachable from Creator; keep one entry per surface. */
export function appsForOrg(enabledModules: ReadonlySet<string> | null | undefined): AppInfo[] {
  return APPS.filter((app) => !app.moduleId || !enabledModules || enabledModules.has(app.moduleId));
}

export function appByHref(href: string): AppInfo | undefined {
  return APPS.find((a) => a.href === href);
}

/** Resolves an app by its catalog id or route — callers use whichever is at hand. */
export function resolveApp(idOrHref: string): AppInfo | undefined {
  return APPS.find((a) => a.id === idOrHref || a.href === idOrHref);
}

/** Tile background/foreground pair derived from the app's hue — quiet by design. */
export function tileStyle(hue: number): CSSProperties {
  if (hue === 0) {
    // System apps stay neutral: ink on paper, no color claim.
    return { background: "var(--color-stone-100)", color: "var(--color-stone-600)" };
  }
  return {
    background: `oklch(0.955 0.03 ${hue})`,
    color: `oklch(0.45 0.14 ${hue})`,
  };
}