/**
 * Frontend module registry.
 *
 * Backend modules live under `modules/<id>` and register commands/queries.
 * The web app discovers installed modules via `GET /api/v1/modules` and maps
 * enabled module ids to routes/navigation here: same puzzle-piece model as
 * Odoo apps, with HTTP as the only boundary.
 */

export type ModuleNavItem = {
  moduleId: string;
  href: string;
  label: string;
  group: "business" | "system" | "workspace";
  /** Always show even if not installed (platform pages). */
  always?: boolean;
};

export const MODULE_NAV: ModuleNavItem[] = [
  { moduleId: "dashboard", href: "/", label: "Dashboard", group: "workspace", always: true },
  { moduleId: "workflows", href: "/workflows", label: "Workflows", group: "workspace", always: true },
  { moduleId: "crm", href: "/crm", label: "CRM", group: "business" },
  { moduleId: "accounting", href: "/accounting", label: "Accounting", group: "business" },
  { moduleId: "inventory", href: "/inventory", label: "Inventory", group: "business" },
  { moduleId: "purchasing", href: "/purchasing", label: "Purchasing", group: "business" },
  { moduleId: "hr", href: "/hr", label: "HR", group: "business" },
  { moduleId: "manufacturing", href: "/manufacturing", label: "Manufacturing", group: "business" },
  { moduleId: "rbac", href: "/rbac", label: "Access control", group: "system", always: true },
  { moduleId: "marketplace", href: "/marketplace", label: "Marketplace", group: "system", always: true },
  { moduleId: "audit", href: "/audit", label: "Activity log", group: "system", always: true },
  { moduleId: "settings", href: "/settings", label: "Settings", group: "system", always: true },
];

export function filterNavByInstalled(
  installed: { moduleId: string; enabled: boolean }[],
): ModuleNavItem[] {
  const enabled = new Set(
    installed.filter((m) => m.enabled).map((m) => m.moduleId),
  );
  return MODULE_NAV.filter((item) => item.always || enabled.has(item.moduleId));
}
