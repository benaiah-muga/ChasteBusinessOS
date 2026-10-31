import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Gauge,
  Inbox,
  LifeBuoy,
  Radio,
  Settings,
} from "lucide-react";

export type WorkspaceAppTab = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
};

export type WorkspaceApp = {
  id: string;
  moduleId: string;
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
  basePath: string;
  homeHref: string;
  tabs: WorkspaceAppTab[];
};

/**
 * The shell's app surface contract. An installed module can own a complete
 * experience: one entry in the global rail, its own horizontal navigation,
 * and URL-addressable sub-surfaces. Adding the next app should be a registry
 * entry plus its routes, not another pile of global rail links.
 */
export const SUPPORT_APP: WorkspaceApp = {
  id: "support",
  moduleId: "support",
  label: "Customer support",
  shortLabel: "Support",
  description:
    "One desk for every customer conversation, with a human in control.",
  icon: LifeBuoy,
  basePath: "/support",
  homeHref: "/support",
  tabs: [
    {
      id: "inbox",
      label: "Inbox",
      href: "/support/inbox",
      icon: Inbox,
      description: "Every conversation, evidence trail, and handoff.",
    },
    {
      id: "overview",
      label: "Overview",
      href: "/support/overview",
      icon: Gauge,
      description: "What the desk handled and what needs a person.",
    },
    {
      id: "knowledge",
      label: "Knowledge",
      href: "/support/knowledge",
      icon: BookOpen,
      description: "Quick replies and articles the AI drafts from.",
    },
    {
      id: "channels",
      label: "Channels",
      href: "/support/channels",
      icon: Radio,
      description: "Where customers reach you and how the AI behaves.",
    },
    {
      id: "settings",
      label: "Settings",
      href: "/support/settings",
      icon: Settings,
      description:
        "Desk configuration, channels, notifications, and shared settings.",
    },
  ],
};

export const WORKSPACE_APPS: WorkspaceApp[] = [SUPPORT_APP];

export function appForPath(pathname: string): WorkspaceApp | null {
  return (
    WORKSPACE_APPS.find(
      (app) =>
        pathname === app.basePath || pathname.startsWith(`${app.basePath}/`),
    ) ?? null
  );
}

export function isAppTabActive(
  tab: WorkspaceAppTab,
  pathname: string,
): boolean {
  if (tab.id === "inbox" && tab.href === "/support/inbox") {
    return (
      pathname === "/support" ||
      pathname === "/support/inbox" ||
      pathname.startsWith("/support/inbox/")
    );
  }
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

export function appTabForPath(
  app: WorkspaceApp,
  pathname: string,
): WorkspaceAppTab {
  return (
    [...app.tabs]
      .sort((left, right) => right.href.length - left.href.length)
      .find((tab) => isAppTabActive(tab, pathname)) ?? app.tabs[0]!
  );
}

export function appRouteMeta(
  pathname: string,
): { label: string; group: string; description: string } | null {
  const app = appForPath(pathname);
  if (!app) return null;
  const tab = appTabForPath(app, pathname);
  return { label: tab.label, group: app.label, description: tab.description };
}

const UUID_PATH =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appPathPattern(pathname: string): boolean {
  return WORKSPACE_APPS.some((app) => {
    if (pathname === app.basePath) return true;
    return app.tabs.some((tab) => {
      if (pathname === tab.href) return true;
      return (
        tab.id === "inbox" &&
        new RegExp(`^${escapeRegExp(tab.href)}/${UUID_PATH}$`, "i").test(
          pathname,
        )
      );
    });
  });
}
