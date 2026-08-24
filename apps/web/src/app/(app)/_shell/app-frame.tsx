"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { resolveApp, tileStyle } from "./apps";
import { IconChevronLeft } from "@/components/icons";
import { cn } from "@/lib/format";

export interface AppTab {
  id: string;
  label: string;
}

/**
 * The frame every application opens into: where am I (breadcrumb), what can
 * this app do (tabs), and what can I do right now (actions). The overview is
 * always the first tab; deeper areas are operation surfaces.
 */
export function AppFrame({
  appId,
  description,
  tabs,
  activeTab,
  onTabChange,
  actions,
  children,
}: {
  appId: string;
  /** One quiet line of orientation under the app name. */
  description?: string;
  tabs?: AppTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const app = resolveApp(appId);
  const Icon = app?.icon;

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
