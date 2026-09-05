"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { callApi } from "@/lib/api";
import { formatMoney, formatMoneyWhole, timeAgo } from "@/lib/format";
import { IconArrowRight, IconSparkle } from "@/components/icons";

/**
 * The home dashboard reads like the cover page of the accounts book:
 * a deep ledger band answering "how is the business doing", then quiet paper
 * answering "what needs me" and "what is moving".
 */

interface SignalItem {
  id: string;
  severity: "red" | "orange" | "green";
  module: string;
  subject: string;
  detail: string;
}
interface DashboardPayload {
  signals?: SignalItem[];
  money: {
    revenueMinor: number;
    expenseMinor: number;
    netIncomeMinor: number;
    cashMinor: number | null;
    balanced: boolean | null;
    assetsMinor: number;
    liabilitiesMinor: number;
    equityMinor: number;
  };
  workingCapital: {
    arOutstandingMinor: number;
    overdueCount: number;
    overdueAmountMinor: number;
    apOutstandingMinor: number;
  };
  pipeline: {
    stages: { stage: string; count: number; valueMinor: number }[];
    openCount: number;
    weightedForecastMinor: number;
  };
  ops: {
    headcount: number;
    pendingLeave: number;
    posOpen: { register: string } | null;
    lowStock: { sku: string; name: string }[];
    pendingApprovals: number;
    docsParsed: number;
    docsAwaitingCoding: number;
  };
  trend: { month: string; incomeMinor: number; expenseMinor: number }[];
  activity: {
    seq: number;
    kind: string;
    capabilityId: string | null;
    actorType: string;
    occurredAt: string;
  }[];
}

const ASK_ACTIONS = [
  { label: "Draft an invoice", prompt: "Draft an invoice for a customer. Ask me for the details you need." },
  { label: "Record a bill", prompt: "Help me record a vendor bill we received." },
  { label: "Where is my cash?", prompt: "Give me the cash position: cash balance in, out, and net this month." },
];

interface SetupItem {
  id: string;
  title: string;
  why: string;
  href: string;
  done: boolean;
}

/** Hidden setup items persist locally; they reappear only when still undone on a fresh device. */
function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("chaste-setup-dismissed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function openChatWith(prompt: string) {
  void (async () => {
    const { chatDock, chatDraft } = await import("./chat-widget-state");
    chatDock.set("open");
    chatDraft.set(prompt);
  })();
}

