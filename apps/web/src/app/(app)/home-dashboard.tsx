"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { callApi } from "@/lib/api";
import { formatMoney, timeAgo } from "@/lib/format";
import { Badge, StatCard } from "@/components/ui";

/**
 * The home dashboard: one screen answering "how is the business doing and
 * what needs me right now". Fed by a single /api/dashboard aggregation.
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

const QUICK_ACTIONS = [
  { label: "Draft an invoice", prompt: "Draft an invoice for a customer. Ask me for the details you need." },
  { label: "Record a bill", prompt: "Help me record a vendor bill we received." },
  { label: "Check low stock", prompt: "Which items are at or below their reorder point?" },
  { label: "Where is my cash?", prompt: "Give me the cash position: cash balance in, out, and net this month." },
];

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

  function openChatWith(prompt: string) {
    void (async () => {
      const { chatDraft, chatDock } = await import("./chat-widget-state");
      chatDock.set("open");
      chatDraft.set(prompt);
    })();
  }

  return (
    <div>
      {/* Greeting + quick actions */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">
            {greeting()}, {orgName}
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            {new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => openChatWith(a.prompt)}
              className="cursor-pointer rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-[13px] font-medium text-stone-600 shadow-xs transition-colors duration-150 hover:border-maroon-300 hover:bg-maroon-50/60 hover:text-maroon-900"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      {!data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-stone-100" />
          ))}
        </div>
      ) : (
        <>
          {/* KPI row */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Revenue to date" value={formatMoney(data.money.revenueMinor)} tone="accent" />
            <StatCard
              label="Net income"
              value={formatMoney(data.money.netIncomeMinor)}
              tone={data.money.netIncomeMinor >= 0 ? "success" : "danger"}
            />
            <StatCard label="Cash on hand" value={data.money.cashMinor === null ? "-" : formatMoney(data.money.cashMinor)} />
            <StatCard
              label="Receivables"
              value={formatMoney(data.workingCapital.arOutstandingMinor)}
              sub={
                data.workingCapital.overdueCount > 0
                  ? `${data.workingCapital.overdueCount} overdue (>30d)`
                  : undefined
              }
              tone={data.workingCapital.overdueCount > 0 ? "warn" : "default"}
            />
            <StatCard label="Payables" value={formatMoney(data.workingCapital.apOutstandingMinor)} />
            <StatCard
              label="Weighted pipeline"
              value={formatMoney(data.pipeline.weightedForecastMinor)}
              sub={`${data.pipeline.openCount} open deals`}
            />
          </section>

          {/* Charts row */}
          <section className="mt-6 grid gap-4 lg:grid-cols-5">
            <div className="card p-5 lg:col-span-3">
              <p className="text-xs font-semibold tracking-wide text-stone-400 uppercase">Income vs expenses, last 6 months</p>
              <MiniBars data={data.trend} />
            </div>
            <div className="card p-5 lg:col-span-2">
              <p className="text-xs font-semibold tracking-wide text-stone-400 uppercase">Books integrity</p>
              <div className="mt-3 flex items-center gap-2">
                {data.money.balanced ? (
                  <>
                    <Badge tone="green">balanced</Badge>
                    <span className="text-sm text-stone-600">Assets equal liabilities plus equity.</span>
                  </>
                ) : (
                  <>
                    <Badge tone="red">unbalanced</Badge>
                    <span className="text-sm text-red-700">Treat as corruption and investigate before trusting figures.</span>
                  </>
                )}
              </div>
              <dl className="mt-4 space-y-1.5 text-sm">
                <Row label="Assets" value={formatMoney(data.money.assetsMinor)} />
                <Row label="Liabilities" value={formatMoney(data.money.liabilitiesMinor)} />
                <Row label="Equity incl. result" value={formatMoney(data.money.equityMinor)} />
              </dl>
              <Link href="/accounting" className="mt-4 inline-block text-[13px] font-medium text-maroon-800 hover:underline">
                Open accounting →
              </Link>
            </div>
          </section>

          {/* Attention + activity */}
          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <NeedsAttention data={data} />
            <ActivityFeed activity={data.activity} />
          </section>

          {/* Ops strip */}
          <section className="mt-6 grid gap-4 md:grid-cols-3">
            <OpsTile title="Pipeline" href="/crm">
              <FunnelBar stages={data.pipeline.stages} />
            </OpsTile>
            <OpsTile title="People" href="/hr">
              <p className="text-2xl font-semibold tracking-tight text-stone-900">{data.ops.headcount}</p>
              <p className="text-xs text-stone-500">
                active employees
                {data.ops.pendingLeave > 0 ? `, ${data.ops.pendingLeave} leave request${data.ops.pendingLeave === 1 ? "" : "s"} waiting` : ""}
              </p>
            </OpsTile>
            <OpsTile title="Point of sale" href="/pos">
              {data.ops.posOpen ? (
                <p className="flex items-center gap-2 text-sm text-stone-700">
                  <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
                  Register "{data.ops.posOpen.register}" is open
                </p>
              ) : (
                <p className="text-sm text-stone-500">No register session open.</p>
              )}
              {(data.ops.docsAwaitingCoding > 0 || data.ops.docsParsed > 0) && (
                <p className="mt-1 text-xs text-stone-500">
                  Documents: {data.ops.docsParsed} parsed{data.ops.docsAwaitingCoding > 0 ? `, ${data.ops.docsAwaitingCoding} awaiting coding` : ""}
                </p>
              )}
            </OpsTile>
          </section>
        </>
      )}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-stone-500">{label}</dt>
      <dd className="num font-medium text-stone-800">{value}</dd>
    </div>
  );
}

