"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { callApi } from "@/lib/api";
import { formatMoney, formatMoneyWhole, timeAgo } from "@/lib/format";
import { Badge } from "@/components/ui";
import { IconArrowRight, IconSparkle } from "@/components/icons";

/**
 * The home dashboard: a command center answering three questions in order —
 * how is the business doing (financial pulse), what needs me (the queue),
 * what is moving (pipeline, operations, the event ledger).
 */

interface DashboardPayload {
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

  useEffect(() => {
    void (async () => {
      const res = await callApi<DashboardPayload>("/api/dashboard");
      if (!res.data) setError(res.error?.title ?? "Could not load your dashboard");
      else setData(res.data);
    })();
  }, []);

  const attentionCount = data
    ? data.ops.pendingApprovals +
      data.workingCapital.overdueCount +
      data.ops.lowStock.length +
      data.ops.pendingLeave +
      (data.workingCapital.apOutstandingMinor > 0 ? 1 : 0)
    : 0;

  return (
    <div className="mx-auto max-w-6xl">
      {/* Masthead: quiet orientation, no confetti */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <p className="figure-label">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-stone-900">{orgName}</h1>
        </div>
        <nav aria-label="Ask your co-worker" className="flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-1 text-xs text-stone-400 sm:flex">
            <IconSparkle className="size-3.5" />
            Ask
          </span>
          {ASK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => openChatWith(a.prompt)}
              className="cursor-pointer rounded-full border border-stone-200 px-3 py-1 text-xs font-medium text-stone-500 transition-colors duration-150 hover:border-maroon-300 hover:text-maroon-900"
            >
              {a.label}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <p className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      {!data ? (
        <div className="mt-8 space-y-6">
          <div className="h-40 animate-pulse rounded-xl bg-stone-100" />
          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <div className="h-56 animate-pulse rounded-xl bg-stone-100" />
            <div className="h-56 animate-pulse rounded-xl bg-stone-100" />
          </div>
        </div>
      ) : (
        <>
          <DashboardBody data={data} attentionCount={attentionCount} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ body -- */

function DashboardBody({ data, attentionCount }: { data: DashboardPayload; attentionCount: number }) {
  return (
    <div className="mt-5">
      {/* The pulse: open composition, no card walls */}
      <section aria-label="Financial pulse" className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <FinancialPulse data={data} />
        <NeedsYouQueue data={data} count={attentionCount} />
      </section>

      {/* What is moving */}
      <section
        aria-label="Working capital and operations"
        className="mt-8 grid gap-x-8 gap-y-6 border-t border-stone-200 pt-5 md:grid-cols-3"
      >
        <div>
          <p className="figure-label mb-3">Working capital</p>
          <dl className="space-y-2.5 text-sm">
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
        </div>

        <div>
          <p className="figure-label mb-3">Operations</p>
          <ul className="space-y-2 text-sm text-stone-600">
            {data.ops.posOpen && (
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
                Register “{data.ops.posOpen.register}” is open
              </li>
            )}
            {data.ops.lowStock.length > 0 && (
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
                {data.ops.lowStock.length} item{data.ops.lowStock.length === 1 ? "" : "s"} at reorder point
              </li>
            )}
            {data.ops.docsAwaitingCoding > 0 && (
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-sky-500" />
                {data.ops.docsAwaitingCoding} document{data.ops.docsAwaitingCoding === 1 ? "" : "s"} awaiting coding
              </li>
            )}
            {data.ops.headcount > 0 && (
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-stone-300" />
                {data.ops.headcount} on the team
                {data.ops.pendingLeave > 0 ? `, ${data.ops.pendingLeave} leave pending` : ""}
              </li>
            )}
            {!data.ops.posOpen &&
              data.ops.lowStock.length === 0 &&
              data.ops.docsAwaitingCoding === 0 &&
              data.ops.headcount === 0 && <li className="text-stone-400">Quiet across the floor.</li>}
          </ul>
        </div>
      </section>

      {/* The ledger, alive */}
      <ActivityFeed activity={data.activity} />
    </div>
  );
}

function FinancialPulse({ data }: { data: DashboardPayload }) {
  const m = data.money;
  const positive = m.netIncomeMinor >= 0;
  return (
    <div>
      <p className="figure-label mb-3">Net income · to date</p>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <p
          className={`tnum text-[44px] leading-none font-semibold tracking-tight ${
            positive ? "text-stone-900" : "text-red-700"
          }`}
        >
          {formatMoney(m.netIncomeMinor)}
        </p>
        {m.balanced !== null &&
          (m.balanced ? (
            <Badge tone="green">books balanced</Badge>
          ) : (
            <Badge tone="red">unbalanced — investigate</Badge>
          ))}
      </div>
      <p className="tnum mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-stone-500">
        <span>
          Revenue <strong className="font-medium text-stone-800">{formatMoney(m.revenueMinor)}</strong>
        </span>
        <span>
          Expenses <strong className="font-medium text-stone-800">{formatMoney(m.expenseMinor)}</strong>
        </span>
        <span>
          Cash{" "}
          <strong className="font-medium text-stone-800">
            {m.cashMinor === null ? "—" : formatMoney(m.cashMinor)}
          </strong>
        </span>
      </p>
      <TrendChart data={data.trend} />
    </div>
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
    <div className="flex items-baseline justify-between gap-3 border-b border-stone-100 pb-2 last:border-0 last:pb-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="flex items-baseline gap-2">
        {note && (
          <span className={tone === "warn" ? "text-xs font-medium text-amber-700" : "text-xs text-stone-400"}>{note}</span>
        )}
        <span className="tnum font-medium text-stone-900">{value}</span>
      </dd>
    </div>
  );
}

function TrendChart({ data }: { data: DashboardPayload["trend"] }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.flatMap((d) => [d.incomeMinor, d.expenseMinor]));
  return (
    <div className="mt-5">
      <div className="flex h-28 items-end gap-3 border-b border-stone-200 pb-px">
        {data.map((d) => (
          <div key={d.month} className="flex h-full flex-1 items-end justify-center">
            <div
              role="img"
              aria-label={`${d.month}: income ${formatMoney(d.incomeMinor)}, expenses ${formatMoney(d.expenseMinor)}`}
              className="flex h-full w-full max-w-12 items-end justify-center gap-1"
            >
              <div
                className="w-1/3 rounded-t-[3px] bg-maroon-600/90 transition-colors duration-150 hover:bg-maroon-500"
                style={{ height: `${Math.max(1.5, (d.incomeMinor / max) * 100)}%` }}
                title={`Income ${formatMoney(d.incomeMinor)}`}
              />
              <div
                className="w-1/3 rounded-t-[3px] bg-stone-200 transition-colors duration-150 hover:bg-stone-300"
                style={{ height: `${Math.max(1.5, (d.expenseMinor / max) * 100)}%` }}
                title={`Expenses ${formatMoney(d.expenseMinor)}`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-stone-400">
        <span className="flex gap-4">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-sm bg-maroon-600/90" /> Income
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-sm bg-stone-200 ring-1 ring-stone-300" /> Expenses
          </span>
        </span>
        <span className="tnum">{data.map((d) => d.month.slice(5)).join(" · ")}</span>
      </div>
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
    <div className="mt-3">
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {stages.map(
          (s) =>
            s.count > 0 && (
              <div
                key={s.stage}
                className={`${tones[s.stage]} h-full`}
                style={{ width: `${(s.count / total) * 100}%` }}
                title={`${s.stage}: ${s.count}`}
              />
            ),
        )}
      </div>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-500">
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

/**
 * The queue: every item is one sentence ending in a verb. Severity is a dot,
 * not a siren; the point is triage, not alarm.
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
    <aside aria-label="Needs you">
      <p className="figure-label mb-3">
        Needs you
        {count > 0 && (
          <span className="ml-2 rounded-full bg-maroon-100 px-2 py-0.5 text-[11px] text-maroon-800">{count}</span>
        )}
      </p>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-200 px-4 py-6">
          <IconSparkle className="size-4 text-stone-300" />
          <p className="mt-2 text-sm leading-relaxed text-stone-500">
            Nothing needs you right now.
            <br />
            The business is running itself.
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-2.5 text-sm leading-relaxed">
              <span aria-hidden="true" className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dot[item.severity]}`} />
              <span className="min-w-0 flex-1 text-stone-700">
                {item.text}
                <Link
                  href={item.href}
                  className="ml-1.5 inline-flex items-center gap-0.5 font-medium whitespace-nowrap text-maroon-800 hover:underline"
                >
                  {item.cta}
                  <IconArrowRight className="size-3" />
                </Link>
              </span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function ActivityFeed({ activity }: { activity: DashboardPayload["activity"] }) {
  return (
    <section aria-label="Recent ledger activity" className="mt-8 border-t border-stone-200 pt-5 pb-20 lg:pb-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="figure-label">Ledger · recent</p>
        <Link href="/ledger" className="text-[13px] font-medium text-maroon-800 hover:underline">
          View all →
        </Link>
      </div>
      {activity.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">Nothing recorded yet.</p>
      ) : (
        <ol className="mt-4 space-y-0">
          {activity.map((e, i) => (
            <li key={e.seq} className="relative flex items-center gap-3 py-1.5 pl-5 text-sm">
              {/* Timeline spine */}
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full ${
                  e.actorType === "agent" ? "bg-violet-500" : e.actorType === "human" ? "bg-sky-500" : "bg-stone-300"
                }`}
              />
              {i < activity.length - 1 && (
                <span aria-hidden="true" className="absolute left-[2.5px] top-1/2 h-full w-px bg-stone-100" />
              )}
              <Badge tone={e.actorType === "agent" ? "violet" : e.actorType === "human" ? "blue" : "neutral"}>
                {e.actorType}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-stone-600">{e.capabilityId ?? e.kind}</span>
              <time className="shrink-0 text-xs text-stone-400">{timeAgo(e.occurredAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
