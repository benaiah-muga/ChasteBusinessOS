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
      <header className="sticky top-0 z-20 -mx-4 mb-6 border-b border-stone-200 bg-canvas/90 px-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3 pb-3 sm:pt-4">
          <Link
            href="/"
            aria-label="Back to dashboard"
            title="Back to dashboard"
            className="icon-btn -ml-1 shrink-0"
          >
            <IconChevronLeft className="size-4.5" />
          </Link>
          <span
            aria-hidden="true"
            style={tileStyle(app?.hue ?? 0)}
            className="flex size-8 shrink-0 items-center justify-center rounded-[9px]"
          >
            {Icon && <Icon className="size-4.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <nav aria-label="Breadcrumb" className="text-[11px] leading-none text-stone-400">
              <ol className="flex items-center gap-1">
                <li>
                  <Link href="/" className="hover:text-stone-600 hover:underline">
                    Home
                  </Link>
                </li>
                <li aria-hidden="true">/</li>
                <li aria-current="page" className="font-medium text-stone-500">
                  {app?.name ?? appId}
                </li>
              </ol>
            </nav>
            {description && (
              <p className="mt-1 hidden truncate text-xs text-stone-500 sm:block">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>

        {tabs && (
          <div role="tablist" aria-label={`${app?.name ?? appId} sections`} className="-mx-1 overflow-x-auto px-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === activeTab}
                onClick={() => onTabChange?.(t.id)}
                className={cn("tab mr-4")}
              >
                {t.label}
                {t.count != null && (
                  <span className="tnum rounded-full bg-stone-100 px-1.5 py-px text-[11px] font-medium text-stone-500">
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
