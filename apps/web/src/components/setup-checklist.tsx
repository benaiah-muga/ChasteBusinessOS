"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { callApi } from "@/lib/api";
import { cn } from "@/lib/format";
import { STEP_META, type OnboardingStepKey } from "@/lib/onboarding-plan";
import { IconAlertTriangle, IconArrowRight, IconCheck, IconX } from "@/components/icons";

/**
 * The other half of "skip for now".
 *
 * Deferred setup steps come back here, on the dashboard, with the reason they
 * matter and the one click that finishes them. Dismissal is stored locally so
 * a dismissed item stops nagging without silently marking work as done — the
 * server still knows it is outstanding.
 */

const DISMISS_KEY = "chaste.setup.dismissed";

interface ChecklistStep {
  key: OnboardingStepKey;
  status: "pending" | "skipped";
}

interface OnboardingResponse {
  steps?: ChecklistStep[];
}

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function SetupChecklist() {
  const [steps, setSteps] = useState<ChecklistStep[] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void callApi<OnboardingResponse>("/api/onboarding").then((res) => {
      if (!res.ok) {
        setFailed(true);
        setSteps([]);
        return;
      }
      setSteps(res.data?.steps ?? []);
    });
    setDismissed(readDismissed());
  }, []);

  function dismiss(key: string) {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the dismissal just won't survive a reload */
    }
  }

  // Still loading, or nothing outstanding: render nothing rather than a card
  // that says "you have nothing to do", which is its own kind of noise.
  if (steps === null) {
    return (
      <div className="card card-pad mb-6 animate-pulse" aria-hidden="true">
        <div className="h-4 w-40 rounded bg-stone-200" />
        <div className="mt-3 h-3 w-2/3 rounded bg-stone-100" />
      </div>
    );
  }

  const visible = steps.filter((s) => !dismissed.includes(s.key));
  if (visible.length === 0) return null;

  return (
    <section className="card card-pad mb-6">
      <div className="mb-3.5 flex items-start justify-between gap-3">
        <div>
          <h2 className="section-title">Finish setting up</h2>
          <p className="mt-1 text-[13px] text-stone-500">
            {visible.length === 1
              ? "One thing was left for later during setup."
              : `${visible.length} things were left for later during setup.`}{" "}
            Nothing here blocks your books.
          </p>
        </div>
        {failed && (
          <span className="flex items-center gap-1.5 text-[12px] text-amber-700">
            <IconAlertTriangle className="size-3.5" />
            Couldn&apos;t refresh
          </span>
        )}
      </div>

      <ul className="divide-y divide-stone-100">
        {visible.map((s) => {
          const meta = STEP_META[s.key];
          if (!meta) return null;
          return (
            <li key={s.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[13px] font-medium text-stone-900">
                  {meta.title}
                  {s.status === "skipped" && (
                    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-stone-500 uppercase">
                      skipped
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-stone-500">{meta.why}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Link
                  href={meta.fix.href}
                  className={cn(
                    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium",
                    "text-maroon-700 transition-colors hover:bg-maroon-50",
                  )}
                >
                  {meta.fix.label}
                  <IconArrowRight className="size-3.5" />
                </Link>
                <button
                  type="button"
                  onClick={() => dismiss(s.key)}
                  aria-label={`Dismiss: ${meta.title}`}
                  className="icon-btn size-8"
                >
                  <IconX className="size-3.5" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-stone-400">
        <IconCheck className="size-3" />
        Dismissing hides it here; your books never depend on it.
      </p>
    </section>
  );
}
