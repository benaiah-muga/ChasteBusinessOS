"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
  PageHeader,
  StatCard,
} from "@/components/ui";
import { IconCalendar, IconInbox, IconUsers } from "@/components/icons";
import { formatMoney, statusTone, toMinor } from "@/lib/format";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

interface Employee {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  monthlySalaryMinor: number;
  taxRateBps: number;
  active: boolean;
}

interface LeaveRow {
  id: string;
  employeeName: string;
  kind: string;
  startDate: string;
  endDate: string;
  calendarDays: number;
  status: string;
}

interface Run {
  id: string;
  year: number;
  month: number;
  status: string;
  totalGrossMinor: number;
  totalTaxMinor: number;
  totalNetMinor: number;
  headcount: number;
}

export default function HrPage() {
  const __enabled = useModuleEnabled("hr");
  const router = useRouter();
  const [data, setData] = useState<{ employees: Employee[]; leave: LeaveRow[]; runs: Run[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionNoticeState | null>(null);

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [salary, setSalary] = useState("");
  const now = new Date();
  const [runPeriod, setRunPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [deactivateTarget, setDeactivateTarget] = useState<Employee | null>(null);

  const load = useCallback(async () => {
    const res = await callApi<{ employees?: Employee[]; leave?: LeaveRow[]; runs?: Run[] }>("/api/hr");
    setData({
      employees: res.data?.employees ?? [],
      leave: res.data?.leave ?? [],
      runs: res.data?.runs ?? [],
    });
    if (!res.ok) setMessage({ tone: "error", error: res.error! });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(payload: Record<string, unknown>, label: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi<{ ok?: boolean; error?: string }>("/api/hr", payload);
      if (res.status === 202) setMessage({ tone: "pending", text: `${label}: needs approval, see Approvals.` });
      else if (!res.ok) setMessage({ tone: "error", error: res.error! });
      else setMessage({ tone: "success", text: `${label} done.` });
      await load();
      return res.ok;
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function hire() {
    if (!name.trim() || !salary) {
      setMessage({ tone: "error", error: { title: "Missing details", hint: "Name and monthly salary are both required." } });
      return;
    }
    const ok = await action(
      { action: "hireEmployee", name, title: title || undefined, monthlySalaryMinor: toMinor(salary) },
      "Hire",
    );
    if (ok) {
      setName("");
      setTitle("");
      setSalary("");
    }
  }

  async function draftRun() {
    const [y, m] = runPeriod.split("-").map(Number);
    if (!y || !m) {
      setMessage({ tone: "error", error: { title: "Pick a payroll period", hint: "Choose the month this run covers." } });
      return;
    }
    const ok = await action({ action: "createPayrollRun", year: y, month: m }, "Draft payroll");
    if (ok) setMessage({ tone: "info", text: "Draft payroll ready, review the totals, then execute." });
  }

  if (!data) return <LoadingPage />;

  const activeStaff = data.employees.filter((e) => e.active);
  const pendingLeave = data.leave.filter((l) => l.status === "pending");
  const draftRunRow = data.runs.find((r) => r.status === "draft");
  const executedRuns = data.runs.filter((r) => r.status !== "draft");
  const lastExecuted = executedRuns[0];
  const monthlyPayroll = activeStaff.reduce((s, e) => s + e.monthlySalaryMinor, 0);

  if (!__enabled) return <ModuleDisabled label="HR & Payroll" />;

  return (
    <div>
      <PageHeader
        title="HR & Payroll"
        description="Employees, leave and gated payroll. Executing a run posts one balanced entry, salary expense debited, net cash credited, withholding held as a liability, always behind a human approval gate."
      />

      {message && <ActionNotice state={message} onDismiss={() => setMessage(null)} />}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active staff" value={activeStaff.length} />
        <StatCard label="Monthly payroll" value={formatMoney(monthlyPayroll)} />
        <StatCard label="Pending leave" value={pendingLeave.length} tone={pendingLeave.length > 0 ? "warn" : "default"} />
        <StatCard
          label="Last run"
          value={lastExecuted ? formatMoney(lastExecuted.totalNetMinor) : "-"}
          sub={lastExecuted ? `net · ${lastExecuted.year}-${String(lastExecuted.month).padStart(2, "0")}` : undefined}
          tone="accent"
        />
      </div>

      {/* Payroll */}
      <Card className="mb-4">
        <CardTitle right={draftRunRow ? <Badge tone="amber">draft</Badge> : undefined}>Payroll run</CardTitle>
        {draftRunRow ? (
          <div>
            <p className="text-sm text-stone-500">
              Draft for <strong className="text-stone-800">{draftRunRow.year}-{String(draftRunRow.month).padStart(2, "0")}</strong>,
              review the totals, then execute (an approval will be requested).
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              <StatCard label="Gross" value={formatMoney(draftRunRow.totalGrossMinor)} />
              <StatCard label="Withholding" value={formatMoney(draftRunRow.totalTaxMinor)} />
              <StatCard label="Net pay" value={formatMoney(draftRunRow.totalNetMinor)} sub={`${draftRunRow.headcount} people`} tone="accent" />
            </dl>
            <div className="mt-4 flex gap-2 border-t border-stone-100 pt-4">
              <Button
                loading={busy}
                onClick={() =>
                  action(
                    {
                      action: "executePayrollRun",
                      runId: draftRunRow.id,
                      expectedTotalNetMinor: draftRunRow.totalNetMinor,
                    },
                    "Execute payroll",
                  )
                }
              >
                Execute payroll…
              </Button>
              <Button tone="dangerSecondary" loading={busy} onClick={() => action({ action: "voidPayrollRun", runId: draftRunRow.id }, "Void draft")}>
                Void draft
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <label htmlFor="period" className="label">
                Period
              </label>
              <input
                id="period"
                type="month"
                value={runPeriod}
                onChange={(e) => setRunPeriod(e.target.value)}
                className="input"
              />
            </div>
            <Button onClick={draftRun} loading={busy} disabled={activeStaff.length === 0}>
              <IconCalendar className="size-3.5" />
              Draft payroll
            </Button>
            {activeStaff.length === 0 && <p className="pb-2 text-xs text-stone-400">Hire someone first.</p>}
          </div>
        )}

        {executedRuns.length > 0 && (
          <table className="data-table mt-5 border-t border-stone-100">
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th className="text-right">Headcount</th>
                <th className="text-right">Gross</th>
                <th className="text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {executedRuns.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">
                    {r.year}-{String(r.month).padStart(2, "0")}
                  </td>
                  <td>
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  </td>
                  <td className="num">{r.headcount}</td>
                  <td className="num">{formatMoney(r.totalGrossMinor)}</td>
                  <td className="num font-medium">{formatMoney(r.totalNetMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Hiring */}
      <Card className="mb-4">
        <CardTitle>Hire</CardTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void hire();
          }}
          className="grid gap-3 sm:grid-cols-[1.2fr_1fr_0.7fr_auto] sm:items-end"
        >
          <div>
            <label htmlFor="hire-name" className="label">
              Full name
            </label>
            <input id="hire-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" className="input" />
          </div>
          <div>
            <label htmlFor="hire-title" className="label">
              Title <span className="font-normal text-stone-400">(optional)</span>
            </label>
            <input id="hire-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Designer" className="input" />
          </div>
          <div>
            <label htmlFor="hire-salary" className="label">
              Monthly salary
            </label>
            <input
              id="hire-salary"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              inputMode="decimal"
              placeholder="$"
              className="input"
            />
          </div>
          <Button type="submit" loading={busy}>
            Hire
          </Button>
        </form>
      </Card>

      {/* Staff */}
      {data.employees.length > 0 ? (
        <div className="table-shell mb-4">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th className="text-right">Monthly</th>
                <th className="text-right">Tax rate</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={e.name} className="size-7" />
                      <span className={!e.active ? "text-stone-400 line-through" : "font-medium text-stone-800"}>{e.name}</span>
                      {!e.active && <Badge>inactive</Badge>}
                    </span>
                  </td>
                  <td className="text-stone-600">{e.title ?? "-"}</td>
                  <td className="num">{formatMoney(e.monthlySalaryMinor)}</td>
                  <td className="num">{(e.taxRateBps / 100).toFixed(1)}%</td>
                  <td className="text-right">
                    {e.active && (
                      <Button tone="ghost" size="sm" className="hover:bg-red-50 hover:text-red-700" onClick={() => setDeactivateTarget(e)}>
                        Deactivate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={<IconUsers />} title="No employees yet" hint="Add your first hire above to unlock payroll runs." />
      )}

      {/* Leave */}
      {activeStaff.length > 0 && (
        <Card>
          <CardTitle>Leave</CardTitle>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void action(
                {
                  action: "requestLeave",
                  employeeId: String(fd.get("employeeId")),
                  kind: String(fd.get("kind")),
                  startDate: String(fd.get("startDate")),
                  endDate: String(fd.get("endDate")),
                },
                "Leave request",
              );
            }}
            className="grid gap-3 sm:grid-cols-[1.3fr_1fr_1fr_1fr_auto] sm:items-end"
          >
            <div>
              <label htmlFor="leave-employee" className="label">
                Employee
              </label>
              <select id="leave-employee" name="employeeId" className="select">
                {activeStaff.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="leave-kind" className="label">
                Type
              </label>
              <select id="leave-kind" name="kind" defaultValue="annual" className="select">
                <option value="annual">Annual · paid</option>
                <option value="sick">Sick · paid</option>
                <option value="unpaid">Unpaid · reduces pay</option>
              </select>
            </div>
            <div>
              <label htmlFor="leave-start" className="label">
                From
              </label>
              <input id="leave-start" type="date" name="startDate" required className="input" />
            </div>
            <div>
              <label htmlFor="leave-end" className="label">
                To
              </label>
              <input id="leave-end" type="date" name="endDate" required className="input" />
            </div>
            <Button type="submit" loading={busy}>
              File request
            </Button>
          </form>

          {pendingLeave.length > 0 && (
            <ul className="mt-5 space-y-2 border-t border-stone-100 pt-4">
              {pendingLeave.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-sm">
                  <span className="text-stone-700">
                    <strong className="text-stone-900">{l.employeeName}</strong> · {l.kind} ·{" "}
                    {l.calendarDays} day{l.calendarDays === 1 ? "" : "s"} ·{" "}
                    <span className="whitespace-nowrap">
                      {new Date(l.startDate).toLocaleDateString()} → {new Date(l.endDate).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <Button size="sm" loading={busy} onClick={() => action({ action: "decideLeave", requestId: l.id, approve: true }, "Approve leave")}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      loading={busy}
                      onClick={() => action({ action: "decideLeave", requestId: l.id, approve: false }, "Reject leave")}
                    >
                      Reject
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {pendingLeave.length === 0 && (
            <p className="mt-4 flex items-center gap-2 border-t border-stone-100 pt-4 text-sm text-stone-400">
              <IconInbox className="size-4" />
              No pending leave requests.
            </p>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={deactivateTarget !== null}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={async () => {
          if (!deactivateTarget) return;
          await action({ action: "deactivateEmployee", employeeId: deactivateTarget.id }, "Deactivate");
          setDeactivateTarget(null);
        }}
        title={`Deactivate ${deactivateTarget?.name ?? ""}?`}
        body="They stop appearing in new payroll drafts and can't be assigned leave. History is preserved."
        confirmLabel="Deactivate"
        busy={busy}
      />
    </div>
  );
}
