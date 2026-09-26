"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  Dialog,
  EmptyState,
  LoadingPage,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import {
  IconAlertTriangle,
  IconCalendar,
  IconCash,
  IconHistory,
  IconInbox,
  IconUsers,
} from "@/components/icons";
import { cn, formatDate, formatDateTime, formatMoney, formatMoneyWhole, statusTone } from "@/lib/format";
import { useMoneySync } from "@/lib/money";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { HiringTab, type ApplicantRow, type OpeningRow } from "./hiring-tab";

type TabId = "overview" | "people" | "hiring" | "leave" | "time" | "payroll" | "expenses";

interface Employee {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  department: string | null;
  managerEmployeeId: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
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

interface HrPayload {
  employees?: Employee[];
  leave?: LeaveRow[];
  runs?: Run[];
  openings?: OpeningRow[];
  applicants?: ApplicantRow[];
  attendance?: AttendanceRow[];
}

interface AttendanceRow {
  employeeId: string;
  clockedInAt: string;
  late: boolean;
}

interface PendingEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  minutes: number;
  note: string | null;
  late: boolean;
}

interface LeaveBalance {
  entitlementDays: number;
  takenDays: number;
  remainingDays: number;
}

interface CalendarEntry {
  employeeName: string;
  kind: string;
  startDate: string;
  endDate: string;
  days: number;
}

interface TimeRow {
  employeeId: string;
  approvedMinutes: number;
  pendingMinutes: number;
}

