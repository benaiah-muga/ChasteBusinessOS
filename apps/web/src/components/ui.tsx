"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn, initials as toInitials } from "@/lib/format";
import type { AppError } from "@/lib/api";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconInfo,
  IconSpinner,
  IconX,
} from "@/components/icons";

/* ---------------------------------- Button --------------------------------- */

type ButtonTone = "primary" | "secondary" | "danger" | "dangerSecondary" | "ghost";

const buttonTones: Record<ButtonTone, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  dangerSecondary: "btn-danger-secondary",
  ghost: "btn-ghost",
};

export function Button({
  tone = "primary",
  size = "md",
  loading = false,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: {
  tone?: ButtonTone;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn("btn", size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "btn-md", buttonTones[tone], className)}
      {...rest}
    >
      {loading && <IconSpinner className="size-3.5" />}
      {children}
    </button>
  );
}

/* ----------------------------------- Card ---------------------------------- */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("card card-pad", className)}>{children}</div>;
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="section-title">{children}</h2>
      {right}
    </div>
  );
}

/* ---------------------------------- Badge ---------------------------------- */

export type BadgeTone = "neutral" | "maroon" | "green" | "amber" | "red" | "blue" | "violet";

export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={cn("badge", `badge-${tone}`, className)}>{children}</span>;
}

const riskTones: Record<string, BadgeTone> = {
  money: "amber",
  identity: "red",
  destructive: "red",
  secret: "red",
  write: "blue",
  read: "neutral",
};

export function RiskBadge({ risk }: { risk: string }) {
  return <Badge tone={riskTones[risk] ?? "neutral"}>{risk}</Badge>;
}

/* ------------------------------- Copy button -------------------------------- */

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions/insecure context), nothing to do.
        }
      }}
      aria-label={`${label} to clipboard`}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-100",
        copied ? "text-emerald-700" : "text-stone-400 hover:bg-stone-200/60 hover:text-stone-700",
        className,
      )}
    >
      {copied ? <IconCheck className="size-3" /> : <IconCopy className="size-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/* ----------------------------- Technical details ---------------------------- */

export function ErrorDetails({ text, label = "Technical details" }: { text: string; label?: string }) {
  return (
    <details className="mt-2 border-t border-current/15 pt-1.5">
      <summary className="cursor-pointer select-none text-[11px] opacity-70 hover:opacity-100">{label}</summary>
      <div className="relative mt-1.5">
        <pre className="max-h-40 overflow-auto rounded-md bg-stone-950/90 p-2.5 pr-16 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-stone-300">
          {text}
        </pre>
        <div className="absolute top-1.5 right-1.5">
          <CopyButton text={text} className="bg-stone-800/80 hover:bg-stone-700" />
        </div>
      </div>
    </details>
  );
}

/* --------------------------------- Notice ---------------------------------- */

export function Notice({
  tone = "info",
  children,
  detail,
  onDismiss,
}: {
  tone?: "success" | "info" | "error" | "pending";
  children: ReactNode;
  detail?: ReactNode;
  onDismiss?: () => void;
}) {
  const config = {
    success: { cls: "border-emerald-200 bg-emerald-50 text-emerald-900", Icon: IconCircleCheck },
    info: { cls: "border-sky-200 bg-sky-50 text-sky-900", Icon: IconInfo },
    error: { cls: "border-red-200 bg-red-50 text-red-900", Icon: IconAlertTriangle },
    pending: { cls: "border-amber-200 bg-amber-50 text-amber-900", Icon: IconInfo },
  }[tone];
  const { Icon } = config;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm", config.cls)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2">
        {children}
        {detail}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="icon-btn -mt-1 -mr-1.5 size-6">
          <IconX className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------- ActionNotice ------------------------------- */

/**
 * Unified result banner for page actions: friendly success/pending text, or a
 * structured AppError whose raw wire detail stays collapsed but copyable.
 */
export type ActionNoticeState =
  | { tone: "success" | "info" | "pending"; text: ReactNode }
  | { tone: "error"; error: AppError };

export function ActionNotice({ state, onDismiss }: { state: ActionNoticeState; onDismiss?: () => void }) {
  if (state.tone === "error") {
    const e = state.error;
    return (
      <Notice tone="error" detail={e.detail ? <ErrorDetails text={e.detail} /> : undefined} onDismiss={onDismiss}>
        <span className="font-semibold">{e.title}.</span> {e.hint}
      </Notice>
    );
  }
  return (
    <Notice tone={state.tone} onDismiss={onDismiss}>
      {state.text}
    </Notice>
  );
}

/* -------------------------------- PageHeader -------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------- EmptyState -------------------------------- */

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white/60 px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-maroon-50 text-maroon-700 [&_svg]:size-5">
        {icon}
      </div>
      <p className="text-sm font-medium text-stone-800">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-stone-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* --------------------------------- Skeleton --------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}

export function LoadingPage() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

/* --------------------------------- StatCard --------------------------------- */

export function StatCard({
  label,
  value,
  sub,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "accent" | "warn" | "danger" | "success";
  className?: string;
}) {
  const tones = {
    default: "card",
    accent: "border-maroon-200 bg-maroon-50/60",
    warn: "border-amber-200 bg-amber-50/60",
    danger: "border-red-200 bg-red-50/60",
    success: "border-emerald-200 bg-emerald-50/60",
  };
  return (
    <div className={cn("rounded-xl border p-4 shadow-xs", tones[tone], className)}>
      <p className="text-xs font-medium text-stone-500">{label}</p>
      <p className="tnum mt-1.5 text-lg font-semibold tracking-tight text-stone-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-stone-500">{sub}</p>}
    </div>
  );
}

/* ---------------------------------- Dialog ---------------------------------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      restoreRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "overlay-panel fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl outline-none",
          width,
        )}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 className="text-[15px] font-semibold text-stone-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="icon-btn -mt-1 -mr-1">
            <IconX className="size-4" />
          </button>
        </div>
        {description && <p className="mb-4 text-sm leading-relaxed text-stone-500">{description}</p>}
        {children}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  tone = "danger",
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-stone-600">{body}</div>
      {children}
    </Dialog>
  );
}

/* ---------------------------------- Switch ---------------------------------- */

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={hint}
      onClick={() => onChange(!checked)}
      className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-600 select-none"
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150",
          checked ? "bg-maroon-700" : "bg-stone-300",
        )}
      >
        <span
          className={cn(
            "absolute size-3.5 rounded-full bg-white shadow-sm transition-all duration-150",
            checked ? "left-[18px]" : "left-[3px]",
          )}
        />
      </span>
      {label}
    </button>
  );
}

/* ----------------------------- SegmentedControl ----------------------------- */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-lg bg-stone-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all duration-150",
            value === o.value ? "bg-white text-stone-900 shadow-xs" : "text-stone-500 hover:text-stone-800",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------- Avatar ---------------------------------- */

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-200 text-[11px] font-semibold text-stone-600",
        className,
      )}
    >
      {toInitials(name) || "?"}
    </span>
  );
}

/* --------------------------------- Tool chip -------------------------------- */

export function ToolChip({ name, done }: { name: string; done: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-100 px-2 py-0.5 font-mono text-[10px] text-violet-800">
      {done ? <IconCheck className="size-3" /> : <IconSpinner className="size-3" />}
      {name}
    </span>
  );
}
