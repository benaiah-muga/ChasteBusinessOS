"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/client";
import { EnabledModulesProvider } from "./_shell/module-context";
import { resolveEnabledModules } from "./_shell/modules";
import { resolveApp, tileStyle } from "./_shell/apps";
import { usePinnedApps } from "./_shell/pins";
import { recordAppVisit, useRecentApps } from "./_shell/recent-apps";
import { CommandPalette } from "./command-palette";
import { NotificationsBell } from "./notifications-bell";
import { ChatWidget } from "./chat-widget";
import { useChatDockMode } from "./chat-widget-state";
import { AppsLauncher } from "./apps-launcher";
import {
  IconFileText,
  IconGrid,
  IconInbox,
  IconLogOut,
  IconMessage,
  IconSearch,
  IconSettings,
  IconSparkle,
} from "@/components/icons";
import { Avatar } from "@/components/ui";
import { ThemeMenu } from "@/components/theme";
import { cn } from "@/lib/format";

const authClient = createAuthClient();

interface ShellProps {
  children: ReactNode;
  user: { name: string; email: string };
  orgName: string;
  pendingApprovals: number;
  /** Server-rendered org switcher form (server action). */
  orgSwitcher?: ReactNode;
  /** The org's module switchboard; null means every standard module. */
  enabledModules: string[] | null;
}

