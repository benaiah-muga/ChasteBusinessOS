"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { resolveApp, tileStyle } from "./apps";
import { IconChevronLeft } from "@/components/icons";
import { cn } from "@/lib/format";

export interface AppTab {
  id: string;
  label: string;
  /** Optional live count rendered as a quiet pill next to the label. */
  count?: number;
}

/**
 * The frame every application opens into: where am I (breadcrumb), what can
 * this app do (tabs), and what can I do right now (actions). The overview is
 * always the first tab; deeper areas are operation surfaces.
 *
 * With `persistKey`, the chosen tab is remembered per app and initialized
 * from `?tab=` so support workflows can deep-link.
 */
export function AppFrame({
  appId,
  description,
  tabs,
  activeTab,
  onTabChange,
  persistKey,
  actions,
  children,
}: {
  appId: string;
  /** One quiet line of orientation under the app name. */
  description?: string;
  tabs?: AppTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  persistKey?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const app = resolveApp(appId);
  const Icon = app?.icon;

  // Deep link (?tab=) wins on mount; afterwards the last choice is remembered.
  useEffect(() => {
    if (!persistKey || !onTabChange || !activeTab) return;
    const fromUrl = new URLSearchParams(window.location.search).get("tab");
    const known = (id: string | null) => (id && tabs?.some((t) => t.id === id) ? id : null);
    const target = known(fromUrl) ?? (fromUrl ? null : known(localStorage.getItem(`chaste-app-tab:${persistKey}`)));
    if (target && target !== activeTab) onTabChange(target);
    // Run once on mount: URL wins, then the remembered tab.
  }, []);

  useEffect(() => {
    if (!persistKey || !activeTab) return;
    try {
      localStorage.setItem(`chaste-app-tab:${persistKey}`, activeTab);
    } catch {
      // Session-only memory when storage is unavailable.
    }
  }, [persistKey, activeTab]);

  return (
    <div>
      <header className="module-band sticky top-14 z-20 mb-6 rounded-2xl px-4 py-3.5 sm:px-5 lg:top-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            href="/"
            aria-label="Back to dashboard"
            title="Back to dashboard"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[#a9a39b] transition-colors duration-150 hover:bg-white/10 hover:text-[#f7f1e8]"
          >
            <IconChevronLeft className="size-5" />
          </Link>
          <span
            aria-hidden="true"
            style={tileStyle()}
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
          >
            {Icon && <Icon className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <nav aria-label="Breadcrumb" className="text-[13px] leading-none">
              <ol className="flex items-center gap-1.5">
                <li>
                  <Link href="/" className="font-medium text-[#d2aa6a] hover:text-[#e5c585] hover:underline">
                    Home
                  </Link>
                </li>
                <li aria-hidden="true" className="text-[#8f8c87]">
                  /
                </li>
                <li aria-current="page" className="text-[15px] font-semibold tracking-[-0.01em] text-[#f7f1e8]">
                  {app?.name ?? appId}
                </li>
              </ol>
            </nav>
            {description && (
              <p className="mt-1.5 hidden truncate text-xs leading-4 text-[#b5aea4] sm:block">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>

        {tabs && (
          <div role="tablist" aria-label={`${app?.name ?? appId} sections`} className="-mx-1 overflow-x-auto px-1 pt-3">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === activeTab}
                onClick={() => onTabChange?.(t.id)}
                className={cn("tab tab-band mr-4")}
              >
                {t.label}
                {t.count != null && (
                  <span className="tnum rounded-full bg-white/10 px-1.5 py-px text-[11px] font-medium text-[#e8e2d8]">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </header>
      {children}
    </div>
  );
}

/** Page-level container for non-app destinations (dashboard, system pages). */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "mx-auto max-w-7xl" : "mx-auto max-w-6xl"}>{children}</div>;
}
