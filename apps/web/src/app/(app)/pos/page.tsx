"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  LoadingPage,
  ActionNotice,
  StatCard,
  type ActionNoticeState,
  SegmentedControl,
} from "@/components/ui";
import { IconCard, IconCash, IconLock, IconPlus, IconTrash, IconUndo } from "@/components/icons";
import { cn, formatMoney, statusTone, timeAgo, toMinor } from "@/lib/format";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "sell" | "sessions";

interface PosSession {
  id: string;
  register: string;
  status: string;
  openingFloatMinor: number;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  openedAt: string;
  closedAt: string | null;
}
interface SaleLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
}
interface PosSale {
  id: string;
  number: number;
  status: string;
  totalMinor: number;
  creditedMinor: number;
  memo: string | null;
  createdAt: string;
}
interface ShiftSummary {
  register: string;
  status: string;
  salesCount: number;
  takingsMinor: number;
  expectedCashMinor: number;
  countedCashMinor: number | null;
  varianceMinor: number | null;
}

export default function PosPage() {
  const __enabled = useModuleEnabled("pos");
  const router = useRouter();
  const [sessions, setSessions] = useState<PosSession[] | null>(null);
  const [float, setFloat] = useState("100");
  const [line, setLine] = useState({ description: "", price: "" });
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [counted, setCounted] = useState("");
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [sales, setSales] = useState<PosSale[]>([]);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);

  const openSession = sessions?.find((s) => s.status === "open") ?? null;
  const openSessionId = openSession?.id ?? null;

  const load = useCallback(async () => {
    const res = await callApi<{ sessions?: PosSession[]; sales?: PosSale[] }>("/api/pos");
    setSessions(res.data?.sessions ?? []);
    setSales(res.data?.sales ?? []);
    if (!res.ok) setNotice({ tone: "error", error: res.error! });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSummary = useCallback(async (sessionId: string) => {
    const res = await postApi<{ data?: ShiftSummary }>("/api/pos", { action: "shiftSummary", sessionId });
    setSummary(res.data?.data ?? null);
  }, []);

  // Re-derived whenever sessions reload so a fresh sale is counted immediately.
  useEffect(() => {
    if (!openSessionId) {
      setSummary(null);
      return;
    }
    void loadSummary(openSessionId);
  }, [openSessionId, sessions, loadSummary]);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi<{ data?: { expectedCashMinor: number; varianceMinor: number } }>("/api/pos", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} requires approval.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else if (payload.action === "close" && res.data?.data) {
        const d = res.data.data;
        setNotice(
          d.varianceMinor === 0
            ? { tone: "success", text: `Drawer balanced exactly at ${formatMoney(d.expectedCashMinor)}.` }
            : {
                tone: "error",
                error: {
                  title: `Drawer variance of ${formatMoney(d.varianceMinor)} recorded`,
                  hint: `Expected ${formatMoney(d.expectedCashMinor)}. The difference is flagged for review and can't be edited away.`,
                  detail: `POS close-session\nexpected cash: ${d.expectedCashMinor}\nvariance: ${d.varianceMinor}`,
                },
              },
        );
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      void load();
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function returnSale(sale: PosSale) {
    const reason = window.prompt(`Reason for returning sale #${sale.number} (${formatMoney(sale.totalMinor)})?`);
    const trimmed = reason?.trim() ?? "";
    if (!trimmed) return;
    if (trimmed.length < 3 || trimmed.length > 500) {
      setNotice({
        tone: "error",
        error: { title: "Add a short reason", hint: "A return needs a reason between 3 and 500 characters for the audit trail." },
      });
      return;
    }
    setBusy(true);
    try {
      const res = await postApi<{ data?: { creditedMinor: number; restockedLines: number } }>("/api/pos", {
        action: "returnSale",
        invoiceId: sale.id,
        reason: trimmed,
      });
      if (res.status === 202) {
        setNotice({
          tone: "pending",
          text: `Return of sale #${sale.number} is awaiting human approval — it posts once approved in the Approvals inbox.`,
        });
      } else if (!res.ok || !res.data?.data) {
        setNotice({ tone: "error", error: res.error ?? { title: "That didn't work", hint: "Try again in a moment." } });
      } else {
        const d = res.data.data;
        setNotice({
          tone: "success",
          text: `Return posted — ${formatMoney(d.creditedMinor)} credited, ${d.restockedLines} line${d.restockedLines === 1 ? "" : "s"} restocked.`,
        });
      }
      void load();
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  function addLine(e: React.FormEvent) {
    e.preventDefault();
    if (!line.description.trim() || !line.price) return;
    setLines((l) => [...l, { description: line.description.trim(), quantity: 1000, unitPriceMinor: toMinor(line.price) }]);
    setLine({ description: "", price: "" });
  }

  if (!sessions) return <LoadingPage />;

  const total = lines.reduce((s, l) => s + l.unitPriceMinor, 0);
  const expectedCash = openSession ? openSession.openingFloatMinor + (openSession.expectedCashMinor ?? 0) : 0;
  const liveVariance = counted ? toMinor(counted) - expectedCash : null;

  if (!__enabled) return <ModuleDisabled label="Point of sale" />;

  const openSessions = sessions.filter((s) => s.status === "open");
  const varianceSessions = sessions.filter((s) => s.varianceMinor !== null && s.varianceMinor !== 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const closedToday = sessions.filter(
    (s) => s.closedAt && new Date(s.closedAt).getTime() >= todayStart.getTime(),
  );

  return (
    <AppFrame
      appId="pos"
      description="Sales post instantly to the ledger as one balanced entry. Closing counts the drawer, variances are recorded, never smoothed over."
      persistKey="pos"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "sell", label: openSession ? "Sell · register open" : "Sell" },
        { id: "sessions", label: "Sessions", count: sessions.length || undefined },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Register"
              value={openSession ? openSession.register : "closed"}
              sub={openSession ? `open since ${timeAgo(openSession.openedAt)}` : "no session running"}
              tone={openSession ? "success" : "default"}
            />
            <StatCard label="Expected in drawer" value={openSession ? formatMoney(expectedCash) : "—"} />
            <StatCard
              label="Closed today"
              value={closedToday.length}
              sub={varianceSessions.length > 0 ? `${varianceSessions.length} variance flag` : undefined}
            />
            <StatCard
              label="Variance flags"
              value={varianceSessions.length}
              tone={varianceSessions.length > 0 ? "warn" : "default"}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>The floor right now</CardTitle>
              {openSession ? (
                <ul className="space-y-2 text-sm">
                  <li className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
                    “{openSession.register}” is open — float {formatMoney(openSession.openingFloatMinor)}
                  </li>
                  <li className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-stone-300" />
                    {openSessions.length > 1 ? `${openSessions.length} registers open` : "One register running"}
                  </li>
                </ul>
              ) : (
                <p className="text-sm opacity-60">No register is open. Open one from the Sell tab to start ringing sales.</p>
              )}
              <div className="mt-4 flex gap-2">
                <Button onClick={() => setTab("sell")}>{openSession ? "Ring a sale" : "Open register"}</Button>
                <Button tone="ghost" onClick={() => setTab("sessions")}>
                  Session history
                </Button>
              </div>
            </Card>

            <Card>
              <CardTitle>Watch list</CardTitle>
              {varianceSessions.length === 0 ? (
                <p className="text-sm opacity-60">No drawer variances on record. Counts have matched expected cash.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {varianceSessions.slice(0, 4).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {s.register} · closed {timeAgo(s.closedAt!)}
                      </span>
                      <span className="tnum font-medium text-red-700">{formatMoney(s.varianceMinor!)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === "sell" && (
        <div>
          {!openSession && (
            <Card className="max-w-md">
              <CardTitle>Open the register</CardTitle>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label htmlFor="float" className="label">
                    Opening float
                  </label>
                  <input
                    id="float"
                    value={float}
                    onChange={(e) => setFloat(e.target.value)}
                    inputMode="decimal"
                    placeholder="100.00"
                    className="input"
                  />
                </div>
                <Button
                  className="mt-[22px]"
                  loading={busy}
                  onClick={() => post({ action: "open", openingFloatMinor: toMinor(float) }, "Open session")}
                >
                  Open register
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "sell" && openSession && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_380px]">
          {/* Sale builder */}
          <Card>
            <CardTitle right={<Badge tone="green">register open</Badge>}>Ring a sale</CardTitle>
            <form onSubmit={addLine} className="flex gap-2">
              <input
                value={line.description}
                onChange={(e) => setLine((l) => ({ ...l, description: e.target.value }))}
                placeholder="Item"
                aria-label="Item name"
                className="input min-w-0 flex-1"
              />
              <input
                value={line.price}
                onChange={(e) => setLine((l) => ({ ...l, price: e.target.value }))}
                placeholder="$0.00"
                aria-label="Item price in dollars"
                inputMode="decimal"
                className="input w-24"
              />
              <Button type="submit" tone="secondary" aria-label="Add line">
                <IconPlus className="size-3.5" />
                Add
              </Button>
            </form>

            {lines.length > 0 && (
              <ul className="mt-4 divide-y divide-stone-100 border-y border-stone-100">
                {lines.map((l, i) => (
                  <li key={i} className="group flex items-center gap-3 py-2 text-sm">
                    <span className="flex-1 truncate text-stone-700">{l.description}</span>
                    <span className="tnum">{formatMoney(l.unitPriceMinor)}</span>
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      aria-label={`Remove ${l.description}`}
                      className="icon-btn size-6 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600 focus:opacity-100"
                    >
                      <IconTrash className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex items-baseline justify-between">
              <span className="text-sm text-stone-500">Total · {lines.length} item{lines.length === 1 ? "" : "s"}</span>
              <span className="tnum text-2xl font-semibold tracking-tight">{formatMoney(total)}</span>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <SegmentedControl
                ariaLabel="Payment method"
                value={method}
                onChange={setMethod}
                options={[
                  { value: "cash", label: "Cash", icon: <IconCash className="size-3.5" /> },
                  { value: "card", label: "Card", icon: <IconCard className="size-3.5" /> },
                ]}
              />
              <Button
                className="min-w-40 flex-1"
                loading={busy}
                disabled={lines.length === 0}
                onClick={async () => {
                  await post({ action: "sale", sessionId: openSession.id, method, lines }, `Sale ${formatMoney(total)} (${method})`);
                  setLines([]);
                }}
              >
                Complete sale · {formatMoney(total)}
              </Button>
            </div>
          </Card>

          {/* Drawer */}
          <Card>
            <CardTitle>Close &amp; count drawer</CardTitle>
            <dl className="mb-4 space-y-2 rounded-lg bg-stone-50 p-3.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-stone-500">Opening float</dt>
                <dd className="tnum">{formatMoney(openSession.openingFloatMinor)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Cash sales</dt>
                <dd className="tnum">{formatMoney(openSession.expectedCashMinor ?? 0)}</dd>
              </div>
              <div className="flex justify-between border-t border-stone-200 pt-2 font-semibold">
                <dt>Expected cash</dt>
                <dd className="tnum">{formatMoney(expectedCash)}</dd>
              </div>
            </dl>
            <label htmlFor="counted" className="label">
              Counted cash
            </label>
            <input
              id="counted"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              inputMode="decimal"
              placeholder="Count the drawer…"
              className="input"
            />
            {liveVariance !== null && (
              <p
                className={cn(
                  "tnum mt-2 rounded-lg px-3 py-2 text-sm",
                  liveVariance === 0
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-red-50 font-medium text-red-800",
                )}
              >
                {liveVariance === 0 ? "Balanced, matches expected cash." : `Variance preview: ${formatMoney(liveVariance)}`}
              </p>
            )}
            <Button
              tone="dangerSecondary"
              className="mt-4 w-full"
              disabled={!counted}
              onClick={() => setCloseConfirm(true)}
            >
              <IconLock className="size-3.5" />
              Close session &amp; reconcile
            </Button>
          </Card>
        </div>
      )}

      {tab === "sell" && summary && (
        <Card className="mt-4">
          <CardTitle
            right={
              <Badge tone={summary.status === "open" ? "green" : "neutral"}>
                {summary.register} · {summary.status}
              </Badge>
            }
          >
            Shift summary
          </CardTitle>
          <dl className="mb-4 space-y-2 rounded-lg bg-stone-50 p-3.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-stone-500">Sales taken</dt>
              <dd className="tnum">{summary.salesCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Takings</dt>
              <dd className="tnum">{formatMoney(summary.takingsMinor)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Expected cash</dt>
              <dd className="tnum">{formatMoney(summary.expectedCashMinor)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Counted cash</dt>
              <dd className="tnum">{summary.countedCashMinor !== null ? formatMoney(summary.countedCashMinor) : "—"}</dd>
            </div>
            <div className="flex justify-between border-t border-stone-200 pt-2 font-semibold">
              <dt>Variance</dt>
              <dd className={cn("tnum", summary.varianceMinor ? "text-red-700" : "")}>
                {summary.varianceMinor !== null ? formatMoney(summary.varianceMinor) : "—"}
              </dd>
            </div>
          </dl>
          {summary.status === "open" && (
            <p className="text-xs text-stone-500">Counted cash and variance fill in when the drawer is counted at close.</p>
          )}
        </Card>
      )}

      {tab === "sell" && (
        <Card className="mt-4">
          <CardTitle right={<Badge tone="neutral">{sales.length}</Badge>}>Recent sales</CardTitle>
          {sales.length === 0 ? (
            <p className="text-sm opacity-60">No register sales yet. Completed sales show up here with a Return action.</p>
          ) : (
            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Sale</th>
                    <th>Status</th>
                    <th>Taken</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Credited</th>
                    <th className="text-right" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sale) => {
                    const returnable = sale.status !== "void" && sale.totalMinor - sale.creditedMinor > 0;
                    return (
                      <tr key={sale.id}>
                        <td className="font-medium">
                          #{sale.number}
                          {sale.memo && <span className="block text-xs font-normal text-stone-500">{sale.memo}</span>}
                        </td>
                        <td>
                          <Badge tone={statusTone(sale.status)}>{sale.status}</Badge>
                        </td>
                        <td className="text-xs whitespace-nowrap text-stone-500" title={new Date(sale.createdAt).toLocaleString()}>
                          {timeAgo(sale.createdAt)}
                        </td>
                        <td className="num">{formatMoney(sale.totalMinor)}</td>
                        <td className="num">{sale.creditedMinor > 0 ? formatMoney(sale.creditedMinor) : "-"}</td>
                        <td className="text-right">
                          <Button
                            tone="secondary"
                            size="sm"
                            loading={busy}
                            disabled={!returnable}
                            onClick={() => void returnSale(sale)}
                          >
                            <IconUndo className="size-3.5" />
                            Return
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === "sessions" &&
        (sessions.length > 0 ? (
          <section>
            <h2 className="section-title mb-3">Register history</h2>
            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Register</th>
                    <th>Status</th>
                    <th>Opened</th>
                    <th className="text-right">Expected</th>
                    <th className="text-right">Counted</th>
                    <th className="text-right">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className={s.varianceMinor !== null && s.varianceMinor !== 0 ? "bg-red-50/50" : undefined}>
                      <td className="font-medium">{s.register}</td>
                      <td>
                        <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      </td>
                      <td className="text-xs whitespace-nowrap text-stone-500" title={new Date(s.openedAt).toLocaleString()}>
                        {timeAgo(s.openedAt)}
                      </td>
                      <td className="num">{s.expectedCashMinor !== null ? formatMoney(s.expectedCashMinor) : "-"}</td>
                      <td className="num">{s.countedCashMinor !== null ? formatMoney(s.countedCashMinor) : "-"}</td>
                      <td className={cn("num", s.varianceMinor ? "font-semibold text-red-700" : "")}>
                        {s.varianceMinor !== null ? formatMoney(s.varianceMinor) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <EmptyState icon={<IconCash />} title="No register sessions yet" hint="Open a register from the Sell tab to start ringing sales." />
        ))}

      <ConfirmDialog
        open={closeConfirm}
        onClose={() => setCloseConfirm(false)}
        onConfirm={async () => {
          setCloseConfirm(false);
          await post(
            { action: "close", sessionId: openSession?.id, countedCashMinor: toMinor(counted) },
            "Close session",
          );
          setCounted("");
          setLines([]);
        }}
        title="Close this register session?"
        body={
          <>
            Expected cash is <strong className="text-stone-900">{formatMoney(expectedCash)}</strong>; you counted{" "}
            <strong className="text-stone-900">{formatMoney(toMinor(counted))}</strong>.{" "}
            {liveVariance !== null && liveVariance !== 0
              ? `The ${formatMoney(liveVariance)} variance will be recorded and flagged, it can't be edited away later.`
              : "The drawer balances; closing posts the reconciliation."}
          </>
        }
        confirmLabel="Close & reconcile"
        busy={busy}
      />
    </AppFrame>
  );
}
