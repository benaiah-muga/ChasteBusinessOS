import type { ComponentType, SVGProps } from "react";
import {
  IconCart,
  IconDashboard,
  IconFileText,
  IconInbox,
  IconLandmark,
  IconListTree,
  IconMessage,
  IconPullRequest,
  IconTrendingUp,
  IconUser,
  IconUsers,
} from "@/components/icons";

// Reuse existing icons for the new surfaces; no bespoke glyphs needed.
const IconBox = IconListTree;
const IconStore = IconCart;

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Shows a count pill; reserved for Approvals. */
  badgeKey?: "approvals";
  /** When set, the item is hidden unless this module is enabled org-wide. */
  moduleId?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Dashboard", icon: IconDashboard },
      { href: "/messages", label: "Messages", icon: IconMessage, moduleId: "messaging" },
      { href: "/support", label: "Customer care", icon: IconInbox, moduleId: "support" },
      { href: "/approvals", label: "Approvals", icon: IconInbox, badgeKey: "approvals" },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/accounting", label: "Accounting", icon: IconLandmark, moduleId: "accounting" },
      { href: "/pos", label: "Point of sale", icon: IconCart, moduleId: "pos" },
      { href: "/inventory", label: "Inventory", icon: IconBox, moduleId: "inventory" },
      { href: "/manufacturing", label: "Manufacturing", icon: IconListTree, moduleId: "manufacturing" },
    ],
  },
  {
    label: "Grow",
    items: [
      { href: "/crm", label: "Pipeline", icon: IconTrendingUp, moduleId: "crm" },
      { href: "/documents", label: "Documents", icon: IconFileText, moduleId: "documents" },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/hr", label: "HR & Payroll", icon: IconUser, moduleId: "hr" },
      { href: "/team", label: "Team & roles", icon: IconUsers },
    ],
  },
  {
    label: "Agent",
    items: [
      { href: "/sessions", label: "Sessions", icon: IconListTree },
      { href: "/proposals", label: "Proposals", icon: IconPullRequest, moduleId: "creator" },
      { href: "/marketplace", label: "Marketplace", icon: IconStore, moduleId: "creator" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
