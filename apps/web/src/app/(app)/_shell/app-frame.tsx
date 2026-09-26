"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { resolveApp, tileStyle } from "./apps";
import { IconChevronLeft, IconSparkle } from "@/components/icons";
import { cn } from "@/lib/format";
import { chatDock, chatDraft } from "../chat-widget-state";

export interface AppTab {
  id: string;
  label: string;
  /** Optional live count rendered as a quiet pill next to the label. */
  count?: number;
}

function revealTabHorizontally(container: HTMLDivElement | null, tab: HTMLButtonElement | null) {
  if (!container || !tab) return;
  const containerRect = container.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const delta = tabRect.left < containerRect.left
    ? tabRect.left - containerRect.left
    : tabRect.right > containerRect.right
      ? tabRect.right - containerRect.right
      : 0;
  if (delta !== 0) container.scrollBy({ left: delta, behavior: "smooth" });
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
  workmatePrompt,
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
  workmatePrompt?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const app = resolveApp(appId);
  const Icon = app?.icon;
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const previousTabRef = useRef(activeTab);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const tabSignature = tabs?.map((tab) => `${tab.id}:${tab.label}:${tab.count ?? ""}`).join("|") ?? "";

  function askWorkmate() {
    chatDraft.set(workmatePrompt ?? `Help me with ${app?.name ?? appId}. What should I work on next?`);
    chatDock.set("open");
  }

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

  useEffect(() => {
    if (previousTabRef.current !== activeTab) {
      window.scrollTo({ top: 0, behavior: "auto" });
      previousTabRef.current = activeTab;
    }
    revealTabHorizontally(tabListRef.current, activeTabRef.current);
  }, [activeTab]);

  useEffect(() => {
    const element = tabListRef.current;
    if (!element) return;
    const measure = () => setTabsOverflow(element.scrollWidth > element.clientWidth + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tabSignature]);

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
            <nav aria-label="Breadcrumb" className="hidden text-[13px] leading-none sm:block">
              <ol className="flex items-center gap-1.5">
                <li>
                  <Link href="/" className="font-medium text-[#d2aa6a] hover:text-[#e5c585] hover:underline">
                    Home
                  </Link>
                </li>
              </ol>
            </nav>
            <h1 className="mt-1 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-[#f7f1e8]">{app?.name ?? appId}</h1>
            {description && (
              <p className="mt-1.5 hidden truncate text-xs leading-4 text-[#b5aea4] sm:block">{description}</p>
            )}
          </div>
          <button type="button" onClick={askWorkmate} className="btn btn-md btn-secondary lg:hidden">
            <IconSparkle className="size-3.5" />
            Ask workmate
          </button>
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
        </div>

        {tabs && (
          <>
            <div
              ref={tabListRef}
              role="tablist"
              aria-label={`${app?.name ?? appId} sections`}
              className="scrollbar-subtle -mx-1 flex w-full min-w-0 flex-nowrap gap-3 overflow-x-auto overflow-y-hidden px-1 pt-3"
            >
              {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === activeTab}
                ref={t.id === activeTab ? activeTabRef : undefined}
                aria-controls={activeTab === t.id ? `${persistKey ?? appId}-${t.id}-panel` : undefined}
                id={`${persistKey ?? appId}-${t.id}-tab`}
                tabIndex={t.id === activeTab ? 0 : -1}
                data-tab-id={t.id}
                onClick={() => onTabChange?.(t.id)}
                onKeyDown={(event) => {
                  const buttons = Array.from(
                    event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
                  );
                  const currentIndex = buttons.indexOf(event.currentTarget);
                  let nextIndex: number;
                  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % buttons.length;
                  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
                  else if (event.key === "Home") nextIndex = 0;
                  else if (event.key === "End") nextIndex = buttons.length - 1;
                  else return;
                  event.preventDefault();
                  const next = buttons[nextIndex];
                  next?.focus();
                  revealTabHorizontally(tabListRef.current, next ?? null);
                  if (next?.dataset.tabId) onTabChange?.(next.dataset.tabId);
                }}
                className={cn("tab tab-band shrink-0")}
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
            {tabsOverflow && <p aria-hidden="true" className="pt-1 text-right text-[10px] leading-none text-[#b5aea4] sm:hidden">Swipe horizontally for more sections →</p>}
          </>
        )}
      </header>
      <div
        role={activeTab ? "tabpanel" : undefined}
        id={`${persistKey ?? appId}-${activeTab ?? "content"}-panel`}
        aria-labelledby={activeTab ? `${persistKey ?? appId}-${activeTab}-tab` : undefined}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}

/** Page-level container for non-app destinations (dashboard, system pages). */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "mx-auto max-w-7xl" : "mx-auto max-w-6xl"}>{children}</div>;
}