export function HomeDashboard({ orgName }: { orgName: string }) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupItem[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void (async () => {
      const res = await callApi<DashboardPayload>("/api/dashboard");
      if (!res.data) setError(res.error?.title ?? "Could not load your dashboard");
      else setData(res.data);
    })();
    void callApi<{ items?: SetupItem[] }>("/api/setup").then((res) => {
      if (res.data?.items) setSetup(res.data.items);
      setDismissed(loadDismissed());
    });
  }, []);

  function dismissItem(id: string) {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      localStorage.setItem("chaste-setup-dismissed", JSON.stringify([...next]));
    } catch {
      // Session-only dismissal when storage is unavailable.
    }
  }

  const attentionCount = data
    ? data.ops.pendingApprovals +
      data.workingCapital.overdueCount +
      data.ops.lowStock.length +
      data.ops.pendingLeave +
      (data.workingCapital.apOutstandingMinor > 0 ? 1 : 0)
    : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <Masthead orgName={orgName} data={data} />

      {error && (
        <p className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      {!data ? (
        <BodySkeleton />
      ) : (
        <>
          {setup && <SetupChecklist items={setup} dismissed={dismissed} onDismiss={dismissItem} />}
          <DashboardBody data={data} attentionCount={attentionCount} />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- masthead -- */

/**
 * The band: the one bold surface in the product. Net income set like a
 * ledger cover figure over fine ruling, with the year's shape drawn beneath.
 */
function Masthead({ orgName, data }: { orgName: string; data: DashboardPayload | null }) {
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const m = data?.money;
  const positive = !m || m.netIncomeMinor >= 0;

  return (
    <section
      aria-label="Financial pulse"
      className="rise ledger-rules relative overflow-hidden rounded-2xl shadow-[0_12px_40px_-16px_rgb(0_0_0/0.45)]"
      style={
        {
          backgroundColor: "var(--band)",
          color: "var(--band-ink)",
          "--rule-color": "rgba(255, 255, 255, 0.055)",
          "--rise-delay": "0ms",
        } as React.CSSProperties
      }
    >
      {/* Soft sheen so the ink reads as cloth, not flat paint */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(110% 130% at 88% -20%, rgba(255,255,255,0.09), transparent 55%)" }}
      />

      <div className="relative p-4 sm:p-5 lg:p-6">
        {/* Orientation line + the workmate's quick handles */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="text-[11px] font-semibold tracking-[0.14em] uppercase opacity-60">
            {today}
            {orgName && (
              <>
                <span aria-hidden="true" className="mx-2 opacity-50">
                  ·
                </span>
                {orgName}
              </>
            )}
          </p>
          <nav aria-label="Ask your workmate" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 hidden items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase opacity-50 sm:flex">
              <IconSparkle className="size-3.5" />
              Ask
            </span>
            {ASK_ACTIONS.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => openChatWith(a.prompt)}
                className="cursor-pointer rounded-full border border-white/15 px-3 py-1 text-xs font-medium whitespace-nowrap text-current/80 transition-colors duration-150 hover:border-white/40 hover:bg-white/5 hover:text-current"
              >
                {a.label}
              </button>
            ))}
          </nav>
        </div>

        {/* The figure, with the working stats held at its flank */}
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-10 gap-y-4 sm:mt-3.5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.14em] uppercase opacity-60">Net income · to date</p>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
              {m ? (
                <p
                  className={`tnum text-3xl leading-none font-semibold tracking-tight sm:text-4xl ${
                    positive ? "" : "text-red-300"
                  }`}
                >
                  {formatMoneyWhole(m.netIncomeMinor)}
                </p>
              ) : (
                <span aria-hidden="true" className="inline-block h-8 w-48 animate-pulse rounded-lg bg-white/10 sm:h-10" />
              )}
              {m?.balanced != null &&
                (m.balanced ? (
                  <span className="badge border border-emerald-300/25 bg-emerald-400/15 text-emerald-200">
                    books balanced
                  </span>
                ) : (
                  <span className="badge border border-red-300/25 bg-red-400/15 text-red-200">
                    unbalanced — investigate
                  </span>
                ))}
              {m && data && <MonthDelta trend={data.trend} />}
            </div>
          </div>

          <dl className="tnum flex flex-wrap gap-x-8 gap-y-3 sm:gap-x-10">
            <Stat label="Revenue" value={m ? formatMoney(m.revenueMinor) : undefined} />
            <Stat label="Expenses" value={m ? formatMoney(m.expenseMinor) : undefined} />
            <Stat label="Cash" value={m ? (m.cashMinor === null ? "—" : formatMoney(m.cashMinor)) : undefined} />
          </dl>
        </div>

        {data && data.trend.length > 0 && (
          <TrendArea data={data.trend} />
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-[0.14em] uppercase opacity-50">{label}</dt>
      <dd className="mt-1 text-sm font-medium opacity-95 sm:text-base">
        {value ?? <span aria-hidden="true" className="inline-block h-4 w-20 animate-pulse rounded bg-white/10" />}
      </dd>
    </div>
  );
}

/** Month-over-month direction of net income; shown only when it can be honest. */
function MonthDelta({ trend }: { trend: DashboardPayload["trend"] }) {
  const delta = useMemo(() => {
    if (trend.length < 2) return null;
    const net = (d: { incomeMinor: number; expenseMinor: number }) => d.incomeMinor - d.expenseMinor;
    const last = net(trend[trend.length - 1]!);
    const prev = net(trend[trend.length - 2]!);
    if (prev === 0) return null;
    const pct = Math.round(((last - prev) / Math.abs(prev)) * 100);
    const prevMonth = monthLabel(trend[trend.length - 2]!.month);
    return { up: last >= prev, pct: Math.abs(pct), prevMonth };
  }, [trend]);

  if (!delta) return null;
  return (
    <span
      className={`inline-flex translate-y-[-4px] items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium tnum ${
        delta.up ? "bg-emerald-400/15 text-emerald-200" : "bg-red-400/15 text-red-200"
      }`}
    >
      {delta.up ? "↑" : "↓"} {delta.pct}% vs {delta.prevMonth}
    </span>
  );
}

function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleString(undefined, { month: "short" });
}

/* ------------------------------------------------------------------ chart -- */

type Pt = [number, number];

/** Catmull-Rom → cubic bézier: the year's shape as one continuous stroke. */
function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  const f = (n: number) => Number(n.toFixed(1));
  let d = `M ${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

function TrendArea({ data }: { data: DashboardPayload["trend"] }) {
  const gradId = useId();
  const W = 600;
  const H = 120;

  const n = data.length;
  const max = Math.max(1, ...data.flatMap((d) => [d.incomeMinor, d.expenseMinor]));
  const x = (i: number) => (n === 1 ? W / 2 : 6 + (i / (n - 1)) * (W - 12));
  const y = (v: number) => H - 18 - (v / max) * (H - 44);

  const incomePts = data.map((d, i) => [x(i), y(d.incomeMinor)] as Pt);
  const expensePts = data.map((d, i) => [x(i), y(d.expenseMinor)] as Pt);
  const incomeLine = smoothPath(incomePts);
  const expenseLine = smoothPath(expensePts);
  const area =
    incomeLine +
    ` L ${incomePts[incomePts.length - 1]![0]} ${H} L ${incomePts[0]![0]} ${H} Z`;
  const last = incomePts[incomePts.length - 1]!;

  return (
    <figure className="mt-3 sm:mt-4">
      <div className="relative">
        <svg
          role="img"
          aria-label={`Income vs expenses over the last ${n} month${n === 1 ? "" : "s"}. Latest month: income ${formatMoney(
            data[n - 1]!.incomeMinor,
          )}, expenses ${formatMoney(data[n - 1]!.expenseMinor)}.`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-12 w-full sm:h-14"
        >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--band-accent)" stopOpacity="0.30" />
            <stop offset="100%" stopColor="var(--band-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Ledger ruling continues through the chart at quarter height */}
        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1="0"
            x2={W}
            y1={18 + t * (H - 44)}
            y2={18 + t * (H - 44)}
            stroke="rgba(255,255,255,0.07)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {area && <path d={area} fill={`url(#${gradId})`} />}
        {expenseLine && (
          <path
            d={expenseLine}
            fill="none"
            stroke="rgba(255,255,255,0.38)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {incomeLine && (
          <path
            d={incomeLine}
            fill="none"
            stroke="var(--band-accent)"
            strokeWidth="2"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        </svg>

        {/* The live end of the line, positioned in HTML so it stays round */}
        {n > 1 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={
              {
                left: `${(last[0] / W) * 100}%`,
                top: `${(last[1] / H) * 100}%`,
                backgroundColor: "var(--band-accent)",
                "--tw-ring-color": "var(--band)",
              } as React.CSSProperties
            }
          />
        )}
      </div>

      <figcaption className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px]">
        <span className="flex gap-4 opacity-70">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-3.5 rounded-full" style={{ backgroundColor: "var(--band-accent)" }} />
            Income
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-0 w-3.5 border-t-2 border-dashed opacity-70"
              style={{ borderColor: "rgba(255,255,255,0.6)" }}
            />
            Expenses
          </span>
        </span>
        <span className="tnum flex gap-3 opacity-50">
          {data.slice(0, 9).map((d, i) => (
            <span key={d.month} className={i > 0 && i < n - 1 ? "hidden sm:inline" : undefined}>
              {monthLabel(d.month)}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------- setup list -- */

/**
 * What is expected of this workspace, computed live: each unfinished step
 * says why it matters and links straight to where it gets done. Two steps
 * stay visible; the rest fold away to keep the dashboard one screen.
 */
function SetupChecklist({
  items,
  dismissed,
  onDismiss,
}: {
  items: SetupItem[];
  dismissed: Set<string>;
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pending = items.filter((i) => !i.done && !dismissed.has(i.id));
  if (pending.length === 0) return null;
  const visible = expanded ? pending : pending.slice(0, 2);
  const hidden = pending.length - visible.length;

  return (
    <section
      aria-label="Workspace setup"
      className="rise mt-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-xs"
      style={{ "--rise-delay": "90ms" } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="figure-label">Get set up</p>
        <span className="text-xs text-stone-500">
          {pending.length} step{pending.length === 1 ? "" : "s"} left — a minute each, the workmate can help.
        </span>
      </div>
      <ol className="mt-1.5 divide-y divide-stone-100">
        {visible.map((item) => (
          <li key={item.id} className="group flex items-center gap-3 py-1.5 text-sm first:pt-0.5 last:pb-0">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-maroon-600" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-stone-900">{item.title}</span>
              <span className="text-xs text-stone-400"> — {item.why}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Link
                href={item.href}
                className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap text-maroon-800 hover:underline"
              >
                Take me there
                <IconArrowRight className="size-3 transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
              <button
                type="button"
                aria-label={`Hide "${item.title}"`}
                title="Hide this step"
                onClick={() => onDismiss(item.id)}
                className="cursor-pointer rounded px-1 text-[11px] text-stone-300 transition-colors hover:text-stone-700"
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={expanded}
          className="mt-1.5 cursor-pointer text-xs font-medium text-stone-500 transition-colors duration-150 hover:text-maroon-800"
        >
          Show {hidden} more step{hidden === 1 ? "" : "s"} ↓
        </button>
      )}
      {expanded && pending.length > 2 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded={expanded}
          className="mt-1.5 block cursor-pointer text-xs font-medium text-stone-500 transition-colors duration-150 hover:text-maroon-800"
        >
          Show fewer steps ↑
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- body -- */

function BodySkeleton() {
  return (
    <div className="mt-4 space-y-6" aria-hidden="true">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="skeleton h-52 rounded-xl" />
        <div className="skeleton h-52 rounded-xl" />
      </div>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="skeleton h-40 rounded-xl" />
        <div className="skeleton h-40 rounded-xl" />
        <div className="skeleton h-40 rounded-xl" />
      </div>
    </div>
  );
}

function DashboardBody({ data, attentionCount }: { data: DashboardPayload; attentionCount: number }) {
  return (
    <div className="mt-4 grid items-start gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-[1.1fr_1fr_1.1fr]">
      <NeedsYouQueue data={data} count={attentionCount} />
      <WorkingCapital data={data} />
      <div className="rise space-y-5 md:col-span-2 xl:col-span-1" style={{ "--rise-delay": "150ms" } as React.CSSProperties}>
        <Operations data={data} />
        <ActivityFeed activity={data.activity.slice(0, 3)} embedded />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- needs you ----- */

/**
 * The queue: every item is one sentence ending in a verb. Severity is a dot,
 * not a siren; the point is triage, not alarm. Whole rows are links.
 */
function NeedsYouQueue({ data, count }: { data: DashboardPayload; count: number }) {
  type Item = { key: string; severity: "high" | "med" | "low"; text: React.ReactNode; href: string; cta: string };
  const items: Item[] = [];
  if (data.money.balanced === false)
    items.push({
      key: "balance",
      severity: "high",
      text: <>Books are unbalanced — treat as corruption.</>,
      href: "/accounting",
      cta: "investigate",
    });
  if (data.ops.pendingApprovals > 0)
    items.push({
      key: "approvals",
      severity: "high",
      text: (
        <>
          <strong>{data.ops.pendingApprovals}</strong> action{data.ops.pendingApprovals === 1 ? "" : "s"} waiting on your
          approval
        </>
      ),
      href: "/approvals",
      cta: "review",
    });
  if (data.workingCapital.overdueCount > 0)
    items.push({
      key: "overdue",
      severity: "high",
      text: (
        <>
          <strong>{data.workingCapital.overdueCount}</strong> invoice{data.workingCapital.overdueCount === 1 ? "" : "s"}{" "}
          overdue, {formatMoney(data.workingCapital.overdueAmountMinor)} outstanding
        </>
      ),
      href: "/accounting",
      cta: "chase",
    });
  if (data.workingCapital.apOutstandingMinor > 0)
    items.push({
      key: "bills",
      severity: "med",
      text: (
        <>
          Vendor bills due: <strong>{formatMoney(data.workingCapital.apOutstandingMinor)}</strong>
        </>
      ),
      href: "/accounting",
      cta: "pay",
    });
  if (data.ops.lowStock.length > 0)
    items.push({
      key: "stock",
      severity: "med",
      text: <>Low stock: {data.ops.lowStock.map((l) => l.name || l.sku).join(", ")}</>,
      href: "/inventory",
      cta: "restock",
    });
  for (const signal of data.signals ?? []) {
    const href =
      signal.module === "inventory" ? "/inventory" :
      signal.module === "accounting" ? "/accounting" :
      signal.module === "crm" ? "/crm" :
      signal.module === "pos" ? "/pos" :
      signal.module === "hr" ? "/hr" :
      signal.module === "purchasing" ? "/purchasing" : "/";
    items.push({
      key: signal.id,
      severity: signal.severity === "red" ? "high" : signal.severity === "orange" ? "med" : "low",
      text: <>{signal.subject}</>,
      href,
      cta: "review",
    });
  }
  if (data.ops.pendingLeave > 0)
    items.push({
      key: "leave",
      severity: "low",
      text: (
        <>
          <strong>{data.ops.pendingLeave}</strong> leave request{data.ops.pendingLeave === 1 ? "" : "s"} awaiting decision
        </>
      ),
      href: "/hr",
      cta: "decide",
    });

  const dot: Record<Item["severity"], string> = {
    high: "bg-red-500",
    med: "bg-amber-500",
    low: "bg-sky-500",
  };

  return (
    <section aria-label="Needs you" className="rise" style={{ "--rise-delay": "60ms" } as React.CSSProperties}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="figure-label">
          Needs you
          {count > 0 && (
            <span className="tnum ml-2 inline-flex -translate-y-px items-center rounded-full bg-maroon-100 px-2 py-0.5 text-[11px] text-maroon-800">
              {count}
            </span>
          )}
        </p>
        {items.length === 0 && <span className="text-xs text-stone-400">All clear</span>}
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-200 bg-white/50 px-5 py-8 text-center">
          <IconSparkle className="mx-auto size-4 text-stone-300" />
          <p className="mt-2 text-sm leading-relaxed text-stone-500">
            Nothing needs you right now.
            <br />
            The business is running itself.
          </p>
        </div>
      ) : (
        <ol className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xs">
          {items.map((item) => (
            <li key={item.key}>
              <Link href={item.href} className="group flex items-center gap-3 px-4 py-2.5 transition-colors duration-100 hover:bg-stone-50">
                <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot[item.severity]}`} />
                <span className="min-w-0 flex-1 text-sm leading-relaxed text-stone-700">{item.text}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium whitespace-nowrap text-maroon-800">
                  {item.cta}
                  <IconArrowRight className="size-3 transition-transform duration-150 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------ working capital ---- */

function WorkingCapital({ data }: { data: DashboardPayload }) {
  return (
    <aside aria-label="Working capital" className="rise" style={{ "--rise-delay": "100ms" } as React.CSSProperties}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="figure-label">Working capital</p>
        <Link href="/accounting" className="text-xs font-medium text-maroon-800 hover:underline">
          Open books →
        </Link>
      </div>

      <dl className="rounded-xl border border-stone-200 bg-white px-4 py-2 shadow-xs">
        <FigureRow
          label="Receivables outstanding"
          value={formatMoney(data.workingCapital.arOutstandingMinor)}
          note={data.workingCapital.overdueCount > 0 ? `${data.workingCapital.overdueCount} overdue` : undefined}
          tone={data.workingCapital.overdueCount > 0 ? "warn" : "default"}
        />
        <FigureRow label="Payables due" value={formatMoney(data.workingCapital.apOutstandingMinor)} />
        <FigureRow
          label={`Weighted pipeline · ${data.pipeline.openCount} open`}
          value={formatMoneyWhole(data.pipeline.weightedForecastMinor)}
        />
      </dl>

      <FunnelBar stages={data.pipeline.stages} />
    </aside>
  );
}

function FigureRow({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-stone-100 py-1.5 last:border-0">
      <dt className="text-[13px] text-stone-500">{label}</dt>
      <dd className="flex items-baseline gap-2">
        {note && (
          <span className={tone === "warn" ? "text-xs font-medium text-amber-700" : "text-xs text-stone-400"}>{note}</span>
        )}
        <span className="tnum text-sm font-medium text-stone-900">{value}</span>
      </dd>
    </div>
  );
}

function FunnelBar({ stages }: { stages: DashboardPayload["pipeline"]["stages"] }) {
  const total = Math.max(1, stages.reduce((s, x) => s + x.count, 0));
  const tones: Record<string, string> = {
    lead: "bg-stone-300",
    qualified: "bg-maroon-300",
    proposal: "bg-maroon-500",
    negotiation: "bg-maroon-700",
    won: "bg-emerald-600",
    lost: "bg-red-300",
  };
  return (
    <div className="mt-3 rounded-xl border border-stone-200 bg-white p-3 shadow-xs">
      <p className="figure-label mb-2.5">Pipeline by stage</p>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-stone-100">
        {stages.map(
          (s) =>
            s.count > 0 && (
              <div
                key={s.stage}
                className={`${tones[s.stage]} h-full transition-[width] duration-500`}
                style={{ width: `${(s.count / total) * 100}%` }}
                title={`${s.stage}: ${s.count}`}
              />
            ),
        )}
      </div>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-500 sm:grid-cols-3">
        {stages.map((s) => (
          <li key={s.stage} className="flex items-center justify-between gap-2 capitalize">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`size-2 rounded-full ${tones[s.stage]}`} />
              {s.stage}
            </span>
            <span className="tnum">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------ operations --- */

function Operations({ data }: { data: DashboardPayload }) {
  return (
    <div aria-label="Operations">
      <p className="figure-label mb-3">Operations</p>
      <ul className="space-y-2 text-sm text-stone-600">
        {data.ops.posOpen && (
          <OpRow tone="bg-emerald-500">Register “{data.ops.posOpen.register}” is open</OpRow>
        )}
        {data.ops.lowStock.length > 0 && (
          <OpRow tone="bg-amber-500">
            {data.ops.lowStock.length} item{data.ops.lowStock.length === 1 ? "" : "s"} at reorder point
          </OpRow>
        )}
        {data.ops.docsAwaitingCoding > 0 && (
          <OpRow tone="bg-sky-500">
            {data.ops.docsAwaitingCoding} document{data.ops.docsAwaitingCoding === 1 ? "" : "s"} awaiting coding
          </OpRow>
        )}
        {data.ops.headcount > 0 && (
          <OpRow tone="bg-stone-300">
            {data.ops.headcount} on the team
            {data.ops.pendingLeave > 0 ? `, ${data.ops.pendingLeave} leave pending` : ""}
          </OpRow>
        )}
        {!data.ops.posOpen &&
          data.ops.lowStock.length === 0 &&
          data.ops.docsAwaitingCoding === 0 &&
          data.ops.headcount === 0 && <li className="text-stone-400">Quiet across the floor.</li>}
      </ul>
    </div>
  );
}

function OpRow({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone}`} />
      {children}
    </li>
  );
}

/* --------------------------------------------------------------- ledger ---- */

function ActivityFeed({ activity, embedded = false }: { activity: DashboardPayload["activity"]; embedded?: boolean }) {
  return (
    <section
      aria-label="Recent ledger activity"
      className={embedded ? "" : "mt-8 border-t border-stone-200 pt-5 pb-20 lg:pb-4"}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="figure-label">Ledger · recent</p>
        <Link href="/ledger" className="text-xs font-medium text-maroon-800 hover:underline">
          View all →
        </Link>
      </div>
      {activity.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">Nothing recorded yet.</p>
      ) : (
        <ol className="mt-3 space-y-0">
          {activity.map((e, i) => (
            <li key={e.seq} className="relative flex items-center gap-2.5 py-1.5 pl-4 text-[13px]">
              {/* Timeline spine */}
              <span
                aria-hidden="true"
                title={e.actorType}
                className={`absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full ${
                  e.actorType === "agent" ? "bg-violet-500" : e.actorType === "human" ? "bg-sky-500" : "bg-stone-300"
                }`}
              />
              {i < activity.length - 1 && (
                <span aria-hidden="true" className="absolute left-[2.5px] top-1/2 h-full w-px bg-stone-100" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-600">{e.capabilityId ?? e.kind}</span>
              {e.actorType === "agent" && (
                <span className="badge badge-violet hidden shrink-0 text-[10px] sm:inline-flex">agent</span>
              )}
              <time className="tnum shrink-0 text-[11px] text-stone-400">{timeAgo(e.occurredAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
