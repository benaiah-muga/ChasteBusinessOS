"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { appsForOrg, tileStyle, type AppInfo } from "./_shell/apps";
import { IconPalette, IconSearch } from "@/components/icons";
import { THEMES, applyTheme, type ThemeId } from "@/components/theme";
import { cn } from "@/lib/format";

type Command =
  | { kind: "app"; app: AppInfo }
  | { kind: "theme"; id: ThemeId; label: string };

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

  const results = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    const apps = appsForOrg(enabledModules).filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.tagline.toLowerCase().includes(q),
    );
    const themes = q && "theme".includes(q)
      ? THEMES.map((t) => ({
          kind: "theme" as const,
          id: t.id,
          label: `Theme · ${t.label}`,
        }))
      : [];
    return [
      ...apps.map((app) => ({ kind: "app" as const, app })),
      ...themes,
    ];
  }, [query, enabledModules]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function run(cmd: Command) {
    onClose();
    if (cmd.kind === "app") router.push(cmd.app.href);
    else applyTheme(cmd.id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      run(results[active]!);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <div className="overlay-backdrop z-50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
            placeholder="Jump to an app…"
            aria-label="Search pages and commands"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-stone-400"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-stone-400">Nothing matches “{query}”.</p>}
          {results.map((cmd, i) => {
            const isActive = i === active;
            return (
              <button
                key={cmd.kind === "app" ? cmd.app.id : cmd.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(cmd)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-75",
                  isActive ? "bg-maroon-50" : "",
                )}
              >
                {cmd.kind === "app" ? (
                  <>
                    <span
                      aria-hidden="true"
                      style={tileStyle(cmd.app.hue)}
                      className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", isActive && "scale-105")}
                    >
                      <cmd.app.icon className="size-4" />
                    </span>
                    <span className="flex-1 font-medium">{cmd.app.name}</span>
                    <span className="truncate text-xs text-stone-400">{cmd.app.tagline}</span>
                  </>
                ) : (
                  <>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-500">
                      <IconPalette className="size-4" />
                    </span>
                    <span className="flex-1 font-medium">{cmd.label}</span>
                  </>
                )}
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
          <span className="ml-auto flex items-center gap-1">
            <kbd className="kbd">⌘G</kbd> apps
          </span>
        </div>
      </div>
    </div>
  );
}
