"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createAuthClient } from "better-auth/client";
import { NAV_GROUPS } from "./_shell/nav";
import { EnabledModulesProvider } from "./_shell/module-context";
import { resolveEnabledModules } from "./_shell/modules";
import { CommandPalette } from "./command-palette";
import { NotificationsBell } from "./notifications-bell";
import { ChatWidget } from "./chat-widget";
import { useChatDockMode } from "./chat-widget-state";
import {
  IconInbox,
  IconMenu,
  IconSearch,
  IconSparkle,
  IconLogOut,
  IconX,
} from "@/components/icons";
import { Avatar } from "@/components/ui";
import { cn } from "@/lib/format";

const authClient = createAuthClient();

interface ShellProps {
  children: ReactNode;
  user: { name: string; email: string };
  pendingApprovals: number;
  /** Server-rendered org switcher form (server action). */
  orgSwitcher?: ReactNode;
  /** The org's module switchboard; null means every standard module. */
  enabledModules: string[] | null;
}

export function AppShell({ children, user, pendingApprovals, orgSwitcher, enabledModules }: ShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dockMode = useChatDockMode();
  const chatPinned = dockMode === "pinned";
  // Reserve breathing room above the floating input bar.
  const inputMode = dockMode === "input";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const badges = { approvals: pendingApprovals } as const;

  const enabled = resolveEnabledModules(enabledModules);

  function nav(groups = NAV_GROUPS) {
    return groups.map((group) => {
      const items = group.items.filter(
        (item) => !item.moduleId || enabled.has(item.moduleId),
      );
      if (items.length === 0) return null;
      return (
      <div key={group.label} className="mb-4">
        <p className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">{group.label}</p>
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active = pathname === item.href;
            const count = item.badgeKey ? badges[item.badgeKey] : 0;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-sm font-medium transition-colors duration-100",
                    active ? "bg-maroon-50 text-maroon-800" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900",
                  )}
                >
                  <item.icon className={cn("size-4 shrink-0", active ? "text-maroon-700" : "text-stone-400")} />
                  <span className="flex-1">{item.label}</span>
                  {count > 0 && (
                    <span className="rounded-full bg-maroon-700 px-1.5 py-px text-[10px] leading-4 font-semibold text-white">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      );
    });
  }

  function sidebarBody() {
    return (
      <>
        <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-maroon-800 text-white shadow-xs">
            <IconSparkle className="size-4.5" />
          </span>
          <span className="leading-tight">
            <span className="block text-[15px] font-semibold tracking-tight text-stone-900">Chaste</span>
            <span className="block text-[10px] font-medium tracking-[0.14em] text-stone-400 uppercase">Business OS</span>
          </span>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mb-5 flex w-full cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-sm text-stone-400 transition-colors duration-150 hover:border-stone-300 hover:text-stone-500"
        >
          <IconSearch className="size-3.5" />
          <span className="flex-1 text-left">Jump to…</span>
          <kbd className="kbd">⌘K</kbd>
        </button>

        <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto">
          {nav()}
        </nav>

        <div className="mt-auto space-y-3 border-t border-stone-100 pt-3">
          <div className="flex items-center justify-end px-1">
            <NotificationsBell />
          </div>
          {orgSwitcher}
          <div className="flex items-center gap-2.5 px-1">
            <Avatar name={user.name || user.email} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-medium text-stone-800">{user.name || "Account"}</p>
              <p className="truncate text-xs text-stone-400">{user.email}</p>
            </div>
            <button
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                await authClient.signOut();
                window.location.href = "/login";
              }}
              className="icon-btn"
            >
              <IconLogOut className="size-4" />
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <EnabledModulesProvider value={enabledModules}>
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-maroon-700 focus:px-3 focus:py-1.5 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-stone-200 bg-white px-3 py-4 lg:flex">
        {sidebarBody()}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="overlay-backdrop" onMouseDown={() => setDrawerOpen(false)} />
          <aside className="drawer-panel absolute inset-y-0 left-0 flex w-72 flex-col border-r border-stone-200 bg-white px-3 py-4 shadow-xl">
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
              className="icon-btn absolute top-3 right-3"
            >
              <IconX className="size-4" />
            </button>
            {sidebarBody()}
          </aside>
        </div>
      )}

      <div className={cn("transition-[padding] duration-200 lg:pl-60", chatPinned && "lg:pr-[380px]")}>
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-stone-200 bg-white/90 px-3 backdrop-blur lg:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setDrawerOpen(true)} className="icon-btn">
            <IconMenu className="size-5" />
          </button>
          <Link href="/" className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-stone-900">
            <IconSparkle className="size-4 text-maroon-800" />
            Chaste
          </Link>
          <NotificationsBell />
          <Link
            href="/approvals"
            aria-label={`Approvals${pendingApprovals ? `, ${pendingApprovals} pending` : ""}`}
            className="icon-btn relative"
          >
            <IconInbox className="size-4.5" />
            {pendingApprovals > 0 && (
              <span className="absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-maroon-700 text-[8px] font-bold text-white">
                {pendingApprovals > 9 ? "9+" : pendingApprovals}
              </span>
            )}
          </Link>
        </header>

        <main id="main" className={cn("mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10", inputMode && "pb-32")}>
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} enabledModules={enabled} />
      <ChatWidget />
    </div>
    </EnabledModulesProvider>
  );
}