/** Dependency-free SVG paired-bar chart for the 6-month trend. */
function MiniBars({ data }: { data: DashboardPayload["trend"] }) {
  const max = Math.max(1, ...data.flatMap((d) => [d.incomeMinor, d.expenseMinor]));
  return (
    <div className="mt-4">
      <div className="flex h-36 items-end justify-between gap-3">
        {data.map((d) => (
          <div key={d.month} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex h-28 w-full items-end justify-center gap-1" role="img" aria-label={`${d.month}: income ${formatMoney(d.incomeMinor)}, expenses ${formatMoney(d.expenseMinor)}`}>
              <div
                className="w-1/3 rounded-t bg-maroon-700/85"
                style={{ height: `${Math.max(2, (d.incomeMinor / max) * 100)}%` }}
                title={`Income ${formatMoney(d.incomeMinor)}`}
              />
              <div
                className="w-1/3 rounded-t bg-stone-300"
                style={{ height: `${Math.max(2, (d.expenseMinor / max) * 100)}%` }}
                title={`Expenses ${formatMoney(d.expenseMinor)}`}
              />
            </div>
            <span className="text-[10px] tabular-nums text-stone-400">{d.month.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-stone-500">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-maroon-700/85" /> Income</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-stone-300" /> Expenses</span>
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
    <div>
      <div className="flex h-3 overflow-hidden rounded-full">
        {stages.map((s) =>
          s.count > 0 ? (
            <div key={s.stage} className={`${tones[s.stage]} h-full`} style={{ width: `${(s.count / total) * 100}%` }} title={`${s.stage}: ${s.count}`} />
          ) : null,
        )}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-600 sm:grid-cols-3">
        {stages.map((s) => (
          <li key={s.stage} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 capitalize">
              <span className={`size-2 rounded-full ${tones[s.stage]}`} aria-hidden="true" />
              {s.stage}
            </span>
            <span className="tnum">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NeedsAttention({ data }: { data: DashboardPayload }) {
  type Item = { key: string; node: React.ReactNode };
  const items: Item[] = [];
  if (data.ops.pendingApprovals > 0)
    items.push({
      key: "approvals",
      node: (
        <>
          <strong>{data.ops.pendingApprovals}</strong> approval{data.ops.pendingApprovals === 1 ? "" : "s"} waiting ·{" "}
          <Link href="/approvals" className="font-medium text-maroon-800 hover:underline">review</Link>
        </>
      ),
    });
  if (data.workingCapital.overdueCount > 0)
    items.push({
      key: "overdue",
      node: (
        <>
          <strong>{data.workingCapital.overdueCount}</strong> invoice{data.workingCapital.overdueCount === 1 ? "" : "s"} overdue,{" "}
          {formatMoney(data.workingCapital.overdueAmountMinor)} outstanding ·{" "}
          <Link href="/accounting" className="font-medium text-maroon-800 hover:underline">chase</Link>
        </>
      ),
    });
  if (data.ops.lowStock.length > 0)
    items.push({
      key: "stock",
      node: (
        <>
          Low stock: {data.ops.lowStock.map((l) => l.name || l.sku).join(", ")} ·{" "}
          <Link href="/inventory" className="font-medium text-maroon-800 hover:underline">restock</Link>
        </>
      ),
    });
  if (data.workingCapital.apOutstandingMinor > 0)
    items.push({
      key: "bills",
      node: (
        <>
          Vendor bills due: <strong>{formatMoney(data.workingCapital.apOutstandingMinor)}</strong> ·{" "}
          <Link href="/accounting" className="font-medium text-maroon-800 hover:underline">pay</Link>
        </>
      ),
    });
  if (data.ops.pendingLeave > 0)
    items.push({
      key: "leave",
      node: (
        <>
          <strong>{data.ops.pendingLeave}</strong> leave request{data.ops.pendingLeave === 1 ? "" : "s"} awaiting decision ·{" "}
          <Link href="/hr" className="font-medium text-maroon-800 hover:underline">decide</Link>
        </>
      ),
    });

  return (
    <div className="card p-5">
      <p className="text-xs font-semibold tracking-wide text-stone-400 uppercase">Needs attention</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">Nothing urgent. Enjoy the calm.</p>
      ) : (
        <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-stone-700">
          {items.map((i) => (
            <li key={i.key}>{i.node}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityFeed({ activity }: { activity: DashboardPayload["activity"] }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold tracking-wide text-stone-400 uppercase">Recent ledger activity</p>
        <Link href="/ledger" className="text-[13px] font-medium text-maroon-800 hover:underline">
          View all →
        </Link>
      </div>
      {activity.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {activity.map((e) => (
            <li key={e.seq} className="flex items-center gap-2.5">
              <Badge tone={e.actorType === "agent" ? "violet" : e.actorType === "human" ? "blue" : "neutral"}>{e.actorType}</Badge>
              <span className="min-w-0 flex-1 truncate text-stone-700">{e.capabilityId ?? e.kind}</span>
              <time className="shrink-0 text-xs text-stone-400">{timeAgo(e.occurredAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpsTile({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold tracking-wide text-stone-400 uppercase">{title}</p>
        <Link href={href} className="text-[13px] text-maroon-800 hover:underline">
          Open →
        </Link>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}
