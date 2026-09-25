"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { resolveApp, tileStyle } from "./apps";
import { IconChevronLeft } from "@/components/icons";
import { cn } from "@/lib/format";
import { QuickActionsMenu } from "@/components/quick-actions";

export interface AppTab {
  id: string;
  label: string;
  /** Optional live count rendered as a quiet pill next to the label. */
  count?: number;
  mobileQuick?: boolean;
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
  const mobileTabScroller = useRef<HTMLElement>(null);
  const mobileTabTrack = useRef<HTMLDivElement>(null);
  const [mobileCanScrollLeft, setMobileCanScrollLeft] = useState(false);
  const [mobileCanScrollRight, setMobileCanScrollRight] = useState(false);
  const markedQuickTabs = tabs?.filter((tab) => tab.mobileQuick) ?? [];
  const mobileQuickTabs =
    markedQuickTabs.length > 0 ? markedQuickTabs : (tabs?.slice(0, 3) ?? []);
  const mobileTabs = [
    ...mobileQuickTabs,
    ...(tabs ?? []).filter((tab) => !mobileQuickTabs.includes(tab)),
  ];
  const mobileTabSignature = mobileTabs
    .map((tab) => `${tab.id}:${tab.label}:${tab.count ?? ""}`)
    .join("|");

  useEffect(() => {
    const scroller = mobileTabScroller.current;
    const track = mobileTabTrack.current;
    if (!scroller) return;

    const revealActiveTab = () => {
      if (!activeTab || scroller.clientWidth === 0) return;
      const activeButton = Array.from(
        scroller.querySelectorAll<HTMLButtonElement>("[data-app-tab]"),
      ).find((button) => button.dataset.appTab === activeTab);
      if (!activeButton) return;

      const scrollerBounds = scroller.getBoundingClientRect();
      const buttonBounds = activeButton.getBoundingClientRect();
      if (
        buttonBounds.left < scrollerBounds.left ||
        buttonBounds.right > scrollerBounds.right
      ) {
        scroller.scrollLeft += buttonBounds.left - scrollerBounds.left;
      }
    };

    const updateScrollState = () => {
      setMobileCanScrollLeft(scroller.scrollLeft > 1);
      setMobileCanScrollRight(
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
      );
    };
    let pendingFrame: number | null = null;
    const syncLayout = () => {
      updateScrollState();
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = null;
        revealActiveTab();
      });
    };

    syncLayout();
    scroller.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", syncLayout);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncLayout);
    observer?.observe(scroller);
    if (track) observer?.observe(track);
    return () => {
      scroller.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", syncLayout);
      observer?.disconnect();
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    };
  }, [activeTab, mobileTabSignature]);

  function revealMobileTabs() {
    const scroller = mobileTabScroller.current;
    if (!scroller) return;
    const direction = mobileCanScrollRight ? 1 : -1;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollBy({
      left: direction * Math.max(160, Math.floor(scroller.clientWidth * 0.72)),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }

  // Deep link (?tab=) wins on mount; afterwards the last choice is remembered.
  useEffect(() => {
    if (!persistKey || !onTabChange || !activeTab) return;
    const fromUrl = new URLSearchParams(window.location.search).get("tab");
    const known = (id: string | null) =>
      id && tabs?.some((t) => t.id === id) ? id : null;
    const target =
      known(fromUrl) ??
      (fromUrl
        ? null
        : known(localStorage.getItem(`chaste-app-tab:${persistKey}`)));
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
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
            <nav
              aria-label="Breadcrumb"
              className="min-w-0 overflow-hidden text-[13px] leading-none"
            >
              <ol className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <li className="hidden shrink-0 sm:list-item">
                  <Link
                    href="/"
                    className="font-medium text-[#d2aa6a] hover:text-[#e5c585] hover:underline"
                  >
                    Home
                  </Link>
                </li>
                <li
                  aria-hidden="true"
                  className="hidden shrink-0 text-[#8f8c87] sm:list-item"
                >
                  /
                </li>
                <li
                  aria-current="page"
                  className="min-w-0 truncate whitespace-nowrap text-sm font-semibold tracking-[-0.01em] text-[#f7f1e8] min-[360px]:text-[15px]"
                >
                  {app?.name ?? appId}
                </li>
              </ol>
            </nav>
            {description && (
              <p className="mt-1.5 hidden truncate text-xs leading-4 text-[#b5aea4] sm:block">
                {description}
              </p>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <QuickActionsMenu appId={appId} />
            {actions}
          </div>
        </div>

        {tabs && (
          <div className="pt-3 lg:hidden">
            <div className="flex min-w-0 items-center gap-1">
              <nav
                id={`${appId}-mobile-sections`}
                ref={mobileTabScroller}
                aria-label={`${app?.name ?? appId} sections`}
                className="flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
              >
                <div
                  ref={mobileTabTrack}
                  className="flex w-max min-w-full items-stretch gap-1"
                >
                  {mobileTabs.map((tab) => {
                    const selected = tab.id === activeTab;
                    return (
                      <button
                        key={tab.id}
                        data-app-tab={tab.id}
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        onClick={() => onTabChange?.(tab.id)}
                        className={cn(
                          "flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#d2aa6a]",
                          selected
                            ? "border-[#d2aa6a] text-[#f7f1e8]"
                            : "border-transparent text-[#b5aea4] hover:text-[#f7f1e8]",
                        )}
                      >
                        <span>{tab.label}</span>
                        {tab.count != null && (
                          <span className="tnum rounded-full bg-white/10 px-1.5 py-px text-[10px] text-[#e8e2d8]">
                            {tab.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </nav>
              {(mobileCanScrollLeft || mobileCanScrollRight) && (
                <button
                  type="button"
                  aria-controls={`${appId}-mobile-sections`}
                  aria-label={
                    mobileCanScrollRight
                      ? `Show more ${app?.name ?? appId} sections`
                      : `Show previous ${app?.name ?? appId} sections`
                  }
                  title={
                    mobileCanScrollRight
                      ? "Show more sections"
                      : "Show previous sections"
                  }
                  onClick={revealMobileTabs}
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-[#c9c2b8] transition-colors hover:bg-white/[0.08] hover:text-[#f7f1e8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d2aa6a]"
                >
                  <IconChevronLeft
                    className={`size-4 transition-transform duration-150 ${mobileCanScrollRight ? "rotate-180" : ""}`}
                  />
                </button>
              )}
            </div>
          </div>
        )}

        {tabs && (
          <div
            role="tablist"
            aria-label={`${app?.name ?? appId} sections`}
            className="-mx-1 hidden max-w-full flex-nowrap gap-4 overflow-x-auto overflow-y-hidden px-1 pt-3 [scrollbar-width:none] lg:flex"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === activeTab}
                onClick={() => onTabChange?.(t.id)}
                className={cn("tab tab-band shrink-0 whitespace-nowrap")}
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
export function Page({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "mx-auto max-w-7xl" : "mx-auto max-w-6xl"}>
      {children}
    </div>
  );
}
