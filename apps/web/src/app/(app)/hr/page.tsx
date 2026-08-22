"use client";

import { useCallback, useEffect, useState } from "react";

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

const usd = (minor: number) => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function HrPage() {
  const [data, setData] = useState<{ employees: Employee[]; leave: LeaveRow[]; runs: Run[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [salary, setSalary] = useState("");
  const now = new Date();
  const [runYear, setRunYear] = useState(now.getFullYear());
  const [runMonth, setRunMonth] = useState(now.getMonth() + 1);

  const load = useCallback(async () => {
    const d = await fetch("/api/hr").then((r) => r.json());
    setData({ employees: d.employees ?? [], leave: d.leave ?? [], runs: d.runs ?? [] });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/hr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (res.status === 202) setMessage(`${label}: needs approval — see Approvals.`);
      else if (json.ok) setMessage(`${label}: done.`);
      else setMessage(`${label} failed: ${json.error ?? "unknown error"}`);
      await load();
      return json.ok === true || res.status === 202;
    } finally {
      setBusy(false);
    }
  }

  async function hire() {
    if (!name.trim() || !salary) return setMessage("Name and salary are required.");
    const ok = await action(
      { action: "hireEmployee", name, title: title || undefined, monthlySalaryMinor: Math.round(parseFloat(salary) * 100) },
      "Hire",
    );
    if (ok) {
      setName("");
      setTitle("");
      setSalary("");
    }
  }

  async function draftRun() {
    const ok = await action({ action: "createPayrollRun", year: runYear, month: runMonth }, "Draft payroll");
    if (ok) setMessage("Draft payroll ready — review the totals, then execute.");
  }

  const activeStaff = data?.employees.filter((e) => e.active) ?? [];
  const pendingLeave = data?.leave.filter((l) => l.status === "pending") ?? [];
  const draftRunRow = data?.runs.find((r) => r.status === "draft");

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">HR &amp; Payroll</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Employees, leave and gated payroll. Executing a run posts one balanced ledger entry — salary
        expense debited, net cash credited, withholding held as a liability — always above a human
        approval gate.
      </p>

      {message && (
        <p className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
          message.includes("failed") ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>{message}</p>
      )}

      {/* Payroll */}
      <div className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Payroll</h2>
        {draftRunRow ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              Draft for {draftRunRow.year}-{String(draftRunRow.month).padStart(2, "0")}:{" "}
              <span className="font-mono">{draftRunRow.headcount}</span> people · gross{" "}
              <span className="font-mono">{usd(draftRunRow.totalGrossMinor)}</span> · tax{" "}
              <span className="font-mono">{usd(draftRunRow.totalTaxMinor)}</span> · net{" "}
              <span className="font-mono font-semibold">{usd(draftRunRow.totalNetMinor)}</span>
            </p>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  action(
                    { action: "executePayrollRun", runId: draftRunRow.id, expectedTotalNetMinor: draftRunRow.totalNetMinor },
                    "Execute payroll",
                  )
                }
                disabled={busy}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                Execute
              </button>
              <button
                onClick={() => action({ action: "voidPayrollRun", runId: draftRunRow.id }, "Void draft")}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-2 text-xs hover:border-red-500 hover:text-red-700 disabled:opacity-40"
              >
                Void draft
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={runMonth}
              min={1}
              max={12}
              onChange={(e) => setRunMonth(Number(e.target.value))}
              className="w-20 rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <input
              type="number"
              value={runYear}
              onChange={(e) => setRunYear(Number(e.target.value))}
              className="w-24 rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <button
              onClick={draftRun}
              disabled={busy || activeStaff.length === 0}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Draft payroll
            </button>
            {activeStaff.length === 0 && <span className="text-xs text-neutral-400">hire someone first</span>}
          </div>
        )}

        {data && data.runs.length > 0 && (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="border-b border-neutral-200 font-mono text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2">Period</th>
                <th className="py-2">Status</th>
                <th className="py-2">Headcount</th>
                <th className="py-2">Gross</th>
                <th className="py-2">Net</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 last:border-0">
                  <td className="py-2 font-mono text-xs">{r.year}-{String(r.month).padStart(2, "0")}</td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${
                      r.status === "executed" ? "bg-emerald-100 text-emerald-800"
                      : r.status === "voided" ? "bg-red-100 text-red-800"
                      : "bg-amber-100 text-amber-800"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="py-2">{r.headcount}</td>
                  <td className="py-2 font-mono text-xs">{usd(r.totalGrossMinor)}</td>
                  <td className="py-2 font-mono text-xs">{usd(r.totalNetMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Hiring */}
      <div className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Hire</h2>
        <div className="grid gap-3 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name"
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)"
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none" />
          <input value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="Monthly $"
            inputMode="decimal"
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none" />
          <button onClick={hire} disabled={busy}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
            Hire
          </button>
        </div>
      </div>

      {/* Staff table */}
      {data && data.employees.length > 0 && (
        <div className="mb-6 overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Monthly</th>
                <th className="px-4 py-3">Tax</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                  <td className={`px-4 py-2.5 font-medium ${e.active ? "" : "text-neutral-400 line-through"}`}>{e.name}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{e.title ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{usd(e.monthlySalaryMinor)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{(e.taxRateBps / 100).toFixed(1)}%</td>
                  <td className="px-4 py-2.5 text-right">
                    {e.active && (
                      <button
                        onClick={() => action({ action: "deactivateEmployee", employeeId: e.id }, "Deactivate")}
                        disabled={busy}
                        className="text-xs text-red-700 underline underline-offset-2 disabled:opacity-40"
                      >
                        deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Leave */}
      {activeStaff.length > 0 && (
        <div className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Request leave</h2>
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
            className="flex flex-wrap items-end gap-3"
          >
            <select name="employeeId" className="rounded border border-neutral-300 px-2 py-2 text-sm">
              {activeStaff.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <select name="kind" defaultValue="annual" className="rounded border border-neutral-300 px-2 py-2 text-sm">
              <option value="annual">annual (paid)</option>
              <option value="sick">sick (paid)</option>
              <option value="unpaid">unpaid (reduces pay)</option>
            </select>
            <input type="date" name="startDate" required className="rounded border border-neutral-300 px-2 py-2 text-sm" />
            <input type="date" name="endDate" required className="rounded border border-neutral-300 px-2 py-2 text-sm" />
            <button type="submit" disabled={busy}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
              File request
            </button>
          </form>

          {pendingLeave.length > 0 && (
            <div className="mt-4 space-y-2">
              {pendingLeave.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-4 py-2 text-sm">
                  <span>
                    <strong>{l.employeeName}</strong> · {l.kind} · {l.calendarDays} day{l.calendarDays === 1 ? "" : "s"} ·{" "}
                    {new Date(l.startDate).toLocaleDateString()} → {new Date(l.endDate).toLocaleDateString()}
                  </span>
                  <span className="flex gap-2">
                    <button onClick={() => action({ action: "decideLeave", requestId: l.id, approve: true }, "Approve leave")}
                      disabled={busy}
                      className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-800 disabled:opacity-50">
                      approve
                    </button>
                    <button onClick={() => action({ action: "decideLeave", requestId: l.id, approve: false }, "Reject leave")}
                      disabled={busy}
                      className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-red-500 hover:text-red-700 disabled:opacity-40">
                      reject
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
