"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import { IconCheck, IconSearch } from "@/components/icons";
import { LogoMark } from "@/components/logo";

/** Shared chrome for the setup wizard: header, spinner, step rail, choice cards. */

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={cn("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return <LogoMark size={compact ? 36 : 44} />;
}

/**
 * The same app chrome as the sign-in page. The avatar carries the user's real
 * initial - during setup there is nothing else on screen telling them they are
 * already signed in as the right person.
 */
export function OnboardingHeader({ email }: { email: string }) {
  const initial = (email.trim()[0] ?? "N").toUpperCase();
  return (
    <header className="relative z-10 border-b border-white/10 bg-[#111416] text-[#f7f1e8]">
      <div className="mx-auto flex h-[4.5rem] max-w-[1440px] items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <BrandMark compact />
          <span className="text-sm leading-tight">
            <span className="block font-semibold tracking-[-0.02em]">Chaste Business OS</span>
            <span className="hidden text-[11px] tracking-[0.12em] text-[#a9a39b] uppercase md:block">
              Open source · built for everyone
            </span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] tracking-[0.16em] text-[#a9a39b] uppercase sm:inline">Secure setup</span>
          <IconSearch className="size-4 text-[#c9a05f]" aria-hidden="true" />
          <span
            title={email}
            className="flex size-8 items-center justify-center rounded-full border border-[#c9a05f]/45 bg-[#c9a05f]/15 text-sm font-semibold text-[#f7f1e8]"
          >
            {initial}
          </span>
        </div>
      </div>
    </header>
  );
}

export interface RailStep {
  key: string;
  label: string;
}

/** Progress rail. Completed steps show a check, the current one is gold. */
export function StepRail({ steps, current }: { steps: RailStep[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-[12px]">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium transition-colors",
                active && "bg-[#111416] text-[#f7f1e8] shadow-[0_5px_18px_rgba(17,20,22,0.15)]",
                done && "text-ink",
                !active && !done && "text-ink-muted/70",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
                  active && "bg-gold-500 text-stone-950",
                  done && "bg-gold-500/20 text-gold-800",
                  !active && !done && "bg-sand-200 text-ink-muted",
                )}
              >
                {done ? <IconCheck className="size-3" /> : i + 1}
              </span>
              {s.label}
            </span>
            {i < steps.length - 1 && <span aria-hidden="true" className="h-px w-4 bg-sand-300" />}
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({
  value,
  label,
  status,
}: {
  value: number;
  label: string;
  status: string;
}) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <div className="rounded-2xl border border-stone-300 bg-cream px-4 py-3 shadow-[0_14px_38px_rgba(31,25,17,0.06)] sm:px-5">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.18em] text-gold-700 uppercase">{status}</p>
          <p className="mt-1 truncate text-sm font-semibold text-ink">{label}</p>
        </div>
        <output className="shrink-0 text-2xl font-semibold tracking-[-0.06em] text-stone-950" aria-live="polite">
          {Math.round(safeValue)}%
        </output>
      </div>
      <div
        className="chaste-progress mt-3"
        role="progressbar"
        aria-label={status}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safeValue)}
      >
        <span className="chaste-progress__fill" style={{ width: `${safeValue}%` }} />
      </div>
    </div>
  );
}

/** A selectable path card: big target, states explained, keyboard reachable. */
export function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  blurb,
  bullets,
  meta,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  blurb: string;
  bullets: string[];
  meta: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group w-full cursor-pointer rounded-xl bg-cream p-5 text-left ring-1 transition-all duration-150",
        "focus-visible:ring-[3px] focus-visible:ring-gold-500/30 focus-visible:outline-none",
        selected
          ? "shadow-md ring-2 ring-gold-500"
          : "shadow-sm ring-sand-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-sand-300",
      )}
    >
      <div className="flex items-start gap-3.5">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors",
            selected ? "bg-gold-500 text-white" : "bg-gold-500/12 text-gold-600",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">{title}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">{blurb}</p>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
            selected ? "border-gold-500 bg-gold-500 text-white" : "border-sand-300 bg-cream",
          )}
        >
          {selected && <IconCheck className="size-3" />}
        </span>
      </div>

      <ul className="mt-3.5 space-y-1.5 pl-[3.25rem] text-[13px] text-ink-muted">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <IconCheck className="mt-0.5 size-3.5 shrink-0 text-gold-600" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 pl-[3.25rem] text-[11px] font-semibold tracking-[0.08em] text-gold-600 uppercase">
        {meta}
      </p>
    </button>
  );
}

/**
 * One failure, explained. Every error in the wizard gets a reason and a way
 * out - a bare red string is how a new user ends up stuck and blaming the tool.
 */
export function RecoverBlock({
  title,
  children,
  actions,
  tone = "error",
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  tone?: "error" | "warn";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-4 py-3.5",
        tone === "error" ? "border-red-500/30 bg-red-500/10" : "border-gold-600/40 bg-gold-500/10",
      )}
    >
      <p className={cn("text-sm font-semibold", tone === "error" ? "text-red-800 dark:text-red-300" : "text-gold-800 dark:text-gold-700")}>
        {title}
      </p>
      <div className={cn("mt-1 text-[13px] leading-relaxed", tone === "error" ? "text-red-800/90 dark:text-red-300/90" : "text-ink-muted")}>
        {children}
      </div>
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export const primaryButtonClass =
  "group inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-stone-950 px-4 text-sm font-semibold text-cream shadow-[0_10px_24px_rgba(23,26,27,0.14)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-stone-900 focus-visible:ring-[3px] focus-visible:ring-gold-600/35 focus-visible:outline-none active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55";

export const secondaryButtonClass =
  "inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-stone-300 bg-cream px-4 text-sm font-medium text-ink transition-all hover:-translate-y-0.5 hover:bg-stone-100 focus-visible:ring-[3px] focus-visible:ring-gold-600/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55";

export const ghostButtonClass =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink focus-visible:ring-[3px] focus-visible:ring-gold-500/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55";

export const inputClass =
  "h-10 w-full rounded-lg border border-sand-300 bg-white px-3 text-sm text-ink transition-colors outline-none placeholder:text-ink-muted/55 focus:border-gold-500 focus:ring-[3px] focus:ring-gold-500/20";
