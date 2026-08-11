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
  /**
   * Optional sub-bucket within a group (used by the System tab to cluster
   * admin links without listing 10 flat peers).
   */
  section?: "communicate" | "people" | "platform";
  /** Always show even if not installed (platform pages). */
  always?: boolean;
  /**
   * Rendered outside the group sections, pinned to the sidebar footer
   * (e.g. Settings). Kept in the nav so titles/icons resolve.
   */
  pinned?: boolean;
};

export const MODULE_NAV: ModuleNavItem[] = [
  { moduleId: "dashboard", href: "/", label: "Dashboard", group: "workspace", always: true },
  { moduleId: "workflows", href: "/workflows", label: "Workflows", group: "workspace", always: true },
  { moduleId: "calendar", href: "/calendar", label: "Calendar", group: "workspace", always: true },
  { moduleId: "reminders", href: "/reminders", label: "Reminders", group: "workspace", always: true },
  { moduleId: "messaging", href: "/messaging", label: "Messaging", group: "workspace", section: "communicate" },
  { moduleId: "email", href: "/email", label: "Email", group: "workspace", section: "communicate", always: true },
  { moduleId: "crm", href: "/crm", label: "CRM", group: "business" },
  { moduleId: "accounting", href: "/accounting", label: "Accounting", group: "business" },
  { moduleId: "inventory", href: "/inventory", label: "Inventory", group: "business" },
  { moduleId: "purchasing", href: "/purchasing", label: "Purchasing", group: "business" },
  { moduleId: "hr", href: "/hr", label: "HR", group: "business" },
  { moduleId: "manufacturing", href: "/manufacturing", label: "Manufacturing", group: "business" },
  { moduleId: "directory", href: "/directory", label: "Directory", group: "system", section: "people", always: true },
  { moduleId: "extensions", href: "/extensions", label: "Extensions", group: "system", section: "platform", always: true },
  { moduleId: "settings", href: "/settings", label: "Settings", group: "system", section: "platform", always: true, pinned: true },
];

/** Labels for optional nav sections inside a group tab. */
export const NAV_SECTION_LABELS: Record<NonNullable<ModuleNavItem["section"]>, string> = {
  communicate: "Communicate",
  people: "People & org",
  platform: "Platform",
};

export function filterNavByInstalled(
  installed: { moduleId: string; enabled: boolean }[],
): ModuleNavItem[] {
  const enabled = new Set(
    installed.filter((m) => m.enabled).map((m) => m.moduleId),
  );
  return MODULE_NAV.filter((item) => item.always || enabled.has(item.moduleId));
}