export function AppShell({ children, user, orgName, pendingApprovals, orgSwitcher, enabledModules }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const dockMode = useChatDockMode();
  const chatPinned = dockMode === "pinned";
  const inputMode = dockMode === "input";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLauncherOpen(false);
        setPaletteOpen((v) => !v);
      }
      // ⌘G — the launcher. G for "go", same muscle memory as the browser.
      if (e.key.toLowerCase() === "g") {
        e.preventDefault();
        setPaletteOpen(false);
        setLauncherOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const app = resolveApp(pathname);
    if (app && app.href !== "/") recordAppVisit(app.href);
  }, [pathname]);

  useEffect(() => {
    if (!accountOpen) return;
    function onDown(e: PointerEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [accountOpen]);

  const enabled = resolveEnabledModules(enabledModules);
  const currentApp = resolveApp(pathname);

  async function signOut() {
    await authClient.signOut();
    window.location.href = "/login";
  }

  function railButton(label: string, icon: ReactNode, onClick: () => void, opts?: { active?: boolean; badge?: number; hint?: string }) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-current={opts?.active ? "page" : undefined}
        data-active={opts?.active ? "true" : undefined}
        className="rail-btn"
      >
        {icon}
        <span aria-hidden="true" className="rail-tip">
          {label}
          {opts?.hint && (
            <>
              {" · "}
              <kbd>{opts.hint}</kbd>
            </>
          )}
        </span>
        {!!opts?.badge && opts.badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-maroon-700 px-1 text-[9px] leading-4 font-bold text-white">
            {opts.badge > 9 ? "9+" : opts.badge}
          </span>
        )}
      </button>
    );
  }

  const pinned = usePinnedApps()
    .map((id) => resolveApp(id))
    .filter((a): a is NonNullable<typeof a> => !!a);

  // Three most-recently-used apps that aren't already pinned join the rail.
  const mru = useRecentApps()
    .filter((href) => href !== "/" && !pinned.some((p) => p.href === href))
    .slice(0, 3)
    .map((href) => resolveApp(href))
    .filter((a): a is NonNullable<typeof a> => !!a);

  const railTile = (app: NonNullable<ReturnType<typeof resolveApp>>) => {
    const active = pathname === app.href;
    return (
      <Link
        key={app.id}
        href={app.href}
        aria-label={app.name}
        aria-current={active ? "page" : undefined}
        data-active={active ? "true" : undefined}
        className="rail-btn"
      >
        <span
          aria-hidden="true"
          style={tileStyle(app.hue)}
          className="flex size-6 items-center justify-center rounded-md"
        >
          <app.icon className="size-3.5" />
        </span>
        <span aria-hidden="true" className="rail-tip">
          {app.name}
        </span>
      </Link>
    );
  };

  const rail = (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-14 flex-col items-center gap-1 border-r border-stone-200 bg-white py-3 lg:flex">
      <Link
        href="/"
        aria-label={`Home · ${orgName || "Chaste"}`}
        aria-current={pathname === "/" ? "page" : undefined}
        className="rail-btn group mb-2 bg-maroon-950 text-[15px] font-bold text-white shadow-xs transition-transform duration-150 hover:scale-105 hover:bg-maroon-900 hover:text-white"
      >
        C
        <span aria-hidden="true" className="rail-tip">
          Home{orgName ? ` · ${orgName}` : ""}
        </span>
      </Link>

      {railButton("Apps", <IconGrid className="size-5" />, () => setLauncherOpen((v) => !v), {
        active: launcherOpen,
        hint: "⌘G",
      })}
      {railButton("Search", <IconSearch className="size-5" />, () => setPaletteOpen(true), { hint: "⌘K" })}
      {railButton("Approvals", <IconInbox className="size-5" />, () => router.push("/approvals"), {
        active: pathname === "/approvals",
        badge: pendingApprovals,
      })}

      {/* Pinned favorites and recent apps — the daily drivers, one click away */}
      {(pinned.length > 0 || mru.length > 0) && (
        <div className="mt-2 flex flex-col items-center gap-1">
          <span aria-hidden="true" className="mb-1 h-px w-6 bg-stone-200" />
          {pinned.map(railTile)}
          {mru.length > 0 && pinned.length > 0 && (
            <span aria-hidden="true" className="my-1 h-px w-6 bg-stone-100" />
          )}
          {mru.map(railTile)}
        </div>
      )}

      <div className="mt-auto flex flex-col items-center gap-1">
        <NotificationsBell align="left" />
        {railButton("Settings", <IconSettings className="size-5" />, () => router.push("/settings"), {
          active: pathname === "/settings",
        })}
        <button
          type="button"
          onClick={() => {
            // Toggle the workmate between pinned dock and quiet bubble.
            import("./chat-widget-state").then(({ chatDock }) => {
              chatDock.set(dockMode === "pinned" || dockMode === "open" ? "bubble" : "pinned");
            });
          }}
          aria-label="Your AI workmate"
          data-active={chatPinned ? "true" : undefined}
          className="rail-btn"
        >
          <IconSparkle className="size-5" />
          <span aria-hidden="true" className="rail-tip">
            AI workmate
          </span>
        </button>
        <ThemeMenu />

        <div ref={accountRef} className="relative mt-1">
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-label="Account"
            className="group flex cursor-pointer rounded-full ring-2 ring-transparent transition-shadow duration-150 hover:ring-stone-300"
          >
            <Avatar name={user.name} />
            <span aria-hidden="true" className="rail-tip">
              {user.name || "Account"}
            </span>
          </button>
          {accountOpen && (
            <div
              role="menu"
              aria-label="Account"
              className="overlay-panel absolute bottom-11 left-2 z-50 w-56 rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl"
            >
              <div className="border-b border-stone-100 px-2 pt-1 pb-2">
                <p className="truncate text-sm font-medium text-stone-900">{user.name || "Account"}</p>
                <p className="truncate text-xs text-stone-400">{user.email}</p>
              </div>
              {orgSwitcher && (
                // The switcher is a server-rendered form; keep clicks inside it
                // from closing the menu before the transition runs.
                <div className="px-1.5 py-2" onClick={(e) => e.stopPropagation()}>
                  {orgSwitcher}
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={signOut}
                className="mt-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-stone-700 transition-colors duration-75 hover:bg-stone-100"
              >
                <IconLogOut className="size-3.5" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );

  return (
    <EnabledModulesProvider value={enabledModules}>
      <div className="min-h-screen">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-maroon-700 focus:px-3 focus:py-1.5 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>

        {rail}

        <div className={cn("transition-[padding] duration-200 lg:pl-14", chatPinned && "lg:pr-[380px]")}>
          {/* Mobile top bar: the rail collapses into it */}
          <header className="sticky top-0 z-20 flex h-12 items-center gap-1 border-b border-stone-200 bg-white/90 px-2 backdrop-blur lg:hidden">
            <Link
              href="/"
              aria-label="Home"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-maroon-950 text-sm font-bold text-white"
            >
              C
            </Link>
            <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold tracking-tight text-stone-900">
              {currentApp?.name || orgName || "Chaste"}
            </span>
            <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Search" className="icon-btn">
              <IconSearch className="size-5" />
            </button>
            <NotificationsBell align="right" />
            <Link
              href="/approvals"
              aria-label={`Approvals${pendingApprovals ? `, ${pendingApprovals} pending` : ""}`}
              className="icon-btn relative"
            >
              <IconInbox className="size-5" />
              {pendingApprovals > 0 && (
                <span className="absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-maroon-700 text-[8px] font-bold text-white">
                  {pendingApprovals > 9 ? "9+" : pendingApprovals}
                </span>
              )}
            </Link>
            <button type="button" onClick={() => setLauncherOpen(true)} aria-label="Applications" className="icon-btn">
              <IconGrid className="size-5" />
            </button>
          </header>

          <main
            id="main"
            className={cn("mx-auto max-w-7xl px-4 py-6 pb-24 sm:px-6 sm:py-8 lg:px-8 lg:pb-8", inputMode && "pb-36 lg:pb-32")}
          >
            {children}
          </main>

          {/* Mobile bottom navigation: the four anchors, thumb-reachable */}
          <nav
            aria-label="Primary"
            className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-stone-200 bg-white/95 backdrop-blur lg:hidden"
          >
            {(
              [
                ["/", "Home", IconGrid],
                ["/documents", "Documents", IconFileText],
                ["/messages", "Messages", IconMessage],
                ["/settings", "Settings", IconSettings],
              ] as const
            ).map(([href, label, NavIcon]) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors duration-100",
                    active ? "text-maroon-800" : "text-stone-400 hover:text-stone-600",
                  )}
                >
                  <NavIcon className="size-5" />
                  {label}
                  {active && (
                    <span aria-hidden="true" className="absolute top-0 h-0.5 w-8 rounded-full bg-maroon-700" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} enabledModules={enabled} />
        <AppsLauncher open={launcherOpen} onClose={() => setLauncherOpen(false)} enabledModules={enabled} />
        <ChatWidget />
      </div>
    </EnabledModulesProvider>
  );
}