interface TimeReport {
  from: string;
  to: string;
  rows: TimeRow[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function monthBounds(now = new Date()): { from: string; to: string } {
  return {
    from: isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    to: isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))),
  };
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** 510 minutes renders as "8h 30m"; whole hours drop the minutes. */
function fmtHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function HrPage() {
  useMoneySync();
  const __enabled = useModuleEnabled("hr");
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("overview");
  const [data, setData] = useState<HrPayload | null>(null);
  const [time, setTime] = useState<TimeReport>({ ...monthBounds(), rows: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  // Hire form
  const [hireForm, setHireForm] = useState({ name: "", email: "", title: "", salary: "", taxRate: "10" });
  const [deactivateTarget, setDeactivateTarget] = useState<Employee | null>(null);

  // Leave form
  const [leaveForm, setLeaveForm] = useState({ employeeId: "", kind: "annual", startDate: "", endDate: "" });

  // Time
  const [range, setRange] = useState(monthBounds());
  const [logForm, setLogForm] = useState({ employeeId: "", workDate: isoDate(new Date()), hours: "", note: "" });
  const [pendingEntries, setPendingEntries] = useState<PendingEntry[] | null>(null);

  // Structure edit
  const [structureTarget, setStructureTarget] = useState<Employee | null>(null);
  const [structureForm, setStructureForm] = useState({
    department: "",
    position: "",
    managerEmployeeId: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
  });

  // Leave balance + team calendar
  const [balanceEmployeeId, setBalanceEmployeeId] = useState("");
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const [calendar, setCalendar] = useState<CalendarEntry[] | null>(null);

  // Payroll
  const [runPeriod, setRunPeriod] = useState(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const [executeTarget, setExecuteTarget] = useState<Run | null>(null);
  const [voidTarget, setVoidTarget] = useState<Run | null>(null);

  const employees = useMemo(() => data?.employees ?? [], [data]);
  const leave = useMemo(() => data?.leave ?? [], [data]);
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const attendance = useMemo(() => data?.attendance ?? [], [data]);

  const loadHr = useCallback(async (): Promise<HrPayload | null> => {
    const res = await callApi<HrPayload>("/api/hr");
    if (!res.ok || !res.data) {
      setLoadError(res.error?.title ?? "Couldn't load your people");
      return null;
    }
    setLoadError(null);
    setData(res.data);
    return res.data;
  }, []);

  const loadTime = useCallback(async (from: string, to: string) => {
    const res = await callApi<{ rows?: TimeRow[] }>(`/api/time?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!res.ok || !res.data) return;
    setTime({ from, to, rows: res.data.rows ?? [] });
  }, []);

  const loadPending = useCallback(async () => {
    const res = await callApi<{ entries?: PendingEntry[] }>("/api/time?pending=1");
    if (res.ok && res.data) setPendingEntries(res.data.entries ?? []);
  }, []);

  const loadBalance = useCallback(async (employeeId: string) => {
    if (!employeeId) {
      setBalance(null);
      return;
    }
    const res = await callApi<LeaveBalance>(`/api/hr?view=balance&employeeId=${encodeURIComponent(employeeId)}`);
    setBalance(res.ok && res.data ? res.data : null);
  }, []);

  const loadCalendar = useCallback(async (month: string) => {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return;
    const res = await callApi<{ entries?: CalendarEntry[] }>(`/api/hr?view=calendar&year=${y}&month=${m}`);
    setCalendar(res.ok && res.data ? res.data.entries ?? [] : null);
  }, []);

  useEffect(() => {
    if (!__enabled) return;
    const b = monthBounds();
    void Promise.all([loadHr(), loadTime(b.from, b.to), loadPending()]);
  }, [__enabled, loadHr, loadTime, loadPending]);

  useEffect(() => {
    if (calendarMonth) void loadCalendar(calendarMonth);
  }, [calendarMonth, loadCalendar]);

  function changeTab(id: string) {
    setTab(id as TabId);
    history.replaceState(null, "", `#${id}`);
  }

  async function post(url: "/api/hr" | "/api/time", payload: Record<string, unknown>, label: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi(url, payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} needs human approval - it's in the Approvals inbox.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      router.refresh();
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  async function hire(): Promise<void> {
    if (!hireForm.name.trim() || !hireForm.salary) {
      setNotice({ tone: "error", error: { title: "Missing details", hint: "Name and monthly salary are both required." } });
      return;
    }
    const ok = await post(
      "/api/hr",
      {
        action: "hireEmployee",
        name: hireForm.name.trim(),
        email: hireForm.email.trim() || undefined,
        title: hireForm.title.trim() || undefined,
        monthlySalaryMinor: Math.round(Number(hireForm.salary || "0") * 100),
        taxRateBps: Math.round(Number(hireForm.taxRate || "0") * 100),
      },
      `Hire ${hireForm.name.trim()}`,
    );
    if (ok) {
      setHireForm({ name: "", email: "", title: "", salary: "", taxRate: "10" });
      await loadHr();
    }
  }

  async function fileLeave(): Promise<void> {
    if (!leaveForm.employeeId || !leaveForm.startDate || !leaveForm.endDate) {
      setNotice({ tone: "error", error: { title: "Missing details", hint: "Pick an employee and both dates." } });
      return;
    }
    if (leaveForm.endDate < leaveForm.startDate) {
      setNotice({ tone: "error", error: { title: "Dates out of order", hint: "Leave cannot end before it starts." } });
      return;
    }
    const who = employees.find((e) => e.id === leaveForm.employeeId)?.name ?? "Leave request";
    const ok = await post(
      "/api/hr",
      {
        action: "requestLeave",
        employeeId: leaveForm.employeeId,
        kind: leaveForm.kind,
        startDate: leaveForm.startDate,
        endDate: leaveForm.endDate,
      },
      `Leave request for ${who}`,
    );
    if (ok) {
      setLeaveForm({ employeeId: "", kind: "annual", startDate: "", endDate: "" });
      await loadHr();
    }
  }

  async function logTime(): Promise<void> {
    const minutes = Math.round(Number(logForm.hours || "0") * 60);
    if (!logForm.employeeId || !logForm.workDate || !Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
      setNotice({
        tone: "error",
        error: { title: "Check the entry", hint: "Pick an employee, a date, and hours between 0 and 24." },
      });
      return;
    }
    const ok = await post(
      "/api/time",
      {
        action: "log",
        employeeId: logForm.employeeId,
        workDate: logForm.workDate,
        minutes,
        note: logForm.note.trim() || undefined,
      },
      "Time entry",
    );
    if (ok) {
      setLogForm({ employeeId: "", workDate: isoDate(new Date()), hours: "", note: "" });
      await Promise.all([loadTime(range.from, range.to), loadHr()]);
    }
  }

  async function decideLeave(requestId: string, approve: boolean, employeeName: string): Promise<void> {
    const ok = await post(
      "/api/hr",
      { action: "decideLeave", requestId, approve },
      approve ? `Approve ${employeeName}'s leave` : `Reject ${employeeName}'s leave`,
    );
    if (ok) await loadHr();
  }

  async function cancelLeave(requestId: string): Promise<void> {
    const ok = await post("/api/hr", { action: "cancelLeave", requestId }, "Cancel leave request");
    if (ok) await loadHr();
  }

  async function decideEntry(entry: PendingEntry, decision: "approved" | "rejected"): Promise<void> {
    const ok = await post(
      "/api/time",
      { action: "decide", entryId: entry.id, decision },
      `${decision === "approved" ? "Approve" : "Reject"} ${entry.employeeName}'s entry`,
    );
    if (ok) await Promise.all([loadPending(), loadTime(range.from, range.to)]);
  }

  async function clock(employee: Employee, kind: "clockIn" | "clockOut"): Promise<void> {
    const ok = await post("/api/hr", { action: kind, employeeId: employee.id }, `${kind === "clockIn" ? "Clock in" : "Clock out"} ${employee.name}`);
    if (ok) await loadHr();
  }

  function openStructure(emp: Employee): void {
    setStructureForm({
      department: emp.department ?? "",
      position: emp.title ?? "",
      managerEmployeeId: emp.managerEmployeeId ?? "",
      emergencyContactName: emp.emergencyContactName ?? "",
      emergencyContactPhone: emp.emergencyContactPhone ?? "",
    });
    setStructureTarget(emp);
  }

  async function saveStructure(): Promise<void> {
    if (!structureTarget) return;
    const ok = await post(
      "/api/hr",
      {
        action: "updateStructure",
        employeeId: structureTarget.id,
        department: structureForm.department.trim() || undefined,
        position: structureForm.position.trim() || undefined,
        managerEmployeeId: structureForm.managerEmployeeId || undefined,
        emergencyContactName: structureForm.emergencyContactName.trim() || undefined,
        emergencyContactPhone: structureForm.emergencyContactPhone.trim() || undefined,
      },
      `Update ${structureTarget.name}'s details`,
    );
    setStructureTarget(null);
    if (ok) await loadHr();
  }

  async function draftRun(): Promise<void> {
    const [y, m] = runPeriod.split("-").map(Number);
    if (!y || !m) return;
    const ok = await post("/api/hr", { action: "createPayrollRun", year: y, month: m }, `Draft payroll for ${monthLabel(y, m)}`);
    if (ok) await loadHr();
  }

  if (loadError && !data) {
    return (
      <AppFrame appId="hr">
        <EmptyState
          icon={<IconAlertTriangle />}
          title={loadError}
          hint="Check your connection, then retry."
          action={
            <Button
              tone="secondary"
              onClick={() => {
                const b = monthBounds();
                void loadHr().then(() => loadTime(b.from, b.to));
              }}
            >
              Retry
            </Button>
          }
        />
      </AppFrame>
    );
  }

  if (!__enabled) return <ModuleDisabled label="HR & Payroll" />;
  if (!data) return <LoadingPage />;

  const activeStaff = employees.filter((e) => e.active);
  const pendingLeave = leave.filter((l) => l.status === "pending");
  const monthlyCostMinor = activeStaff.reduce((s, e) => s + e.monthlySalaryMinor, 0);
  const latestRun = runs[0];
  const pendingMinutes = time.rows.reduce((s, r) => s + r.pendingMinutes, 0);
  const approvedMinutes = time.rows.reduce((s, r) => s + r.approvedMinutes, 0);
  const timeByEmployee = new Map(time.rows.map((r) => [r.employeeId, r]));
  const monthB = monthBounds();
  const periodLabel = time.from === monthB.from && time.to === monthB.to ? "this month" : `${formatDate(time.from)} – ${formatDate(time.to)}`;
  const [runY, runM] = runPeriod.split("-").map(Number);
  const periodAlreadyDrafted = runs.some((r) => r.year === runY && r.month === runM);

  return (
    <AppFrame
      appId="hr"
      description="Hire people, decide leave and timesheets, and run payroll - drafts must be confirmed before money moves."
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "people", label: "People", count: activeStaff.length || undefined },
        { id: "hiring", label: "Hiring", count: (data.openings ?? []).filter((o) => o.status === "open").length || undefined },
        { id: "leave", label: "Leave", count: pendingLeave.length || undefined },
        { id: "time", label: "Time", count: time.rows.filter((r) => r.pendingMinutes > 0).length || undefined },
        { id: "payroll", label: "Payroll", count: runs.filter((r) => r.status === "draft").length || undefined },
        { id: "expenses", label: "Expenses" },
      ]}
      activeTab={tab}
      onTabChange={changeTab}
      persistKey="hr"
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <OverviewTab
          activeStaff={activeStaff}
          totalStaff={employees.length}
          pendingLeave={pendingLeave}
          pendingMinutes={pendingMinutes}
          approvedMinutes={approvedMinutes}
          periodLabel={periodLabel}
          monthlyCostMinor={monthlyCostMinor}
          latestRun={latestRun}
          onTabChange={changeTab}
          onDecideLeave={decideLeave}
          busy={busy}
        />
      )}

      {tab === "people" && (
        <>
          <Card>
            <CardTitle>Hire an employee</CardTitle>
            <form
              className="flex flex-wrap items-end gap-2 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void hire();
              }}
            >
              <div className="min-w-40 flex-1">
                <label htmlFor="hire-name" className="label">
                  Name
                </label>
                <input
                  id="hire-name"
                  className="input"
                  placeholder="Full name"
                  value={hireForm.name}
                  onChange={(e) => setHireForm({ ...hireForm, name: e.target.value })}
                />
              </div>
              <div className="min-w-36 flex-1">
                <label htmlFor="hire-title" className="label">
                  Title <span className="opacity-50">(optional)</span>
                </label>
                <input
                  id="hire-title"
                  className="input"
                  placeholder="e.g. Account manager"
                  value={hireForm.title}
                  onChange={(e) => setHireForm({ ...hireForm, title: e.target.value })}
                />
              </div>
              <div className="min-w-44 flex-1">
                <label htmlFor="hire-email" className="label">
                  Email <span className="opacity-50">(optional)</span>
                </label>
                <input
                  id="hire-email"
                  type="email"
                  className="input"
                  placeholder="name@company.com"
                  value={hireForm.email}
                  onChange={(e) => setHireForm({ ...hireForm, email: e.target.value })}
                />
              </div>
              <div className="w-32">
                <label htmlFor="hire-salary" className="label">
                  Monthly salary
                </label>
                <input
                  id="hire-salary"
                  inputMode="decimal"
                  className="input tnum"
                  placeholder="4500.00"
                  value={hireForm.salary}
                  onChange={(e) => setHireForm({ ...hireForm, salary: e.target.value })}
                />
              </div>
              <div className="w-28">
                <label htmlFor="hire-tax" className="label">
                  Tax rate %
                </label>
                <input
                  id="hire-tax"
                  inputMode="numeric"
                  className="input tnum"
                  value={hireForm.taxRate}
                  onChange={(e) => setHireForm({ ...hireForm, taxRate: e.target.value })}
                />
              </div>
              <Button type="submit" loading={busy} disabled={!hireForm.name.trim() || !hireForm.salary}>
                Hire
              </Button>
            </form>
          </Card>

          <Card>
            <CardTitle right={<span className="text-xs text-stone-500">{activeStaff.length} active · {employees.length} total</span>}>
              Employees
            </CardTitle>
            {employees.length === 0 ? (
              <EmptyState
                icon={<IconUsers />}
                title="No employees yet"
                hint="Hire your first team member above - they join every future payroll draft automatically."
              />
            ) : (
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Contact</th>
                      <th className="text-right">Monthly salary</th>
                      <th className="text-right">Tax</th>
                      <th>Status</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((emp) => (
                      <tr key={emp.id} className={cn(!emp.active && "opacity-55")}>
                        <td>
                          <span className="font-medium text-stone-900">{emp.name}</span>
                          {emp.title && <span className="block text-xs text-stone-500">{emp.title}</span>}
                        </td>
                        <td className="text-stone-500">{emp.email ?? "-"}</td>
                        <td className="tnum text-right font-medium">{formatMoney(emp.monthlySalaryMinor)}</td>
                        <td className="tnum text-right text-stone-500">{(emp.taxRateBps / 100).toFixed(1)}%</td>
                        <td>
                          <Badge tone={emp.active ? "green" : "neutral"}>{emp.active ? "active" : "inactive"}</Badge>
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {emp.active && (
                            <span className="inline-flex gap-1.5">
                              <Button tone="ghost" size="sm" disabled={busy} onClick={() => openStructure(emp)}>
                                Edit
                              </Button>
                              <Button tone="ghost" size="sm" disabled={busy} onClick={() => setDeactivateTarget(emp)}>
                                Deactivate
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {tab === "hiring" && (
        <HiringTab
          openings={data.openings ?? []}
          applicants={data.applicants ?? []}
          busy={busy}
          post={(payload, label) => post("/api/hr", payload, label)}
          onChanged={loadHr}
        />
      )}

      {tab === "leave" && (
        <>
          <Card>
            <CardTitle>File a leave request</CardTitle>
            {activeStaff.length === 0 ? (
              <p className="text-sm text-stone-500">
                No active employees yet - hire your first person in the <strong>People</strong> tab before filing leave.
              </p>
            ) : (
              <form
                className="flex flex-wrap items-end gap-2 text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void fileLeave();
                }}
              >
                <div className="min-w-44 flex-1">
                  <label htmlFor="leave-employee" className="label">
                    Employee
                  </label>
                  <select
                    id="leave-employee"
                    className="select"
                    value={leaveForm.employeeId}
                    onChange={(e) => setLeaveForm({ ...leaveForm, employeeId: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {activeStaff.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-40">
                  <label htmlFor="leave-kind" className="label">
                    Type
                  </label>
                  <select
                    id="leave-kind"
                    className="select"
                    value={leaveForm.kind}
                    onChange={(e) => setLeaveForm({ ...leaveForm, kind: e.target.value })}
                  >
                    <option value="annual">Annual · paid</option>
                    <option value="sick">Sick · paid</option>
                    <option value="unpaid">Unpaid · reduces pay</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="leave-start" className="label">
                    From
                  </label>
                  <input
                    id="leave-start"
                    type="date"
                    className="input"
                    value={leaveForm.startDate}
                    onChange={(e) => setLeaveForm({ ...leaveForm, startDate: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="leave-end" className="label">
                    To
                  </label>
                  <input
                    id="leave-end"
                    type="date"
                    className="input"
                    value={leaveForm.endDate}
                    onChange={(e) => setLeaveForm({ ...leaveForm, endDate: e.target.value })}
                  />
                </div>
                <Button type="submit" loading={busy} disabled={!leaveForm.employeeId || !leaveForm.startDate || !leaveForm.endDate}>
                  File request
                </Button>
              </form>
            )}

            <div className="mt-5 border-t border-stone-100 pt-4">
              <CardTitle>Pending decisions</CardTitle>
              {pendingLeave.length === 0 ? (
                <p className="mt-2 flex items-center gap-2 text-sm text-stone-400">
                  <IconInbox className="size-4" /> Nothing waiting on you - every request has been decided.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {pendingLeave.map((l) => (
                    <li
                      key={l.id}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-sm"
                    >
                      <span className="text-stone-700">
                        <strong className="text-stone-900">{l.employeeName}</strong> · {l.kind} ·{" "}
                        <span className="tnum">
                          {l.calendarDays} day{l.calendarDays === 1 ? "" : "s"}
                        </span>{" "}
                        ·{" "}
                        <span className="whitespace-nowrap">
                          {formatDate(l.startDate)} → {formatDate(l.endDate)}
                        </span>
                      </span>
                      <span className="flex gap-2">
                        <Button size="sm" loading={busy} onClick={() => void decideLeave(l.id, true, l.employeeName)}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          tone="secondary"
                          loading={busy}
                          aria-label={`Reject ${l.employeeName}'s leave request`}
                          onClick={() => void decideLeave(l.id, false, l.employeeName)}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          tone="ghost"
                          loading={busy}
                          aria-label={`Cancel ${l.employeeName}'s leave request`}
                          onClick={() => void cancelLeave(l.id)}
                        >
                          Cancel
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle>Recent requests</CardTitle>
            {leave.length === 0 ? (
              <EmptyState icon={<IconCalendar />} title="No leave requests yet" hint="Filed requests appear here with their outcome." />
            ) : (
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Type</th>
                      <th>Dates</th>
                      <th className="text-right">Days</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leave.map((l) => (
                      <tr key={l.id}>
                        <td className="font-medium text-stone-900">{l.employeeName}</td>
                        <td className="capitalize text-stone-500">{l.kind}</td>
                        <td className="whitespace-nowrap text-stone-500">
                          {formatDate(l.startDate)} → {formatDate(l.endDate)}
                        </td>
                        <td className="tnum text-right">{l.calendarDays}</td>
                        <td>
                          <Badge tone={statusTone(l.status)}>{l.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardTitle>Balance & team calendar</CardTitle>
            <div className="flex flex-wrap items-end gap-3 text-sm">
              <div className="min-w-44">
                <label htmlFor="balance-employee" className="label">
                  Leave balance
                </label>
                <select
                  id="balance-employee"
                  className="select"
                  value={balanceEmployeeId}
                  onChange={(e) => {
                    setBalanceEmployeeId(e.target.value);
                    void loadBalance(e.target.value);
                  }}
                >
                  <option value="">Choose employee…</option>
                  {activeStaff.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </div>
              {balance && (
                <p className="tnum pb-1.5 text-sm text-stone-600">
                  <strong className="text-stone-900">{balance.remainingDays}</strong> of {balance.entitlementDays} days left ·{" "}
                  {balance.takenDays} taken this year
                </p>
              )}
              <div className="ml-auto">
                <label htmlFor="calendar-month" className="label">
                  Team calendar
                </label>
                <input
                  id="calendar-month"
                  type="month"
                  className="input"
                  value={calendarMonth}
                  onChange={(e) => setCalendarMonth(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-3">
              {calendar === null ? (
                <p className="text-sm text-stone-400">Approved leave for the chosen month appears here.</p>
              ) : calendar.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-stone-400">
                  <IconCalendar className="size-4" /> No approved leave this month.
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {calendar.map((c, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-stone-900">{c.employeeName}</span>
                        <span className="ml-2 capitalize text-stone-500">{c.kind}</span>
                      </span>
                      <span className="shrink-0 text-stone-500">
                        {formatDate(c.startDate)} → {formatDate(c.endDate)} ·{" "}
                        <span className="tnum">
                          {c.days} day{c.days === 1 ? "" : "s"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </>
      )}

      {tab === "time" && (
        <>
          <Card>
            <CardTitle>Log time</CardTitle>
            {activeStaff.length === 0 ? (
              <p className="text-sm text-stone-500">
                No active employees yet - hire your first person in the <strong>People</strong> tab before logging time.
              </p>
            ) : (
              <form
                className="flex flex-wrap items-end gap-2 text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void logTime();
                }}
              >
                <div className="min-w-44 flex-1">
                  <label htmlFor="time-employee" className="label">
                    Employee
                  </label>
                  <select
                    id="time-employee"
                    className="select"
                    value={logForm.employeeId}
                    onChange={(e) => setLogForm({ ...logForm, employeeId: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {activeStaff.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="time-date" className="label">
                    Date
                  </label>
                  <input
                    id="time-date"
                    type="date"
                    className="input"
                    value={logForm.workDate}
                    onChange={(e) => setLogForm({ ...logForm, workDate: e.target.value })}
                  />
                </div>
                <div className="w-28">
                  <label htmlFor="time-hours" className="label">
                    Hours
                  </label>
                  <input
                    id="time-hours"
                    inputMode="decimal"
                    className="input tnum"
                    placeholder="7.5"
                    value={logForm.hours}
                    onChange={(e) => setLogForm({ ...logForm, hours: e.target.value })}
                  />
                </div>
                <div className="min-w-40 flex-1">
                  <label htmlFor="time-note" className="label">
                    Note <span className="opacity-50">(optional)</span>
                  </label>
                  <input
                    id="time-note"
                    className="input"
                    placeholder="What was worked on?"
                    value={logForm.note}
                    onChange={(e) => setLogForm({ ...logForm, note: e.target.value })}
                  />
                </div>
                <Button type="submit" loading={busy} disabled={!logForm.employeeId || !logForm.workDate || !Number(logForm.hours)}>
                  Log time
                </Button>
              </form>
            )}
            <p className="mt-3 text-xs text-stone-400">Entries are submitted for approval - only approved hours count toward reports.</p>
          </Card>

          <Card>
            <CardTitle
              right={
                <form
                  className="flex items-center gap-1.5 text-xs"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadTime(range.from, range.to);
                  }}
                >
                  <input
                    aria-label="Range start"
                    type="date"
                    className="input px-2 py-1"
                    value={range.from}
                    onChange={(e) => setRange({ ...range, from: e.target.value })}
                  />
                  <span aria-hidden="true">→</span>
                  <input
                    aria-label="Range end"
                    type="date"
                    className="input px-2 py-1"
                    value={range.to}
                    onChange={(e) => setRange({ ...range, to: e.target.value })}
                  />
                  <Button type="submit" size="sm" tone="secondary" loading={busy}>
                    Apply
                  </Button>
                </form>
              }
            >
              Approved vs pending hours
            </CardTitle>
            {time.rows.length === 0 ? (
              <EmptyState
                icon={<IconHistory />}
                title="No time logged in this range"
                hint="Adjust the range above or log an entry - submitted entries show as pending until approved."
              />
            ) : (
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="text-right">Approved</th>
                      <th className="text-right">Pending</th>
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees
                      .filter((emp) => timeByEmployee.has(emp.id))
                      .map((emp) => {
                        const row = timeByEmployee.get(emp.id)!;
                        return (
                          <tr key={emp.id}>
                            <td className="font-medium text-stone-900">{emp.name}</td>
                            <td className="tnum text-right">{fmtHours(row.approvedMinutes)}</td>
                            <td className={cn("tnum text-right", row.pendingMinutes > 0 && "font-medium text-amber-700")}>
                              {row.pendingMinutes > 0 ? fmtHours(row.pendingMinutes) : "-"}
                            </td>
                            <td className="tnum text-right font-medium">{fmtHours(row.approvedMinutes + row.pendingMinutes)}</td>
                          </tr>
                        );
                      })}
                    <tr className="border-t-2 border-stone-200 font-medium">
                      <td>Total · {periodLabel}</td>
                      <td className="tnum text-right">{fmtHours(approvedMinutes)}</td>
                      <td className="tnum text-right text-amber-700">{pendingMinutes > 0 ? fmtHours(pendingMinutes) : "-"}</td>
                      <td className="tnum text-right">{fmtHours(approvedMinutes + pendingMinutes)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {time.rows.some((r) => r.pendingMinutes > 0) && (
              <p className="mt-2 text-xs text-stone-400">Submitted entries below need a decision before the hours count anywhere.</p>
            )}
          </Card>

          <Card>
            <CardTitle>Pending approvals</CardTitle>
            {pendingEntries === null ? (
              <p className="text-sm text-stone-400">Loading…</p>
            ) : pendingEntries.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-stone-400">
                <IconInbox className="size-4" /> No submitted entries waiting - everything is decided.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {pendingEntries.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
                    <span className="text-stone-700">
                      <strong className="text-stone-900">{e.employeeName}</strong> ·{" "}
                      <span className="tnum">{fmtHours(e.minutes)}</span> · {formatDate(e.workDate)}
                      {e.late && <Badge tone="amber" className="ml-2">late</Badge>}
                      {e.note && <span className="ml-2 text-stone-500">{e.note}</span>}
                    </span>
                    <span className="flex gap-2">
                      <Button size="sm" loading={busy} onClick={() => void decideEntry(e, "approved")}>
                        Approve
                      </Button>
                      <Button size="sm" tone="secondary" loading={busy} onClick={() => void decideEntry(e, "rejected")}>
                        Reject
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle>Attendance</CardTitle>
            {activeStaff.length === 0 ? (
              <p className="text-sm text-stone-500">No active employees yet.</p>
            ) : (
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Open entry</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {activeStaff.map((emp) => {
                      const open = attendance.find((a) => a.employeeId === emp.id);
                      return (
                        <tr key={emp.id}>
                          <td className="font-medium text-stone-900">{emp.name}</td>
                          <td>
                            {open ? (
                              <span className="flex items-center gap-2 text-sm text-stone-600">
                                in since {formatDateTime(open.clockedInAt)}
                                {open.late && <Badge tone="amber">late</Badge>}
                              </span>
                            ) : (
                              <span className="text-sm text-stone-400">-</span>
                            )}
                          </td>
                          <td className="text-right">
                            <Button
                              size="sm"
                              tone={open ? "secondary" : "primary"}
                              disabled={busy}
                              onClick={() => void clock(emp, open ? "clockOut" : "clockIn")}
                            >
                              {open ? "Clock out" : "Clock in"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-stone-400">Clock-ins after 09:00 are flagged late; clocking out settles the minutes worked.</p>
          </Card>
        </>
      )}

      {tab === "payroll" && (
        <>
          <Card>
            <CardTitle>Draft a payroll run</CardTitle>
            <form
              className="flex flex-wrap items-end gap-2 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void draftRun();
              }}
            >
              <div>
                <label htmlFor="run-period" className="label">
                  Month
                </label>
                <input id="run-period" type="month" className="input" value={runPeriod} onChange={(e) => setRunPeriod(e.target.value)} />
              </div>
              <Button type="submit" loading={busy} disabled={periodAlreadyDrafted || activeStaff.length === 0}>
                Draft run
              </Button>
              {activeStaff.length === 0 && <span className="pb-2 text-xs text-stone-400">Payroll needs at least one active employee.</span>}
              {periodAlreadyDrafted && <span className="pb-2 text-xs text-stone-400">A run for this month already exists.</span>}
            </form>
            <p className="mt-3 text-xs text-stone-400">
              A draft prorates every active salary for the month and reduces pay for approved unpaid leave. Nothing posts to the books
              until you execute it.
            </p>
          </Card>

          <Card>
            <CardTitle>Runs</CardTitle>
            {runs.length === 0 ? (
              <EmptyState
                icon={<IconCash />}
                title="No payroll runs yet"
                hint="Draft your first month above - you'll review the totals before any money moves."
              />
            ) : (
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Status</th>
                      <th className="text-right">Headcount</th>
                      <th className="text-right">Gross</th>
                      <th className="text-right">Tax</th>
                      <th className="text-right">Net</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap font-medium text-stone-900">{monthLabel(r.year, r.month)}</td>
                        <td>
                          <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="tnum text-right">{r.headcount}</td>
                        <td className="tnum text-right">{formatMoney(r.totalGrossMinor)}</td>
                        <td className="tnum text-right text-stone-500">{formatMoney(r.totalTaxMinor)}</td>
                        <td className="tnum text-right font-medium">{formatMoney(r.totalNetMinor)}</td>
                        <td className="whitespace-nowrap text-right">
                          {r.status === "draft" && (
                            <span className="inline-flex gap-1.5">
                              <Button size="sm" loading={busy} onClick={() => setExecuteTarget(r)}>
                                Execute
                              </Button>
                              <Button
                                size="sm"
                                tone="ghost"
                                disabled={busy}
                                aria-label={`Void the draft payroll run for ${monthLabel(r.year, r.month)}`}
                                onClick={() => setVoidTarget(r)}
                              >
                                Void
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-stone-400">Executed runs are posted ledger entries - corrections go through reversals, not edits.</p>
          </Card>
        </>
      )}

      {tab === "expenses" && <ExpensesTab />}

      {/* Structure edit - where someone sits and who to call */}
      <Dialog
        open={structureTarget !== null}
        onClose={() => setStructureTarget(null)}
        title={`Edit ${structureTarget?.name ?? ""}`}
        description="Department, position and reporting line feed the directory; the emergency contact is who gets called."
        width="max-w-lg"
        footer={
          <>
            <Button tone="secondary" onClick={() => setStructureTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void saveStructure()} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <label htmlFor="struct-dept" className="label">
              Department
            </label>
            <input
              id="struct-dept"
              className="input"
              value={structureForm.department}
              onChange={(e) => setStructureForm({ ...structureForm, department: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="struct-position" className="label">
              Position
            </label>
            <input
              id="struct-position"
              className="input"
              value={structureForm.position}
              onChange={(e) => setStructureForm({ ...structureForm, position: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label htmlFor="struct-manager" className="label">
              Reports to
            </label>
            <select
              id="struct-manager"
              className="select"
              value={structureForm.managerEmployeeId}
              onChange={(e) => setStructureForm({ ...structureForm, managerEmployeeId: e.target.value })}
            >
              <option value="">Nobody</option>
              {activeStaff
                .filter((e) => e.id !== structureTarget?.id)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label htmlFor="struct-ec-name" className="label">
              Emergency contact
            </label>
            <input
              id="struct-ec-name"
              className="input"
              value={structureForm.emergencyContactName}
              onChange={(e) => setStructureForm({ ...structureForm, emergencyContactName: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="struct-ec-phone" className="label">
              Emergency phone
            </label>
            <input
              id="struct-ec-phone"
              className="input"
              value={structureForm.emergencyContactPhone}
              onChange={(e) => setStructureForm({ ...structureForm, emergencyContactPhone: e.target.value })}
            />
          </div>
        </div>
      </Dialog>

      {/* Deactivate employee */}
      <ConfirmDialog
        open={deactivateTarget !== null}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={async () => {
          if (!deactivateTarget) return;
          const ok = await post(
            "/api/hr",
            { action: "deactivateEmployee", employeeId: deactivateTarget.id },
            `Deactivate ${deactivateTarget.name}`,
          );
          setDeactivateTarget(null);
          if (ok) await loadHr();
        }}
        title={`Deactivate ${deactivateTarget?.name ?? ""}?`}
        body="They stop appearing in new payroll drafts and can't be assigned leave. History and payslips are preserved."
        confirmLabel="Deactivate"
        busy={busy}
      />

      {/* Execute payroll run - posts money, so it always confirms */}
      <ConfirmDialog
        open={executeTarget !== null}
        onClose={() => setExecuteTarget(null)}
        onConfirm={async () => {
          if (!executeTarget) return;
          const ok = await post(
            "/api/hr",
            {
              action: "executePayrollRun",
              runId: executeTarget.id,
              expectedTotalNetMinor: executeTarget.totalNetMinor,
            },
            `Execute payroll for ${monthLabel(executeTarget.year, executeTarget.month)}`,
          );
          setExecuteTarget(null);
          if (ok) await loadHr();
        }}
        title={`Execute payroll for ${executeTarget ? monthLabel(executeTarget.year, executeTarget.month) : ""}?`}
        body={
          <>
            This posts <strong className="tnum text-stone-900">{executeTarget ? formatMoney(executeTarget.totalNetMinor) : ""}</strong> net
            ({formatMoney(executeTarget?.totalGrossMinor ?? 0)} gross, {formatMoney(executeTarget?.totalTaxMinor ?? 0)} withheld) for{" "}
            {executeTarget?.headcount ?? 0} employee{(executeTarget?.headcount ?? 0) === 1 ? "" : "s"} as a balanced ledger entry. Posted
            runs are immutable.
          </>
        }
        confirmLabel={`Post ${executeTarget ? formatMoney(executeTarget.totalNetMinor) : ""} net`}
        busy={busy}
      />

      {/* Void payroll run */}
      <ConfirmDialog
        open={voidTarget !== null}
        onClose={() => setVoidTarget(null)}
        onConfirm={async () => {
          if (!voidTarget) return;
          const ok = await post(
            "/api/hr",
            { action: "voidPayrollRun", runId: voidTarget.id },
            `Void draft payroll for ${monthLabel(voidTarget.year, voidTarget.month)}`,
          );
          setVoidTarget(null);
          if (ok) await loadHr();
        }}
        title={`Void the draft for ${voidTarget ? monthLabel(voidTarget.year, voidTarget.month) : ""}?`}
        body="The draft is discarded without posting anything. You'd have to draft the month again from scratch."
        confirmLabel="Void draft"
        busy={busy}
      />
    </AppFrame>
  );
}

/* ---------------------------------------------------------------- overview -- */

function OverviewTab({
  activeStaff,
  totalStaff,
  pendingLeave,
  pendingMinutes,
  approvedMinutes,
  periodLabel,
  monthlyCostMinor,
  latestRun,
  onTabChange,
  onDecideLeave,
  busy,
}: {
  activeStaff: Employee[];
  totalStaff: number;
  pendingLeave: LeaveRow[];
  pendingMinutes: number;
  approvedMinutes: number;
  periodLabel: string;
  monthlyCostMinor: number;
  latestRun: Run | undefined;
  onTabChange: (id: string) => void;
  onDecideLeave: (requestId: string, approve: boolean, employeeName: string) => Promise<void>;
  busy: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Headcount"
          value={totalStaff}
          sub={`${activeStaff.length} active · ${formatMoneyWhole(monthlyCostMinor)}/mo in salaries`}
          onClick={() => onTabChange("people")}
          actionLabel="Open the people list"
        />
        <StatCard
          label="Leave awaiting your decision"
          value={pendingLeave.length}
          sub={pendingLeave.length > 0 ? "Decisions feed payroll proration" : "Nothing pending"}
          tone={pendingLeave.length > 0 ? "warn" : "default"}
          onClick={() => onTabChange("leave")}
          actionLabel="Review leave requests"
        />
        <StatCard
          label={`Hours ${periodLabel}`}
          value={fmtHours(approvedMinutes)}
          sub={pendingMinutes > 0 ? `${fmtHours(pendingMinutes)} more awaiting approval` : "All logged hours approved"}
          tone={pendingMinutes > 0 ? "warn" : "success"}
          onClick={() => onTabChange("time")}
          actionLabel="Review team time entries"
        />
        <StatCard
          label="Latest payroll run"
          value={latestRun ? monthLabel(latestRun.year, latestRun.month) : "-"}
          sub={
            latestRun ? (
              <span className="flex items-center gap-1.5">
                <Badge tone={statusTone(latestRun.status)}>{latestRun.status}</Badge>
                <span className="tnum">{formatMoneyWhole(latestRun.totalNetMinor)} net</span>
              </span>
            ) : (
              "No runs drafted yet"
            )
          }
          tone={
            !latestRun ? "default" : latestRun.status === "executed" ? "success" : latestRun.status === "voided" ? "danger" : "accent"
          }
          onClick={() => onTabChange("payroll")}
          actionLabel="Open payroll runs"
        />
      </div>

      {totalStaff === 0 ? (
        <Card>
          <EmptyState
            icon={<IconUsers />}
            title="Your org chart is empty"
            hint="HR & Payroll starts with people: hire your first employee, and payroll drafts will pick them up automatically."
            action={<Button onClick={() => onTabChange("people")}>Go to People</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle
              right={
                pendingLeave.length > 0 ? (
                  <Button tone="ghost" size="sm" onClick={() => onTabChange("leave")}>
                    All leave
                  </Button>
                ) : undefined
              }
            >
              Pending leave decisions
            </CardTitle>
            {pendingLeave.length === 0 ? (
              <p className="flex items-center gap-2 py-3 text-sm text-stone-400">
                <IconInbox className="size-4" /> Nothing waiting on you.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {pendingLeave.slice(0, 3).map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5">
                    <span className="text-stone-700">
                      <strong className="text-stone-900">{l.employeeName}</strong> · {l.kind} ·{" "}
                      <span className="tnum">{l.calendarDays}d</span>{" "}
                      <span className="whitespace-nowrap text-stone-400">
                        ({formatDate(l.startDate)} → {formatDate(l.endDate)})
                      </span>
                    </span>
                    <span className="flex gap-2">
                      <Button size="sm" loading={busy} onClick={() => void onDecideLeave(l.id, true, l.employeeName)}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        tone="secondary"
                        loading={busy}
                        aria-label={`Reject ${l.employeeName}'s leave request`}
                        onClick={() => void onDecideLeave(l.id, false, l.employeeName)}
                      >
                        Reject
                      </Button>
                    </span>
                  </li>
                ))}
                {pendingLeave.length > 3 && <li className="py-2 text-xs text-stone-400">+{pendingLeave.length - 3} more in the Leave tab</li>}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle
              right={
                latestRun && latestRun.status === "draft" ? (
                  <Button tone="ghost" size="sm" onClick={() => onTabChange("payroll")}>
                    Review run
                  </Button>
                ) : undefined
              }
            >
              Payroll
            </CardTitle>
            {!latestRun ? (
              <div className="py-3">
                <p className="text-sm text-stone-500">
                  {activeStaff.length} active employee{activeStaff.length === 1 ? "" : "s"},{" "}
                  <span className="tnum font-medium text-stone-900">{formatMoney(monthlyCostMinor)}</span> in monthly salaries. Draft a
                  run when you're ready to pay.
                </p>
                <Button className="mt-3" size="sm" onClick={() => onTabChange("payroll")}>
                  Go to Payroll
                </Button>
              </div>
            ) : (
              <div className="space-y-2 py-1 text-sm">
                <p className="flex items-center justify-between gap-2">
                  <span className="text-stone-500">
                    {monthLabel(latestRun.year, latestRun.month)} · {latestRun.headcount} employee{latestRun.headcount === 1 ? "" : "s"}
                  </span>
                  <Badge tone={statusTone(latestRun.status)}>{latestRun.status}</Badge>
                </p>
                <dl className="grid grid-cols-3 gap-2 border-t border-stone-100 pt-3">
                  {(
                    [
                      ["Gross", latestRun.totalGrossMinor],
                      ["Tax withheld", latestRun.totalTaxMinor],
                      ["Net", latestRun.totalNetMinor],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs text-stone-400">{k}</dt>
                      <dd className="tnum font-semibold text-stone-900">{formatMoney(v)}</dd>
                    </div>
                  ))}
                </dl>
                {latestRun.status === "draft" && (
                  <p className="pt-1 text-xs text-amber-700">This draft hasn't posted yet - executing it moves real money in the ledger.</p>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- expenses -- */

/** Mirrors accounting.listExpenseClaims' output rows (via /api/expenses). */
interface ExpenseClaim {
  id: string;
  claimantUserId: string;
  amountMinor: number;
  status: string;
  memo: string;
}

function ExpensesTab() {
  const router = useRouter();
  const [claims, setClaims] = useState<ExpenseClaim[] | null>(null);
  const [policies, setPolicies] = useState<{ category: string; limitMinor: number }[]>([]);
  const [policyForm, setPolicyForm] = useState({ category: "", limit: "" });
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ amount: "", memo: "", accountCode: "" });

  const loadClaims = useCallback(async (): Promise<boolean> => {
    const res = await callApi<{ claims?: ExpenseClaim[]; policies?: { category: string; limitMinor: number }[] }>("/api/expenses");
    if (!res.ok || !res.data) {
      setNotice({ tone: "error", error: res.error! });
      return false;
    }
    setClaims(res.data.claims ?? []);
    setPolicies(res.data.policies ?? []);
    return true;
  }, []);

  useEffect(() => {
    void loadClaims();
  }, [loadClaims]);

  async function post(payload: Record<string, unknown>, label: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi("/api/expenses", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} is above the payment threshold - it's in the Approvals inbox.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      router.refresh();
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  async function submitClaim(): Promise<void> {
    const memo = form.memo.trim();
    const amountMinor = Math.round(Number(form.amount || "0") * 100);
    if (!memo || !Number.isInteger(amountMinor) || amountMinor <= 0) {
      setNotice({ tone: "error", error: { title: "Check the claim", hint: "An amount and a short explanation of the expense are both required." } });
      return;
    }
    const ok = await post({ action: "submit", amountMinor, memo, accountCode: form.accountCode.trim() || undefined }, "Expense claim");
    if (ok) {
      setForm({ amount: "", memo: "", accountCode: "" });
      await loadClaims();
    }
  }

  async function decideClaim(claim: ExpenseClaim, approved: boolean): Promise<void> {
    const ok = await post(
      { action: "decide", claimId: claim.id, decision: approved ? "approved" : "rejected" },
      approved ? "Approve claim" : "Reject claim",
    );
    if (ok) await loadClaims();
  }

  async function payClaim(claim: ExpenseClaim): Promise<void> {
    const ok = await post({ action: "pay", claimId: claim.id, amountMinor: claim.amountMinor }, "Reimbursement");
    if (ok) await loadClaims();
  }

  async function setPolicy(): Promise<void> {
    const limitMinor = Math.round(Number(policyForm.limit || "0") * 100);
    if (!policyForm.category.trim() || !Number.isFinite(limitMinor) || limitMinor < 0) return;
    const ok = await post(
      { action: "setPolicy", category: policyForm.category.trim(), limitMinor },
      `Set ${policyForm.category.trim()} limit`,
    );
    if (ok) {
      setPolicyForm({ category: "", limit: "" });
      await loadClaims();
    }
  }

  const pendingCount = claims?.filter((c) => c.status === "submitted").length ?? 0;
  const approvedCount = claims?.filter((c) => c.status === "approved").length ?? 0;

  return (
    <>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <Card>
        <CardTitle>Submit an expense claim</CardTitle>
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submitClaim();
          }}
        >
          <div className="w-36">
            <label htmlFor="expense-amount" className="label">
              Amount
            </label>
            <input
              id="expense-amount"
              inputMode="decimal"
              className="input tnum"
              placeholder="120.00"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>
          <div className="min-w-56 flex-1">
            <label htmlFor="expense-memo" className="label">
              What &amp; why
            </label>
            <input
              id="expense-memo"
              className="input"
              placeholder="Taxi to the client kickoff"
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
            />
          </div>
          <div className="w-32">
            <label htmlFor="expense-account" className="label">
              Account <span className="opacity-50">(optional)</span>
            </label>
            <input
              id="expense-account"
              className="input tnum"
              placeholder="6900"
              value={form.accountCode}
              onChange={(e) => setForm({ ...form, accountCode: e.target.value })}
            />
          </div>
          <Button type="submit" loading={busy} disabled={!form.memo.trim() || !form.amount}>
            Submit claim
          </Button>
        </form>
        <p className="mt-3 text-xs text-stone-400">
          The spend category is suggested from your explanation. A claim waits for a decision before any money moves, and reimbursements above
          the policy threshold need a second approval.
        </p>
      </Card>

      <Card>
        <CardTitle right={<span className="text-xs text-stone-500">{policies.length} cap{policies.length === 1 ? "" : "s"} set</span>}>
          Expense policy limits
        </CardTitle>
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void setPolicy();
          }}
        >
          <div className="w-40">
            <label htmlFor="policy-category" className="label">
              Category
            </label>
            <input
              id="policy-category"
              className="input"
              placeholder="e.g. travel"
              value={policyForm.category}
              onChange={(e) => setPolicyForm({ ...policyForm, category: e.target.value })}
            />
          </div>
          <div className="w-36">
            <label htmlFor="policy-limit" className="label">
              Scrutiny limit
            </label>
            <input
              id="policy-limit"
              inputMode="decimal"
              className="input tnum"
              placeholder="250.00"
              value={policyForm.limit}
              onChange={(e) => setPolicyForm({ ...policyForm, limit: e.target.value })}
            />
          </div>
          <Button type="submit" loading={busy} disabled={!policyForm.category.trim() || !policyForm.limit}>
            Set limit
          </Button>
        </form>
        {policies.length > 0 && (
          <ul className="mt-3 divide-y text-sm">
            {policies.map((p) => (
              <li key={p.category} className="flex items-center justify-between py-1.5">
                <span className="capitalize text-stone-700">{p.category}</span>
                <span className="tnum text-stone-500">over {formatMoney(p.limitMinor)} gets a harder look</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-stone-400">
          Claims over a category&apos;s limit stay visible as signals until decided - the cap doesn&apos;t block, it scrutinizes.
        </p>
      </Card>

      <Card>
        <CardTitle>Claims</CardTitle>
        {claims === null ? (
          <p className="text-sm text-stone-400">Loading…</p>
        ) : claims.length === 0 ? (
          <EmptyState
            icon={<IconCash />}
            title="No expense claims yet"
            hint="Filed claims appear here with their decision and payment state."
          />
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Filed by</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td className="max-w-72 truncate font-medium text-stone-900">{c.memo}</td>
                    <td className="font-mono text-xs text-stone-400">{c.claimantUserId.slice(0, 8)}</td>
                    <td className="tnum text-right">{formatMoney(c.amountMinor)}</td>
                    <td>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {c.status === "submitted" && (
                        <span className="inline-flex gap-1.5">
                          <Button size="sm" loading={busy} onClick={() => void decideClaim(c, true)}>
                            Approve
                          </Button>
                          <Button size="sm" tone="secondary" loading={busy} aria-label="Reject claim" onClick={() => void decideClaim(c, false)}>
                            Reject
                          </Button>
                        </span>
                      )}
                      {c.status === "approved" && (
                        <Button size="sm" loading={busy} onClick={() => void payClaim(c)}>
                          Pay {formatMoney(c.amountMinor)}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(pendingCount > 0 || approvedCount > 0) && (
          <p className="mt-2 text-xs text-stone-400">
            {pendingCount > 0 && `${pendingCount} awaiting decision. `}
            {approvedCount > 0 && `${approvedCount} approved and awaiting reimbursement.`}
          </p>
        )}
      </Card>
    </>
  );
}
