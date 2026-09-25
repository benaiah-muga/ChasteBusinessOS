"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardTitle, EmptyState } from "@/components/ui";
import { IconChartBar, IconPlus } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { minorToInputIn, toMinorIn } from "@/lib/format";
import { formatMoneyIn } from "@/lib/prefs";

type BudgetAccount = { code: string; name: string; type: "income" | "expense" };
type Assumptions = {
  collectionDelayDays: number;
  spendUpliftBasisPoints: number;
  expectedMonthlyInflowMinor: number;
  expectedMonthlyOutflowMinor: number;
  minimumCashBufferMinor: number;
};
type Scenario = {
  id: string;
  key: string;
  name: string;
  fiscalYear: number;
  version: number;
  currency: string;
  isCurrent: boolean;
  assumptions: Assumptions;
  createdAt: string;
};
type BudgetLine = {
  accountCode: string;
  accountName: string;
  accountType: "income" | "expense";
  planMinor: number;
  actualMinor: number;
  committedMinor: number;
  projectedMinor: number;
  varianceMinor: number;
  utilizationBps: number | null;
};
type Comparison = {
  scenarioId: string;
  name: string;
  fiscalYear: number;
  currency: string;
  unconvertedEntryCount: number;
  months: { month: number; lines: BudgetLine[] }[];
};
type BudgetResponse = {
  ok?: boolean;
  error?: string;
  scenarios?: { scenarios: Scenario[] };
  comparison?: Comparison | null;
  accounts?: BudgetAccount[];
};
type DraftLine = { accountCode: string; accountName: string; accountType: "income" | "expense"; months: string[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EMPTY_ASSUMPTIONS = {
  collectionDelayDays: "0",
  spendUpliftPercent: "0",
  expectedMonthlyInflow: "0.00",
  expectedMonthlyOutflow: "0.00",
  minimumCashBuffer: "0.00",
};

function slugFromName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function blankMonths(): string[] {
  return Array.from({ length: 12 }, () => "0.00");
}

export function BudgetSection({ baseCurrency }: { baseCurrency: string }) {
  const [fiscalYear, setFiscalYear] = useState(new Date().getUTCFullYear());
  const [selectedId, setSelectedId] = useState("");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [accounts, setAccounts] = useState<BudgetAccount[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [month, setMonth] = useState(new Date().getUTCMonth() + 1);
  const [accountFilter, setAccountFilter] = useState<"all" | "income" | "expense">("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; text: string } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftLines, setDraftLines] = useState<Record<string, DraftLine>>({});
  const [accountToAdd, setAccountToAdd] = useState("");
  const [assumptions, setAssumptions] = useState(EMPTY_ASSUMPTIONS);
  const [refresh, setRefresh] = useState(0);

  const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? null;
  const monthLines = comparison?.months.find((row) => row.month === month)?.lines ?? [];
  const filteredLines = monthLines.filter((line) => accountFilter === "all" || line.accountType === accountFilter);
  const visibleAccounts = accounts.filter((account) => !draftLines[account.code]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ fiscalYear: String(fiscalYear) });
    if (selectedId) params.set("scenarioId", selectedId);
    const res = await callApi<BudgetResponse>(`/api/accounting/budgets?${params.toString()}`);
    if (!res.ok || !res.data) {
      setLoadError(res.error?.title ?? "Could not load budget scenarios.");
      setLoading(false);
      return;
    }
    const list = res.data.scenarios?.scenarios ?? [];
    setScenarios(list);
    setAccounts(res.data.accounts ?? []);
    setComparison(res.data.comparison ?? null);
    if (!selectedId && !editing) {
      const current = list.find((scenario) => scenario.isCurrent);
      if (current) setSelectedId(current.id);
    } else if (!list.some((scenario) => scenario.id === selectedId)) {
      setSelectedId("");
    }
    setLoading(false);
  }, [fiscalYear, selectedId, refresh, editing]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!editing) return;
    const map: Record<string, DraftLine> = {};
    if (comparison) {
      for (const period of comparison.months) {
        for (const line of period.lines) {
          if (!line.planMinor && !map[line.accountCode]) continue;
          const current = map[line.accountCode] ?? {
            accountCode: line.accountCode,
            accountName: line.accountName,
            accountType: line.accountType,
            months: blankMonths(),
          };
          current.months[period.month - 1] = minorToInputIn(comparison.currency, line.planMinor);
          map[line.accountCode] = current;
        }
      }
    }
    const accountNames = new Map(accounts.map((account) => [account.code, account]));
    for (const [code, line] of Object.entries(map)) {
      const account = accountNames.get(code);
      if (account) map[code] = { ...line, accountName: account.name, accountType: account.type };
    }
    setDraftLines(map);
    setDraftName(selected?.name ?? "");
    setAssumptions(selected ? {
      collectionDelayDays: String(selected.assumptions.collectionDelayDays),
      spendUpliftPercent: String(selected.assumptions.spendUpliftBasisPoints / 100),
      expectedMonthlyInflow: minorToInputIn(selected.currency, selected.assumptions.expectedMonthlyInflowMinor),
      expectedMonthlyOutflow: minorToInputIn(selected.currency, selected.assumptions.expectedMonthlyOutflowMinor),
      minimumCashBuffer: minorToInputIn(selected.currency, selected.assumptions.minimumCashBufferMinor),
    } : EMPTY_ASSUMPTIONS);
  }, [editing, comparison, selected, accounts]);

  const totalByType = useMemo(() => (type: "income" | "expense") => {
    return monthLines.filter((line) => line.accountType === type).reduce((total, line) => ({
      plan: total.plan + line.planMinor,
      actual: total.actual + line.actualMinor,
      committed: total.committed + line.committedMinor,
      projected: total.projected + line.projectedMinor,
    }), { plan: 0, actual: 0, committed: 0, projected: 0 });
  }, [monthLines]);

  function updateLine(code: string, index: number, value: string) {
    setDraftLines((current) => ({
      ...current,
      [code]: { ...current[code]!, months: current[code]!.months.map((amount, i) => i === index ? value : amount) },
    }));
  }

  async function saveScenario() {
    const name = draftName.trim();
    const key = selected?.key ?? slugFromName(name);
    if (!name || !key) {
      setNotice({ tone: "error", text: "Add a scenario name before saving." });
      return;
    }
    const lines: { month: number; accountCode: string; plannedMinor: number }[] = [];
    try {
      for (const line of Object.values(draftLines)) {
        line.months.forEach((amount, index) => {
          const plannedMinor = toMinorIn(baseCurrency, amount || "0");
          if (plannedMinor < 0) throw new Error("Budget amounts must be zero or more.");
          if (plannedMinor > 0) lines.push({ month: index + 1, accountCode: line.accountCode, plannedMinor });
        });
      }
      if (lines.length === 0) throw new Error("Add at least one monthly amount greater than zero.");
      const spendUpliftBasisPoints = Math.round(Number(assumptions.spendUpliftPercent) * 100);
      if (!Number.isFinite(spendUpliftBasisPoints) || spendUpliftBasisPoints < 0 || spendUpliftBasisPoints > 20_000) throw new Error("Spend uplift must be between 0% and 200%.");
      const expectedMonthlyInflowMinor = toMinorIn(baseCurrency, assumptions.expectedMonthlyInflow || "0");
      const expectedMonthlyOutflowMinor = toMinorIn(baseCurrency, assumptions.expectedMonthlyOutflow || "0");
      const minimumCashBufferMinor = toMinorIn(baseCurrency, assumptions.minimumCashBuffer || "0");
      if ([expectedMonthlyInflowMinor, expectedMonthlyOutflowMinor, minimumCashBufferMinor].some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
        throw new Error("Cash assumptions must be non-negative amounts within the supported range.");
      }
      const payload = {
        action: "save",
        intentId: crypto.randomUUID(),
        scenarioKey: key,
        name,
        fiscalYear,
        currency: baseCurrency,
        assumptions: {
          collectionDelayDays: Number(assumptions.collectionDelayDays),
          spendUpliftBasisPoints,
          expectedMonthlyInflowMinor,
          expectedMonthlyOutflowMinor,
          minimumCashBufferMinor,
        },
        lines,
      };
      setBusy(true);
      const res = await postApi<{ scenarioId: string; version: number }>("/api/accounting/budgets", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "Saving this budget needs approval. It will appear in your versions after approval." });
      } else if (!res.ok || !res.data) {
        setNotice({ tone: "error", text: res.error?.title ?? "Could not save this budget." });
      } else {
        setNotice({ tone: "success", text: `Version ${res.data.version} saved.` });
        setSelectedId(res.data.scenarioId);
        setEditing(false);
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Check the budget amounts." });
    } finally {
      setBusy(false);
    }
  }

  async function undoLatestVersion() {
    if (!selected?.isCurrent) return;
    const previous = scenarios.find((scenario) => scenario.key === selected.key && scenario.version === selected.version - 1);
    setBusy(true);
    const res = await postApi("/api/accounting/budgets", {
      action: "undo",
      intentId: crypto.randomUUID(),
      scenarioId: selected.id,
      previousScenarioId: previous?.id ?? null,
    });
    if (res.status === 202) setNotice({ tone: "pending", text: "Undo needs approval and is waiting in the Approvals inbox." });
    else if (!res.ok) setNotice({ tone: "error", text: res.error?.title ?? "Could not restore the prior version." });
    else {
      setNotice({ tone: "success", text: previous ? `Restored version ${previous.version}.` : "Removed the current version." });
      setSelectedId(previous?.id ?? "");
      setRefresh((value) => value + 1);
    }
    setBusy(false);
  }

  function startNewScenario() {
    setSelectedId("");
    setComparison(null);
    setDraftName("");
    setDraftLines({});
    setAssumptions(EMPTY_ASSUMPTIONS);
    setEditing(true);
    setNotice(null);
  }

  function startNewVersion() {
    setEditing(true);
    setNotice(null);
  }

  if (loading && scenarios.length === 0 && !loadError) {
    return <Card><CardTitle>Budget scenarios</CardTitle><p className="text-sm text-stone-600">Loading plans and actuals…</p></Card>;
  }
  if (loadError) {
    return <Card><CardTitle>Budget scenarios</CardTitle><div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-red-700">{loadError}</p><Button size="sm" tone="secondary" onClick={() => setRefresh((value) => value + 1)}>Retry</Button></div></Card>;
  }

  return (
    <section className="space-y-5">
      {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : notice.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</div>}

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 flex-1">
            <CardTitle right={selected ? <Badge>{selected.isCurrent ? "Current version" : `Version ${selected.version}`}</Badge> : undefined}>Budgets and cash scenarios</CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-stone-600">Compare posted actuals and unbilled purchase commitments against a saved plan. Every save creates a reviewable version.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-medium text-stone-600">Fiscal year
              <input className="input mt-1 block w-28" type="number" min={2000} max={2100} value={fiscalYear} onChange={(event) => { setFiscalYear(Number(event.target.value)); setSelectedId(""); }} />
            </label>
            <Button size="sm" onClick={startNewScenario}><IconPlus className="size-3.5" /> New scenario</Button>
          </div>
        </div>

        {scenarios.length > 0 && (
          <div className="mt-5 flex flex-col gap-3 border-t border-stone-200 pt-4 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-xs font-medium text-stone-600">Saved plan and version
              <select className="input mt-1 block w-full" value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setEditing(false); }}>
                {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name} · v{scenario.version}{scenario.isCurrent ? " · current" : " · history"}</option>)}
              </select>
            </label>
            {selected?.isCurrent && <Button size="sm" tone="secondary" onClick={startNewVersion}>Edit as new version</Button>}
            {selected?.isCurrent && selected.version > 1 && <Button size="sm" tone="ghost" disabled={busy} onClick={() => void undoLatestVersion()}>Undo latest save</Button>}
          </div>
        )}
      </Card>

      {editing && (
        <Card>
          <CardTitle right={<Button size="sm" tone="ghost" onClick={() => setEditing(false)}>Close editor</Button>}>{selected ? `Create version ${selected.version + 1}` : "Create a budget scenario"}</CardTitle>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium text-stone-600">Scenario name
              <input className="input mt-1 block w-full" value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Base plan" />
            </label>
            <label className="text-xs font-medium text-stone-600">Collections delay (days)
              <input className="input mt-1 block w-full" type="number" min={0} max={180} value={assumptions.collectionDelayDays} onChange={(event) => setAssumptions((value) => ({ ...value, collectionDelayDays: event.target.value }))} />
            </label>
            <label className="text-xs font-medium text-stone-600">Spend uplift (%)
              <input className="input mt-1 block w-full" type="number" min={0} max={200} step="0.1" value={assumptions.spendUpliftPercent} onChange={(event) => setAssumptions((value) => ({ ...value, spendUpliftPercent: event.target.value }))} />
            </label>
            <label className="text-xs font-medium text-stone-600">Minimum cash buffer · {baseCurrency}
              <input className="input mt-1 block w-full" inputMode="decimal" value={assumptions.minimumCashBuffer} onChange={(event) => setAssumptions((value) => ({ ...value, minimumCashBuffer: event.target.value }))} />
            </label>
            <label className="text-xs font-medium text-stone-600">Additional monthly inflow · {baseCurrency}
              <input className="input mt-1 block w-full" inputMode="decimal" value={assumptions.expectedMonthlyInflow} onChange={(event) => setAssumptions((value) => ({ ...value, expectedMonthlyInflow: event.target.value }))} />
            </label>
            <label className="text-xs font-medium text-stone-600">Additional monthly outflow · {baseCurrency}
              <input className="input mt-1 block w-full" inputMode="decimal" value={assumptions.expectedMonthlyOutflow} onChange={(event) => setAssumptions((value) => ({ ...value, expectedMonthlyOutflow: event.target.value }))} />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-end gap-2">
            <label className="min-w-56 text-xs font-medium text-stone-600">Add income or expense account
              <select className="input mt-1 block w-full" value={accountToAdd} onChange={(event) => setAccountToAdd(event.target.value)}>
                <option value="">Choose account…</option>
                {visibleAccounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name} ({account.type})</option>)}
              </select>
            </label>
            <Button size="sm" tone="secondary" disabled={!accountToAdd} onClick={() => {
              const account = accounts.find((item) => item.code === accountToAdd);
              if (!account) return;
              setDraftLines((current) => ({ ...current, [account.code]: { accountCode: account.code, accountName: account.name, accountType: account.type, months: blankMonths() } }));
              setAccountToAdd("");
            }}><IconPlus className="size-3.5" /> Add row</Button>
          </div>

          {Object.keys(draftLines).length === 0 ? (
            <p className="mt-4 rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">Add an account row, then enter its planned amount for each month. Amounts use {baseCurrency} major units.</p>
          ) : (
            <div className="table-shell mt-4 max-h-[32rem] overflow-auto">
              <table className="data-table min-w-[1080px]">
                <thead><tr><th className="sticky left-0 z-10 bg-stone-50">Account</th>{MONTHS.map((label) => <th key={label} className="text-right">{label}</th>)}<th aria-label="Remove account" /></tr></thead>
                <tbody>
                  {Object.values(draftLines).sort((a, b) => a.accountCode.localeCompare(b.accountCode)).map((line) => (
                    <tr key={line.accountCode}>
                      <td className="sticky left-0 z-10 min-w-48 bg-white"><span className="block font-medium text-stone-800">{line.accountName}</span><span className="text-xs text-stone-600">{line.accountCode} · {line.accountType}</span></td>
                      {line.months.map((amount, index) => <td key={index} className="min-w-24 p-1"><input aria-label={`${line.accountName} ${MONTHS[index]} plan`} className="input h-9 min-w-20 text-right text-xs" inputMode="decimal" value={amount} onChange={(event) => updateLine(line.accountCode, index, event.target.value)} /></td>)}
                      <td><Button size="sm" tone="ghost" aria-label={`Remove ${line.accountName}`} onClick={() => setDraftLines((current) => { const next = { ...current }; delete next[line.accountCode]; return next; })}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4">
            <p className="text-xs text-stone-600">Saving creates a new immutable plan version. Prior versions stay available in history.</p>
            <Button disabled={busy || Object.keys(draftLines).length === 0} loading={busy} onClick={() => void saveScenario()}>Save version</Button>
          </div>
        </Card>
      )}

      {!editing && !selected && (
        <EmptyState icon={<IconChartBar />} title="No budget scenarios for this year" hint="Create a named monthly plan, add cash assumptions, and compare it with actuals and remaining purchase commitments." action={<Button onClick={startNewScenario}><IconPlus className="size-3.5" /> Create first scenario</Button>} />
      )}

      {!editing && selected && comparison && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div><CardTitle>Actual versus plan</CardTitle><p className="mt-1 text-sm text-stone-600">Projected spend includes posted expense and remaining unbilled purchase commitments. Open commitments use purchase order net value because tax is unknown until a bill is coded.</p></div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs font-medium text-stone-600">Period
                <select className="input mt-1 block w-36" value={month} onChange={(event) => setMonth(Number(event.target.value))}>{MONTHS.map((label, index) => <option key={label} value={index + 1}>{label} {comparison.fiscalYear}</option>)}</select>
              </label>
              <label className="text-xs font-medium text-stone-600">Account type
                <select className="input mt-1 block w-32" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value as typeof accountFilter)}><option value="all">All accounts</option><option value="expense">Expenses</option><option value="income">Income</option></select>
              </label>
            </div>
          </div>
          {comparison.unconvertedEntryCount > 0 && <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{comparison.unconvertedEntryCount} foreign-currency journal entries are excluded because budget comparisons use the organization&apos;s base currency.</p>}
          {filteredLines.length === 0 ? (
            <p className="mt-5 rounded-lg bg-stone-50 px-4 py-6 text-center text-sm text-stone-600">No plan or posted activity for {MONTHS[month - 1]}.</p>
          ) : (
            <div className="table-shell mt-4 overflow-x-auto">
              <table className="data-table min-w-[760px]">
                <thead><tr><th>Account</th><th className="text-right">Plan</th><th className="text-right">Actual</th><th className="text-right">Committed</th><th className="text-right">Projected</th><th className="text-right">Variance</th></tr></thead>
                <tbody>
                  {filteredLines.map((line) => {
                    const favorable = line.accountType === "expense" ? line.varianceMinor <= 0 : line.varianceMinor >= 0;
                    return <tr key={line.accountCode}>
                      <td><span className="font-medium text-stone-800">{line.accountName}</span><span className="ml-2 text-xs text-stone-600">{line.accountCode}</span></td>
                      <td className="num">{formatMoneyIn(comparison.currency, line.planMinor)}</td>
                      <td className="num">{formatMoneyIn(comparison.currency, line.actualMinor)}</td>
                      <td className="num">{formatMoneyIn(comparison.currency, line.committedMinor)}</td>
                      <td className="num font-medium">{formatMoneyIn(comparison.currency, line.projectedMinor)}</td>
                      <td className={`num font-medium ${favorable ? "text-emerald-700" : "text-rose-700"}`}>{formatMoneyIn(comparison.currency, line.varianceMinor)}<span className="ml-1 text-[10px] font-normal text-stone-600">{line.accountType === "expense" ? (favorable ? "under" : "over") : (favorable ? "ahead" : "behind")}</span></td>
                    </tr>;
                  })}
                </tbody>
                {accountFilter !== "all" && (() => {
                  const totals = totalByType(accountFilter);
                  const variance = totals.projected - totals.plan;
                  const favorable = accountFilter === "expense" ? variance <= 0 : variance >= 0;
                  return <tfoot><tr><th>{accountFilter === "expense" ? "Expense total" : "Income total"}</th><td className="num">{formatMoneyIn(comparison.currency, totals.plan)}</td><td className="num">{formatMoneyIn(comparison.currency, totals.actual)}</td><td className="num">{formatMoneyIn(comparison.currency, totals.committed)}</td><td className="num">{formatMoneyIn(comparison.currency, totals.projected)}</td><td className={`num ${favorable ? "text-emerald-700" : "text-rose-700"}`}>{formatMoneyIn(comparison.currency, variance)}</td></tr></tfoot>;
                })()}
              </table>
            </div>
          )}
        </Card>
      )}

      {!editing && scenarios.length > 0 && <Card className="bg-stone-50/70"><p className="text-xs font-semibold uppercase tracking-wide text-stone-600">Scenario assumptions</p><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[
        ["Collection delay", `${selected?.assumptions.collectionDelayDays ?? 0} days`],
        ["Spend uplift", `${((selected?.assumptions.spendUpliftBasisPoints ?? 0) / 100).toFixed(1)}%`],
        ["Monthly inflow", formatMoneyIn(selected?.currency ?? baseCurrency, selected?.assumptions.expectedMonthlyInflowMinor ?? 0)],
        ["Monthly outflow", formatMoneyIn(selected?.currency ?? baseCurrency, selected?.assumptions.expectedMonthlyOutflowMinor ?? 0)],
        ["Minimum cash", formatMoneyIn(selected?.currency ?? baseCurrency, selected?.assumptions.minimumCashBufferMinor ?? 0)],
      ].map(([label, value]) => <div key={label}><p className="text-xs text-stone-600">{label}</p><p className="mt-0.5 text-sm font-medium text-stone-800">{value}</p></div>)}</div><p className="mt-3 text-xs text-stone-600">These assumptions feed the 13-week cash forecast when you select this scenario in Cash & collections.</p></Card>}
    </section>
  );
}
