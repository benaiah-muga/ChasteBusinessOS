"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";
import { cn } from "@/lib/format";

export const THEMES = [
  { id: "chaste", label: "Chaste", hint: "Brick & burgundy" },
  { id: "graphite", label: "Graphite", hint: "Ink & steel" },
  { id: "verdant", label: "Verdant", hint: "Forest & sage" },
  { id: "meridian", label: "Meridian", hint: "Bronze & sand" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "chaste";

function currentTheme(): ThemeId {
  const attr = document.documentElement.dataset.theme as ThemeId | undefined;
  return attr && THEMES.some((t) => t.id === attr) ? attr : DEFAULT_THEME;
}

const listeners = new Set<(t: ThemeId) => void>();

/** Applies the theme to the document and persists it. Safe to call anywhere. */
export function applyTheme(t: ThemeId) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("chaste-theme", t);
  } catch {
    // Storage unavailable; the choice lives until reload.
  }
  for (const fn of listeners) fn(t);
}

/** Subscribes to theme changes without a provider in the render tree. */
export function useTheme(): ThemeId {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => {
    const sync = (t: ThemeId) => setTheme(t);
    listeners.add(sync);
    setTheme(currentTheme());
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return theme;
}

/** Small popover menu anchored bottom-left; also reachable from ⌘K. */
export function ThemeMenu() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Swatch pairs read diagonally: accent, then canvas.
  const swatches: Record<ThemeId, [string, string]> = {
    chaste: ["#9b1313", "#faf9f8"],
    graphite: ["#265a80", "#f8f9fb"],
    verdant: ["#276135", "#f8faf6"],
    meridian: ["#a67a28", "#fbf9f4"],
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change theme"
        title="Theme"
        className="rail-btn"
      >
        <span className="flex items-center">
          <span
            aria-hidden="true"
            className="size-3.5 rounded-full border border-stone-300"
            style={{
              background: `linear-gradient(135deg, ${swatches[theme][0]} 50%, ${swatches[theme][1]} 50%)`,
            }}
          />
          <IconChevronDown className="absolute right-1 bottom-1 size-2.5 text-stone-400" />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="overlay-panel absolute bottom-11 left-0 z-50 w-48 rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">Theme</p>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={theme === t.id}
              onClick={() => {
                applyTheme(t.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-75",
                theme === t.id ? "bg-maroon-50 text-maroon-900" : "text-stone-700 hover:bg-stone-100",
              )}
            >
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full border border-black/10"
                style={{
                  background: `linear-gradient(135deg, ${swatches[t.id][0]} 50%, ${swatches[t.id][1]} 50%)`,
                }}
              />
              <span className="flex-1 font-medium">{t.label}</span>
              <span className="text-[11px] text-stone-400">{t.hint}</span>
              {theme === t.id && <IconCheck className="size-3.5 shrink-0 text-maroon-700" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

