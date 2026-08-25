"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { appsForOrg, tileStyle, type AppInfo } from "./_shell/apps";
import { appPins, usePinnedApps } from "./_shell/pins";
import { recordAppVisit, useRecentApps } from "./_shell/recent-apps";
import { IconPinTack, IconSearch } from "@/components/icons";
import { cn } from "@/lib/format";

/**
 * The launcher: every business module as an application, one keystroke away.
 * Type to filter, arrows to move through the grid, Enter to open.
 */
export function AppsLauncher({
  open,
  onClose,
  enabledModules,
}: {
  open: boolean;
  onClose: () => void;
  enabledModules?: ReadonlySet<string> | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const apps = useMemo(() => appsForOrg(enabledModules), [enabledModules]);
  const pinnedIds = usePinnedApps();
  const recentHrefs = useRecentApps();

  const groups = useMemo(() => {
    if (!open) return [] as { label: string; items: AppInfo[] }[];
    const q = query.trim().toLowerCase();
    const match = (a: AppInfo) =>
      !q || a.name.toLowerCase().includes(q) || a.tagline.toLowerCase().includes(q);
    const recent = q
      ? []
      : recentHrefs
          .map((h) => apps.find((a) => a.href === h))
          .filter((a): a is AppInfo => !!a);
    const visited = new Set(recent.map((a) => a.href));
    return [
      { label: "Recent", items: recent },
      { label: "Business", items: apps.filter((a) => !a.system && !visited.has(a.href) && match(a)) },
      { label: "System", items: apps.filter((a) => a.system && match(a)) },
    ].filter((g) => g.items.length > 0);
  }, [apps, query, open]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function launch(app: AppInfo) {
    recordAppVisit(app.href);
    onClose();
    router.push(app.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && flat[active]) {
      launch(flat[active]!);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  let index = -1;

  return (
    <div
      className="overlay-backdrop z-50 bg-stone-950/30 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Applications"
        className="overlay-panel fixed inset-x-3 top-[7vh] mx-auto flex max-h-[82vh] max-w-2xl flex-col overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 shadow-2xl sm:inset-x-6"
      >
        <div className="flex items-center gap-3 border-b border-stone-200 px-5">
          <IconSearch className="size-4 shrink-0 text-stone-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your applications…"
            aria-label="Search applications"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-stone-400"
          />
          <kbd className="kbd">esc</kbd>
        </div>

        <div
          ref={gridRef}
          role="listbox"
          aria-label="Applications"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
        >
          {flat.length === 0 && (
            <p className="px-3 py-10 text-center text-sm text-stone-400">No application matches “{query}”.</p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <p className="figure-label mb-1.5 mt-1 px-1">{group.label}</p>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
                {group.items.map((app) => {
                  index += 1;
                  const isActive = index === active;
                  const TileIcon = app.icon;
                  const isPinned = pinnedIds.includes(app.id);
                  return (
                    <div key={app.id} className="group/tile relative">
                      <Link
                        href={app.href}
                        role="option"
                        aria-selected={isActive}
                        data-active={isActive}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => {
                          // Close immediately so the click feels like launching,
                          // not like browsing; navigation completes underneath.
                          recordAppVisit(app.href);
                          onClose();
                        }}
                        className="app-tile"
                      >
                        <span
                          aria-hidden="true"
                          style={tileStyle(app.hue)}
                          className={`flex size-11 items-center justify-center rounded-[11px] transition-transform duration-150${isActive ? " scale-[1.04]" : ""}`}
                        >
                          <TileIcon className="size-5.5" />
                        </span>
                        <span className="text-sm font-medium text-stone-900">{app.name}</span>
                      </Link>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          appPins.toggle(app.id);
                        }}
                        disabled={!isPinned && pinnedIds.length >= 5}
                        aria-pressed={isPinned}
                        aria-label={isPinned ? `Unpin ${app.name}` : `Pin ${app.name} to the rail`}
                        title={isPinned ? `Unpin ${app.name}` : `Pin ${app.name} to the rail`}
                        className={cn(
                          "absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-md transition-all duration-150",
                          isPinned
                            ? "text-maroon-700 opacity-100"
                            : "text-stone-300 opacity-0 group-hover/tile:opacity-100 hover:bg-stone-100 hover:text-stone-600 disabled:pointer-events-none",
                        )}
                      >
                        <IconPinTack className="size-3.5" strokeWidth={isPinned ? 2.4 : 1.75} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-stone-200 px-5 py-2 text-[11px] text-stone-400">
          <span className="flex items-center gap-1">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> move
          </span>
          <span className="flex items-center gap-1">
            <kbd className="kbd">↵</kbd> open
          </span>
          <span className="ml-auto hidden sm:inline">Your whole business, one keystroke away</span>
        </div>
      </div>
    </div>
  );
}
