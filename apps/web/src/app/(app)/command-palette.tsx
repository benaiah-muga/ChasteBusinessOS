"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_NAV_ITEMS } from "./_shell/nav";
import { IconSearch } from "@/components/icons";
import { cn } from "@/lib/format";

export function CommandPalette({
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
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = enabledModules
      ? ALL_NAV_ITEMS.filter((i) => !("moduleId" in i) || !i.moduleId || enabledModules.has(i.moduleId))
      : ALL_NAV_ITEMS;
    if (!q) return base;
    return base.filter(
      (i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q),
    );
  }, [query, enabledModules]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function go(href: string) {
    onClose();
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      go(results[active]!.href);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        className="overlay-panel fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl"
      >
        <div className="flex items-center gap-2.5 border-b border-stone-100 px-4">
          <IconSearch className="size-4 shrink-0 text-stone-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Where to?"
            aria-label="Search pages"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-stone-400"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-stone-400">Nothing matches “{query}”.</p>}
          {results.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.href}
                type="button"
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item.href)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors duration-75",
                  i === active ? "bg-maroon-50 text-maroon-900" : "text-stone-700",
                )}
              >
                <Icon className={cn("size-4 shrink-0", i === active ? "text-maroon-700" : "text-stone-400")} />
                <span className="flex-1 font-medium">{item.label}</span>
                <span className="text-xs text-stone-400">{item.group}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-stone-100 px-4 py-2 text-[11px] text-stone-400">
          <span className="flex items-center gap-1">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="kbd">↵</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}
