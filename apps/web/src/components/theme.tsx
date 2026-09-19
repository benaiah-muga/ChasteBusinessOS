"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconMoon, IconSun } from "@/components/icons";
import { cn } from "@/lib/format";

export const MODES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
] as const;

export type ModeId = (typeof MODES)[number]["id"];
export const DEFAULT_MODE: ModeId = "system";

const modeListeners = new Set<(m: ModeId) => void>();

function currentMode(): ModeId {
  const raw = localStorage.getItem("chaste-mode");
  return raw === "light" || raw === "dark" || raw === "system" ? raw : DEFAULT_MODE;
}

/**
 * Resolves the stored preference against the OS setting and reflects it as
 * data-mode on <html>. Called by the pre-paint bootstrap in layout.tsx too,
 * so first paint is already in the right mode.
 */
export function applyMode(m: ModeId) {
  const dark =
    m === "dark" ||
    (m === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.dataset.mode = "dark";
  else delete document.documentElement.dataset.mode;
  try {
    localStorage.setItem("chaste-mode", m);
  } catch {
    // Storage unavailable; the choice lives until reload.
  }
  for (const fn of modeListeners) fn(m);
}

/** Subscribes to light/dark/system preference changes. */
export function useMode(): ModeId {
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE);
  useEffect(() => {
    const sync = (m: ModeId) => setMode(m);
    modeListeners.add(sync);
    setMode(currentMode());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if (currentMode() === "system") applyMode("system");
    };
    mq.addEventListener("change", onSystem);
    return () => {
      modeListeners.delete(sync);
      mq.removeEventListener("change", onSystem);
    };
  }, []);
  return mode;
}

/** Small popover menu anchored bottom-left; also reachable from ⌘K. */
export function ThemeMenu() {
  const mode = useMode();
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change appearance"
        className="rail-btn"
      >
        <span className="flex items-center">
          {/* Resolved-mode tick: use the mode state from useMode() to avoid hydration mismatch. */}
          {mode === "dark" ? (
            <IconMoon className="size-3.5" />
          ) : (
            <IconSun className="size-3.5" />
          )}
        </span>
        <span aria-hidden="true" className="rail-tip">
          Appearance
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Appearance"
          className="overlay-panel absolute bottom-11 left-0 z-50 w-48 rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">Mode</p>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m.id}
              onClick={() => applyMode(m.id)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-75",
                mode === m.id ? "bg-gold-50 text-gold-900" : "text-stone-700 hover:bg-stone-100",
              )}
            >
              {m.id === "dark" ? (
                <IconMoon className="size-3.5 shrink-0" />
              ) : m.id === "light" ? (
                <IconSun className="size-3.5 shrink-0" />
              ) : (
                <span aria-hidden="true" className="flex size-3.5 shrink-0">
                  <IconSun className="size-3.5" />
                  <IconMoon className="-ml-2 size-3.5" />
                </span>
              )}
              <span className="flex-1 font-medium">{m.label}</span>
              {mode === m.id && <IconCheck className="size-3.5 shrink-0 text-gold-700" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
