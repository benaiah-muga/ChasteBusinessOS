import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { fetchExpenses, ExpensesApiError, readPendingExpenseAction, submitExpenseAction, type ExpenseAction, type ExpenseClaim, type ExpensePolicy } from "../api/expenses";
import { fetchGoHrReport, fetchHrEnabled, fetchHrPendingEntries, fetchHrTime, HrApiError, readPendingHrEmployeeAction, readPendingHrHiringAction, readPendingHrLeaveAction, readPendingHrPayrollAction, readPendingHrTimeAction, submitHrEmployeeAction, submitHrHiringAction, submitHrLeaveAction, submitHrPayrollAction, submitHrTimeAction, type HrApplicant, type HrEmployee, type HrEmployeeAction, type HrHiringAction, type HrLeaveAction, type HrOpening, type HrPayrollAction, type HrPayrollRun, type HrPendingEntry, type HrReport, type HrTimeAction, type HrTimeReport } from "../api/hr";
import { PageLoading } from "../ui/page-loading";
import "./hr-page.css";

type TabId = "overview" | "people" | "hiring" | "leave" | "time" | "payroll" | "expenses";
type LoadState = { status: "loading" } | { status: "disabled" } | { status: "failed"; message: string; statusCode: number } | { status: "ready"; report: HrReport };
type Notice = { tone: "success" | "pending" | "error"; text: string };

const tabs: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "people", label: "People" },
  { id: "hiring", label: "Hiring" },
  { id: "leave", label: "Leave" },
  { id: "time", label: "Time" },
  { id: "payroll", label: "Payroll" },
  { id: "expenses", label: "Expenses" },
];

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const employeeFullName = (employees: HrEmployee[], id: string) => employees.find((employee) => employee.id === id)?.name ?? "Former employee";

function monthRange(now = new Date()) {
  return {
    from: dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    to: dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))),
  };
}

function formatMoney(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / (10 ** units));
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(timestamp);
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : hours === 0 ? `${remainder}m` : `${hours}h ${remainder}m`;
}

type HrPageProps = { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null };

export function HrPage(props: HrPageProps) {
  const scopeKey = JSON.stringify([props.actorId ?? null, props.organizationId ?? null]);
  return <HrPageContent key={scopeKey} {...props} />;
}

function HrPageContent({ baseCurrency = null, actorId = null, organizationId = null }: HrPageProps) {
  const scopeKey = JSON.stringify([actorId, organizationId]);
  const activeScopeRef = useRef<string | null>(scopeKey);
  const isCurrentScope = useCallback(() => activeScopeRef.current === scopeKey, [scopeKey]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tab, setTab] = useState<TabId>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return tabs.find((item) => item.id === requested)?.id ?? "overview";
  });
  const reportLoaded = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaveRecoveryAction, setLeaveRecoveryAction] = useState<HrLeaveAction | null>(null);
  const [hiringRecoveryAction, setHiringRecoveryAction] = useState<HrHiringAction | null>(null);
  const [employeeActionRecovery, setEmployeeActionRecovery] = useState<HrEmployeeAction | null>(null);
  const [payrollRecoveryAction, setPayrollRecoveryAction] = useState<HrPayrollAction | null>(null);
  const [timeRecoveryAction, setTimeRecoveryAction] = useState<HrTimeAction | null>(null);
  const [range, setRange] = useState(monthRange);
  const [timeReport, setTimeReport] = useState<HrTimeReport | null>(null);
  const [pendingEntries, setPendingEntries] = useState<HrPendingEntry[]>([]);
  const [hire, setHire] = useState({ name: "", email: "", title: "", salary: "" });
  const [leaveRequest, setLeaveRequest] = useState({ employeeId: "", kind: "annual", startDate: "", endDate: "" });
  const [timeEntry, setTimeEntry] = useState({ employeeId: "", workDate: dateOnly(new Date()), hours: "", note: "" });
  const [openingTitle, setOpeningTitle] = useState("");
  const [openingDepartment, setOpeningDepartment] = useState("");
  const [openingNote, setOpeningNote] = useState("");
  const [applicantForm, setApplicantForm] = useState({ openingId: "", name: "", email: "" });
  const [payrollPeriod, setPayrollPeriod] = useState(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const currency = baseCurrency;

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    return () => { activeScopeRef.current = null; };
  }, [scopeKey]);

  const load = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    if (!signal && !reportLoaded.current) setState({ status: "loading" });
    try {
      const enabled = await fetchHrEnabled(organizationId ?? "", signal);
      if (signal?.aborted || !isCurrentScope()) return false;
      if (!enabled) {
        setState({ status: "disabled" });
        return false;
      }
      const report = await fetchGoHrReport(organizationId ?? "", signal);
      if (!signal?.aborted && isCurrentScope()) {
        reportLoaded.current = true;
        setState({ status: "ready", report });
      }
      return !signal?.aborted && isCurrentScope();
    } catch (error) {
      if (signal?.aborted || !isCurrentScope()) return false;
      const apiError = error instanceof HrApiError ? error : new HrApiError(0, "Could not load People workspace data.");
      setState({ status: "failed", message: apiError.message, statusCode: apiError.status });
      return false;
    }
  }, [isCurrentScope, organizationId, scopeKey]);

  const refreshTime = useCallback(async (from: string, to: string, signal?: AbortSignal) => {
    try {
      const [report, entries] = await Promise.all([
        fetchHrTime(from, to, organizationId ?? "", signal),
        fetchHrPendingEntries(organizationId ?? "", signal),
      ]);
      if (!signal?.aborted && isCurrentScope()) {
        setTimeReport(report);
        setPendingEntries(entries);
      }
    } catch (error) {
      if (!signal?.aborted && isCurrentScope()) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load time data." });
    }
  }, [isCurrentScope, organizationId, scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((enabled) => {
      if (enabled) void refreshTime(range.from, range.to, controller.signal);
    });
    return () => controller.abort();
  }, [load, range.from, range.to, refreshTime]);

  useEffect(() => {
    reportLoaded.current = false;
    setState({ status: "loading" });
    setTimeReport(null);
    setPendingEntries([]);
    setNotice(null);
  }, [organizationId]);

  useEffect(() => {
    if (tab !== "payroll") {
      setPayrollRecoveryAction(null);
      return;
    }
    let active = true;
    void readPendingHrPayrollAction({ actorId, organizationId }).then((action) => {
      if (!active || !isCurrentScope()) return;
      setPayrollRecoveryAction(action);
      if (action) setNotice({ tone: "pending", text: "A payroll action is unresolved. Retry its exact details to recover the result before starting another action." });
    }).catch((error) => {
      if (active && isCurrentScope()) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved payroll action." });
    });
    return () => { active = false; };
  }, [tab, actorId, organizationId, isCurrentScope]);

  useEffect(() => {
    if (tab !== "hiring") {
      setHiringRecoveryAction(null);
      return;
    }
    let active = true;
    void readPendingHrHiringAction({ actorId, organizationId }).then((action) => {
      if (!active || !isCurrentScope()) return;
      setHiringRecoveryAction(action);
      if (action) setNotice({ tone: "pending", text: "A Hiring action is unresolved. Retry its exact details before making another change." });
    }).catch((error) => {
      if (active && isCurrentScope()) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved Hiring action." });
    });
    return () => { active = false; };
  }, [tab, actorId, organizationId, isCurrentScope]);

  useEffect(() => {
    if (tab !== "people") {
      setEmployeeActionRecovery(null);
      return;
    }
    let active = true;
    void readPendingHrEmployeeAction({ actorId, organizationId }).then((action) => {
      if (!active || !isCurrentScope()) return;
      setEmployeeActionRecovery(action);
      if (action) setNotice({ tone: "pending", text: "An employee action is unresolved. Retry the exact details to recover its result before changing another employee record." });
    }).catch((error) => {
      if (active && isCurrentScope()) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved employee action." });
    });
    return () => { active = false; };
  }, [tab, actorId, organizationId, isCurrentScope]);

  useEffect(() => {
    if (tab !== "leave") {
      setLeaveRecoveryAction(null);
      return;
    }
    let active = true;
    void readPendingHrLeaveAction({ actorId, organizationId }).then((action) => {
      if (!active || !isCurrentScope()) return;
      setLeaveRecoveryAction(action);
      if (action) setNotice({ tone: "pending", text: "A leave action is unresolved. Retry the exact action to recover its result before making another change." });
    }).catch((error) => {
      if (active && isCurrentScope()) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved leave action." });
    });
    return () => { active = false; };
  }, [tab, actorId, organizationId, isCurrentScope]);

  useEffect(() => {
    let active = true;
    void readPendingHrTimeAction({ actorId, organizationId }).then((action) => {
      if (!active || !isCurrentScope()) return;
      setTimeRecoveryAction(action);
      if (action) setNotice({ tone: "pending", text: "A time action is unresolved. Retry the exact action to recover its result before making another change." });
    }).catch((error) => {
      if (active && isCurrentScope()) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved time action." });
    });
    return () => { active = false; };
  }, [actorId, organizationId, isCurrentScope]);

  const report = state.status === "ready" ? state.report : null;
  const employees = report?.employees ?? [];
  const activeEmployees = useMemo(() => employees.filter((employee) => employee.active), [employees]);
  const timeRows = timeReport?.rows ?? [];
  const activeOpening = (openings: HrOpening[]) => openings.find((opening) => opening.id === applicantForm.openingId) ?? openings.find((opening) => opening.status === "open");

  function changeTab(nextTab: TabId): void {
    setTab(nextTab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function refreshAll(): Promise<void> {
    const expectedScope = scopeKey;
    if (await load() && isCurrentScope() && expectedScope === scopeKey) await refreshTime(range.from, range.to);
  }

  async function runLeaveAction(action: HrLeaveAction, label: string, after: () => void = () => undefined): Promise<void> {
    if (busy || (leaveRecoveryAction && leaveRecoveryAction !== action)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrLeaveAction(action, { actorId, organizationId });
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        setLeaveRecoveryAction(action);
        setNotice({ tone: "pending", text: `${label} needs approval or result recovery. Retry the exact action after approval is complete.` });
      } else {
        setLeaveRecoveryAction(null);
        setNotice({ tone: "success", text: `${label} completed.` });
        after();
        await refreshAll();
      }
    } catch (error) {
      if (!isCurrentScope()) return;
      let pendingAction: HrLeaveAction | null;
      try { pendingAction = await readPendingHrLeaveAction({ actorId, organizationId }); }
      catch { pendingAction = action; }
      if (!isCurrentScope()) return;
      setLeaveRecoveryAction(pendingAction);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      if (isCurrentScope()) setBusy(false);
    }
  }

  async function runEmployeeAction(action: HrEmployeeAction, exactRecovery = false): Promise<void> {
    if (busy || (employeeActionRecovery && !exactRecovery)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrEmployeeAction(action, { actorId, organizationId });
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        setEmployeeActionRecovery(action);
        const actionLabel = action.action === "hireEmployee" ? "Employee hire" : action.action === "deactivateEmployee" ? "Employee deactivation" : "Employee profile update";
        setNotice({ tone: "pending", text: `${actionLabel} is waiting for approval or result recovery. Retry the exact details when ready.` });
      } else {
        setEmployeeActionRecovery(null);
        if (action.action === "hireEmployee") {
          setHire({ name: "", email: "", title: "", salary: "" });
          setNotice({ tone: "success", text: "Employee hire completed." });
        } else if (action.action === "deactivateEmployee" && result.data.deactivated === true) {
          setNotice({ tone: "success", text: "Employee deactivated." });
        } else if (action.action === "updateStructure" && result.data.updated === true) {
          setNotice({ tone: "success", text: "Employee profile updated." });
        } else {
          setNotice({ tone: "error", text: "The employee change could not be confirmed. Refresh the directory and check the record." });
        }
        await refreshAll();
      }
    } catch (error) {
      if (!isCurrentScope()) return;
      let pendingAction: HrEmployeeAction | null;
      try { pendingAction = await readPendingHrEmployeeAction({ actorId, organizationId }); }
      catch { pendingAction = action; }
      if (!isCurrentScope()) return;
      setEmployeeActionRecovery(pendingAction);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Employee action failed." });
    } finally {
      if (isCurrentScope()) setBusy(false);
    }
  }

  async function runPayrollAction(action: HrPayrollAction, exactRecovery = false): Promise<void> {
    if (busy || (payrollRecoveryAction && !exactRecovery)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrPayrollAction(action, { actorId, organizationId });
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        setPayrollRecoveryAction(action);
        setNotice({ tone: "pending", text: "Payroll action is waiting for approval or result recovery. Retry the exact action when ready." });
      } else {
        setPayrollRecoveryAction(null);
        const completedText = action.action === "createPayrollRun" ? "Payroll draft completed."
          : action.action === "executePayrollRun" ? "Payroll run executed and posted."
            : action.action === "voidPayrollRun" ? "Payroll draft voided."
              : "Payroll posting reversed.";
        setNotice({ tone: "success", text: completedText });
        await refreshAll();
      }
    } catch (error) {
      if (!isCurrentScope()) return;
      let pendingAction: HrPayrollAction | null;
      try { pendingAction = await readPendingHrPayrollAction({ actorId, organizationId }); }
      catch { pendingAction = action; }
      if (!isCurrentScope()) return;
      setPayrollRecoveryAction(pendingAction);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Payroll action failed." });
    } finally {
      if (isCurrentScope()) setBusy(false);
    }
  }

  async function runHiringAction(action: HrHiringAction, label: string, exactRecovery = false): Promise<void> {
    if (busy || (hiringRecoveryAction && !exactRecovery)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrHiringAction(action, { actorId, organizationId });
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        setHiringRecoveryAction(action);
        setNotice({ tone: "pending", text: `${label} is waiting for approval or result recovery. Retry the exact action when ready.` });
      } else {
        setHiringRecoveryAction(null);
        const completedLabel = exactRecovery
          ? action.action === "createOpening" ? "Opening creation" : action.action === "closeOpening" ? "Opening closure" : action.action === "addApplicant" ? "Applicant creation" : action.action === "hireApplicant" ? "Applicant hiring" : "Applicant stage update"
          : label;
        setNotice({ tone: "success", text: `${completedLabel} completed.` });
        if (action.action === "createOpening") {
          setOpeningTitle("");
          setOpeningDepartment("");
          setOpeningNote("");
        }
        if (action.action === "addApplicant") setApplicantForm((current) => ({ ...current, name: "", email: "" }));
        await refreshAll();
      }
    } catch (error) {
      if (!isCurrentScope()) return;
      let pendingAction: HrHiringAction | null;
      try { pendingAction = await readPendingHrHiringAction({ actorId, organizationId }); }
      catch { pendingAction = action; }
      if (!isCurrentScope()) return;
      setHiringRecoveryAction(pendingAction);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      if (isCurrentScope()) setBusy(false);
    }
  }

  function payrollRecoveryControls() {
    if (tab !== "payroll") return null;
    return <>
      {notice && <p className={`hr-notice hr-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {payrollRecoveryAction && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runPayrollAction(payrollRecoveryAction, true)}>Retry exact payroll action</button></div>}
    </>;
  }

  function hiringRecoveryControls() {
    if (tab !== "hiring") return null;
    return <>
      {notice && <p className={`hr-notice hr-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {hiringRecoveryAction && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runHiringAction(hiringRecoveryAction, "Hiring action", true)}>Retry exact Hiring action</button></div>}
    </>;
  }

  function employeeHireRecoveryControls() {
    if (tab !== "people") return null;
    return <>
      {notice && <p className={`hr-notice hr-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {employeeActionRecovery && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runEmployeeAction(employeeActionRecovery, true)}>{employeeActionRecovery.action === "hireEmployee" ? "Retry exact employee hire" : employeeActionRecovery.action === "deactivateEmployee" ? "Retry exact employee deactivation" : "Retry exact employee profile update"}</button></div>}
    </>;
  }

  async function submitTimeAction(action: HrTimeAction, label: string, after?: () => void, exactRecovery = false): Promise<void> {
    if (busy || (timeRecoveryAction && !exactRecovery && timeRecoveryAction !== action)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrTimeAction(action, { actorId, organizationId });
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        setTimeRecoveryAction(action);
        setNotice({ tone: "pending", text: `${label} needs approval or result recovery. Retry the exact action after approval is complete.` });
      } else {
        setTimeRecoveryAction(null);
        setNotice({ tone: "success", text: `${label} completed.` });
        if (after) after();
        else if (action.action === "log") setTimeEntry({ ...timeEntry, hours: "", note: "" });
        await refreshAll();
      }
    } catch (error) {
      if (!isCurrentScope()) return;
      let pendingAction: HrTimeAction | null;
      try { pendingAction = await readPendingHrTimeAction({ actorId, organizationId }); }
      catch { pendingAction = action; }
      if (!isCurrentScope()) return;
      setTimeRecoveryAction(pendingAction);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      if (isCurrentScope()) setBusy(false);
    }
  }

  if (state.status === "loading") {
    return <main className="hr-page"><PageLoading label="Loading People workspace…" />{payrollRecoveryControls()}{hiringRecoveryControls()}{employeeHireRecoveryControls()}</main>;
  }
  if (state.status === "failed") {
    return (
      <main className="hr-page">
        <section className="hr-error" role="alert" aria-labelledby="hr-error-title">
          <div><p className="hr-eyebrow">People workspace</p><h1 id="hr-error-title">Could not load employee data</h1><p>{state.message}</p></div>
          <div className="hr-actions">{state.statusCode === 401 && <a href="/login">Sign in again</a>}<button type="button" onClick={() => void load()}>Try again</button></div>
        </section>
        {payrollRecoveryControls()}
        {hiringRecoveryControls()}
        {employeeHireRecoveryControls()}
      </main>
    );
  }
  if (state.status === "disabled") {
    return <main className="hr-page"><section className="hr-empty" role="status"><p className="hr-eyebrow">People workspace</p><h1>People is turned off</h1><p>Ask a workspace administrator to enable the People module.</p></section></main>;
  }

  const { report: data } = state;
  const openings = data.openings;
  const selectedOpening = activeOpening(openings);

  return (
    <main className="hr-page">
      <header className="hr-header">
        <div>
          <p className="hr-eyebrow">People operations</p>
          <h1>People</h1>
          <p>Keep employee records, leave, time, hiring, and payroll work moving in one place.</p>
        </div>
      </header>

      <nav className="hr-tabs" aria-label="People workspace sections" role="tablist">
        {tabs.map((item, index) => <button
          key={item.id}
          id={`hr-tab-${item.id}`}
          type="button"
          role="tab"
          tabIndex={tab === item.id ? 0 : -1}
          aria-selected={tab === item.id}
          aria-controls="hr-tab-panel"
          onClick={() => changeTab(item.id)}
          onKeyDown={(event) => {
            const nextIndex = event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : null;
            if (nextIndex === null) return;
            event.preventDefault();
            const nextTab = tabs[nextIndex]!;
            changeTab(nextTab.id);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#hr-tab-${nextTab.id}`)?.focus();
          }}
        >{item.label}</button>)}
      </nav>

      {notice && <p className={`hr-notice hr-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {tab === "leave" && leaveRecoveryAction && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runLeaveAction(leaveRecoveryAction, "Leave action")}>Retry exact leave action</button></div>}
      {tab === "hiring" && hiringRecoveryAction && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runHiringAction(hiringRecoveryAction, "Hiring action", true)}>Retry exact Hiring action</button></div>}
      {tab === "people" && employeeActionRecovery && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runEmployeeAction(employeeActionRecovery, true)}>{employeeActionRecovery.action === "hireEmployee" ? "Retry exact employee hire" : employeeActionRecovery.action === "deactivateEmployee" ? "Retry exact employee deactivation" : "Retry exact employee profile update"}</button></div>}
      {tab === "payroll" && payrollRecoveryAction && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void runPayrollAction(payrollRecoveryAction, true)}>Retry exact payroll action</button></div>}
      {timeRecoveryAction && <div className="hr-actions"><button type="button" disabled={busy} onClick={() => void submitTimeAction(timeRecoveryAction, "Time action", undefined, true)}>Retry exact time action</button></div>}
      <section id="hr-tab-panel" className="hr-content" role="tabpanel" aria-labelledby={`hr-tab-${tab}`}>
        {tab === "overview" && <Overview report={data} timeRows={timeRows} currency={currency} onTabChange={changeTab} />}
        {tab === "people" && <People employees={data.employees} currency={currency} hire={hire} setHire={setHire} busy={busy || Boolean(employeeActionRecovery)} onDeactivate={(employee) => void runEmployeeAction({ action: "deactivateEmployee", employeeId: employee.id })} onUpdateStructure={(employee, department, position) => {
          const action: Extract<HrEmployeeAction, { action: "updateStructure" }> = { action: "updateStructure", employeeId: employee.id };
          if (department !== employee.department) action.department = department;
          if (position !== employee.title) action.position = position;
          if (action.department === undefined && action.position === undefined) return;
          void runEmployeeAction(action);
        }} onHire={() => {
          if (!currency) return;
          const salaryMinor = Math.round(Number(hire.salary) * (10 ** (currencyMinorUnits(currency) ?? 2)));
          if (!hire.name.trim() || !Number.isSafeInteger(salaryMinor) || salaryMinor <= 0) return;
          void runEmployeeAction({ action: "hireEmployee", name: hire.name.trim(), email: hire.email.trim() || undefined, title: hire.title.trim() || undefined, monthlySalaryMinor: salaryMinor });
        }} />}
        {tab === "hiring" && <Hiring openings={openings} applicants={data.applicants} currency={currency} busy={busy || Boolean(hiringRecoveryAction)} openingTitle={openingTitle} setOpeningTitle={setOpeningTitle} openingDepartment={openingDepartment} setOpeningDepartment={setOpeningDepartment} openingNote={openingNote} setOpeningNote={setOpeningNote} applicantForm={applicantForm} setApplicantForm={setApplicantForm} onCreateOpening={() => {
          if (!openingTitle.trim()) return;
          void runHiringAction({ action: "createOpening", title: openingTitle.trim(), department: openingDepartment.trim() || undefined, note: openingNote.trim() || undefined }, "Opening creation");
        }} onCloseOpening={(opening) => {
          void runHiringAction({ action: "closeOpening", openingId: opening.id }, "Opening closure");
        }} onAddApplicant={() => {
          if (!selectedOpening || !applicantForm.name.trim()) return;
          void runHiringAction({ action: "addApplicant", openingId: selectedOpening.id, name: applicantForm.name.trim(), email: applicantForm.email.trim() || undefined }, "Applicant creation");
        }} onMove={(applicant, stage) => void runHiringAction({ action: "moveApplicant", applicantId: applicant.id, stage: stage as "applied" | "screening" | "interview" | "offer" | "rejected" }, "Applicant stage update")} onHire={(applicant, monthlySalary) => {
          const minorUnits = currency ? currencyMinorUnits(currency) ?? 2 : 2;
          const monthlySalaryMinor = Math.round(Number(monthlySalary) * (10 ** minorUnits));
          if (!Number.isSafeInteger(monthlySalaryMinor) || monthlySalaryMinor <= 0) return;
          void runHiringAction({ action: "hireApplicant", applicantId: applicant.id, monthlySalaryMinor }, "Applicant hiring");
        }} />}
        {tab === "leave" && <Leave employees={activeEmployees} rows={data.leave} form={leaveRequest} setForm={setLeaveRequest} busy={busy || Boolean(leaveRecoveryAction)} onRequest={() => {
          if (!leaveRequest.employeeId || !leaveRequest.startDate || !leaveRequest.endDate || leaveRequest.endDate < leaveRequest.startDate) return;
          void runLeaveAction({ action: "requestLeave", ...leaveRequest }, "Leave request", () => setLeaveRequest({ ...leaveRequest, startDate: "", endDate: "" }));
        }} onDecision={(requestId, approve) => void runLeaveAction({ action: "decideLeave", requestId, approve }, approve ? "Leave approval" : "Leave rejection")} onCancel={(requestId) => void runLeaveAction({ action: "cancelLeave", requestId }, "Leave cancellation")} />}
        {tab === "time" && <Time employees={activeEmployees} attendance={data.attendance} rows={timeRows} pending={pendingEntries} range={range} setRange={setRange} form={timeEntry} setForm={setTimeEntry} busy={busy || Boolean(timeRecoveryAction)} onClock={(employeeId, action) => void submitTimeAction({ action, employeeId }, action === "clockIn" ? "Clock in" : "Clock out")} onLog={() => {
          const hours = Number(timeEntry.hours);
          const minutes = Math.round(hours * 60);
          if (!timeEntry.employeeId || !timeEntry.workDate || !Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(minutes)) return;
          void submitTimeAction({ action: "log", employeeId: timeEntry.employeeId, workDate: timeEntry.workDate, minutes, note: timeEntry.note.trim() || undefined }, "Time entry", () => setTimeEntry({ ...timeEntry, hours: "", note: "" }));
        }} onDecision={(entryId, decision) => void submitTimeAction({ action: "decide", entryId, decision }, "Time entry review")} />}
        {tab === "payroll" && <Payroll runs={data.runs} employees={activeEmployees} currency={currency} period={payrollPeriod} setPeriod={setPayrollPeriod} busy={busy || Boolean(payrollRecoveryAction)} onAction={(action) => void runPayrollAction(action)} onCreate={() => {
          const [year, month] = payrollPeriod.split("-").map(Number);
          if (!year || !month) return;
          void runPayrollAction({ action: "createPayrollRun", year, month });
        }} />}
        {tab === "expenses" && <ExpensesTab currency={currency} actorId={actorId} organizationId={organizationId} />}
      </section>
    </main>
  );
}

function ExpensesTab({ currency, actorId, organizationId }: { currency: string | null; actorId: string | null; organizationId: string | null }) {
  const scopeKey = JSON.stringify([actorId, organizationId]);
  const activeScopeRef = useRef<string | null>(scopeKey);
  const isCurrentScope = useCallback(() => activeScopeRef.current === scopeKey, [scopeKey]);
  const [claims, setClaims] = useState<ExpenseClaim[] | null>(null);
  const [policies, setPolicies] = useState<ExpensePolicy[]>([]);
  const [error, setError] = useState<ExpensesApiError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<ExpenseAction | null>(null);
  const [form, setForm] = useState({ amount: "", memo: "", accountCode: "" });
  const [policyForm, setPolicyForm] = useState({ category: "", limit: "" });
  const retryScope = useMemo(() => ({ actorId, organizationId }), [actorId, organizationId]);

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    return () => { activeScopeRef.current = null; };
  }, [scopeKey]);

  const loadClaims = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const data = await fetchExpenses(organizationId ?? "", signal);
      if (signal?.aborted || !isCurrentScope()) return false;
      setClaims(data.claims);
      setPolicies(data.policies);
      setError(null);
      return true;
    } catch (reason) {
      if (signal?.aborted || !isCurrentScope()) return false;
      setError(reason instanceof ExpensesApiError ? reason : new ExpensesApiError(0, "Could not load expense claims."));
      return false;
    }
  }, [isCurrentScope, organizationId, scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadClaims(controller.signal);
    return () => controller.abort();
  }, [loadClaims]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    void readPendingExpenseAction(retryScope).then((action) => {
      if (!isCurrentScope()) return;
      if (action) {
        setRecoveryAction(action);
        setNotice({ tone: "pending", text: "An earlier expense action is unresolved. Retry its exact action to recover the saved result." });
      }
    }).catch((reason: unknown) => {
      if (!isCurrentScope()) return;
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : "Could not check for an unresolved expense action." });
    });
  }, [actorId, isCurrentScope, organizationId, retryScope]);

  async function post(action: ExpenseAction, label: string, isRecovery = false): Promise<boolean> {
    if (busy || recoveryAction && !isRecovery) return false;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitExpenseAction(action, undefined, retryScope);
      if (!isCurrentScope()) return false;
      if (result.kind === "pending") {
        setRecoveryAction(action);
        setNotice({ tone: "pending", text: `${label} is above the payment threshold and is in the Approvals inbox. ${result.reason}` });
        return false;
      }
      setRecoveryAction(null);
      setNotice({ tone: "success", text: `${label} done.` });
      await loadClaims();
      if (!isCurrentScope()) return false;
      return true;
    } catch (reason) {
      if (!isCurrentScope()) return false;
      if (actorId && organizationId) {
        let pendingAction: ExpenseAction | null;
        try { pendingAction = await readPendingExpenseAction(retryScope); }
        catch { pendingAction = action; }
        if (!isCurrentScope()) return false;
        setRecoveryAction(pendingAction);
      }
      if (!isCurrentScope()) return false;
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : `${label} failed.` });
      return false;
    } finally {
      if (isCurrentScope()) setBusy(false);
    }
  }

  async function submitClaim(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const amountMinor = expenseAmountMinor(form.amount, currency);
    const memo = form.memo.trim();
    if (memo.length < 3 || memo.length > 500 || amountMinor === null || amountMinor <= 0) {
      setNotice({ tone: "error", text: "Enter a valid amount and an explanation between 3 and 500 characters." });
      return;
    }
    if (await post({ action: "submit", amountMinor, memo, accountCode: form.accountCode.trim() || undefined }, "Expense claim")) {
      setForm({ amount: "", memo: "", accountCode: "" });
    }
  }

  async function setPolicy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const category = policyForm.category.trim();
    const limitMinor = expenseAmountMinor(policyForm.limit, currency);
    if (category.length < 2 || category.length > 40 || !policyForm.limit || limitMinor === null || limitMinor < 0) {
      setNotice({ tone: "error", text: "Enter a category between 2 and 40 characters and a valid non-negative scrutiny limit." });
      return;
    }
    if (await post({ action: "setPolicy", category, limitMinor }, `Set ${category} limit`)) {
      setPolicyForm({ category: "", limit: "" });
    }
  }

  async function decide(claim: ExpenseClaim, decision: "approved" | "rejected"): Promise<void> {
    await post({ action: "decide", claimId: claim.id, decision }, decision === "approved" ? "Approve claim" : "Reject claim");
  }

  async function pay(claim: ExpenseClaim): Promise<void> {
    await post({ action: "pay", claimId: claim.id, amountMinor: claim.amountMinor }, "Reimbursement");
  }

  const pendingCount = claims?.filter((claim) => claim.status === "submitted").length ?? 0;
  const approvedCount = claims?.filter((claim) => claim.status === "approved").length ?? 0;
  const displayCurrency = currency ?? "USD";
  const displayMinorUnits = currencyMinorUnits(displayCurrency) ?? 2;

  return <div className="hr-content hr-expenses">
    {notice && <p className={`hr-notice hr-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}{notice.tone === "pending" && <> <a href="/approvals">Open approvals</a></>}{recoveryAction && <button type="button" disabled={busy} onClick={() => void post(recoveryAction, "Expense action", true)}>Retry exact expense action</button>}</p>}
    <section className="hr-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Reimbursement</p><h2>Submit an expense claim</h2></div></div>
      <form className="hr-expense-form" onSubmit={(event) => void submitClaim(event)}>
        <label>Amount<input aria-label="Expense amount" inputMode="decimal" type="number" min={displayMinorUnits === 0 ? "1" : (1 / 10 ** displayMinorUnits).toString()} step={10 ** -displayMinorUnits} placeholder={displayMinorUnits === 0 ? "120" : `120.${"0".repeat(displayMinorUnits)}`} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label className="hr-expense-memo">What &amp; why<input aria-label="Expense explanation" minLength={3} maxLength={500} placeholder="Taxi to the client kickoff" value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} /></label>
        <label>Account <span className="hr-muted">(optional)</span><input aria-label="Expense account code" placeholder="6900" value={form.accountCode} onChange={(event) => setForm({ ...form, accountCode: event.target.value })} /></label>
        <button className="hr-primary-button" type="submit" disabled={busy || Boolean(recoveryAction) || !form.amount || !form.memo.trim()}>{busy ? "Working…" : "Submit claim"}</button>
      </form>
      <p className="hr-muted hr-expense-help">The spend category is suggested from your explanation. A claim waits for a decision before any money moves, and reimbursements above the policy threshold need a second approval.</p>
    </section>

    <section className="hr-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Controls</p><h2>Expense policy limits</h2></div><span className="hr-muted">{policies.length} cap{policies.length === 1 ? "" : "s"} set</span></div>
      <form className="hr-expense-form hr-expense-policy-form" onSubmit={(event) => void setPolicy(event)}>
        <label>Category<input aria-label="Policy category" minLength={2} maxLength={40} placeholder="e.g. travel" value={policyForm.category} onChange={(event) => setPolicyForm({ ...policyForm, category: event.target.value })} /></label>
        <label>Scrutiny limit<input aria-label="Policy scrutiny limit" inputMode="decimal" type="number" min="0" step={10 ** -displayMinorUnits} placeholder={displayMinorUnits === 0 ? "250" : `250.${"0".repeat(displayMinorUnits)}`} value={policyForm.limit} onChange={(event) => setPolicyForm({ ...policyForm, limit: event.target.value })} /></label>
        <button className="hr-primary-button" type="submit" disabled={busy || Boolean(recoveryAction) || !policyForm.category.trim() || !policyForm.limit}>{busy ? "Working…" : "Set limit"}</button>
      </form>
      {policies.length > 0 && <ul className="hr-expense-policies">{policies.map((policy) => <li key={policy.category}><span>{policy.category}</span><span>Over {formatMoney(policy.limitMinor, displayCurrency)} gets a harder look</span></li>)}</ul>}
      <p className="hr-muted hr-expense-help">Claims over a category&apos;s limit stay visible as signals until decided. The cap adds scrutiny, it does not block the claim.</p>
    </section>

    <section className="hr-card hr-table-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Review</p><h2>Claims</h2></div></div>
      {claims === null && !error ? <p className="hr-muted" role="status">Loading expense claims…</p>
        : error ? <div className="hr-error" role="alert"><div><h3>{error.status === 401 ? "Sign in again" : error.status === 403 ? "Access denied" : "Could not load expense claims"}</h3><p>{error.message}</p></div><div className="hr-error-actions">{error.status === 401 && <a href="/login">Sign in again</a>}<button type="button" onClick={() => void loadClaims()}>Try again</button></div></div>
          : (claims ?? []).length === 0 ? <div className="hr-empty"><h2>No expense claims yet</h2><p>Filed claims appear here with their decision and payment state.</p></div>
            : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Claim</th><th scope="col">Filed by</th><th scope="col" className="hr-expense-number">Amount</th><th scope="col">Status</th><th scope="col"><span className="hr-visually-hidden">Actions</span></th></tr></thead><tbody>
              {(claims ?? []).map((claim) => <tr key={claim.id}><th scope="row" className="hr-expense-claim">{claim.memo}</th><td title={claim.claimantUserId} className="hr-expense-claimant">{claim.claimantUserId.slice(0, 8)}</td><td className="hr-expense-number">{formatMoney(claim.amountMinor, claim.currency)}</td><td><span className={`hr-pill hr-expense-${claim.status}`}>{claim.status}</span></td><td><div className="hr-row-actions hr-expense-actions">
                {claim.status === "submitted" && <><button type="button" disabled={busy || Boolean(recoveryAction)} onClick={() => void decide(claim, "approved")}>Approve</button><button type="button" disabled={busy || Boolean(recoveryAction)} onClick={() => void decide(claim, "rejected")}>Reject</button></>}
                {claim.status === "approved" && <button type="button" disabled={busy || Boolean(recoveryAction)} onClick={() => void pay(claim)}>Pay {formatMoney(claim.amountMinor, claim.currency)}</button>}
              </div></td></tr>)}
            </tbody></table></div>}
      {claims && (pendingCount > 0 || approvedCount > 0) && <p className="hr-muted hr-expense-help">{pendingCount > 0 && `${pendingCount} awaiting decision. `}{approvedCount > 0 && `${approvedCount} approved and awaiting reimbursement.`}</p>}
    </section>
  </div>;
}

function expenseAmountMinor(value: string, currency: string | null): number | null {
  const normalized = value.trim();
  const units = currency ? currencyMinorUnits(currency) : null;
  if (units === null || normalized.length > 32) return null;
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(normalized);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  if (fraction.length > units) return null;
  const factor = 10n ** BigInt(units);
  const retained = fraction.padEnd(units, "0");
  const minor = BigInt(whole) * factor + BigInt(retained || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

function Overview({ report, timeRows, currency, onTabChange }: { report: HrReport; timeRows: HrTimeReport["rows"]; currency: string | null; onTabChange: (tab: TabId) => void }) {
  const openLeave = report.leave.filter((row) => row.status === "pending").length;
  const activeHiring = report.openings.filter((opening) => opening.status === "open").length;
  const totalApprovedMinutes = timeRows.reduce((sum, row) => sum + row.approvedMinutes, 0);
  return <>
    <section className="hr-metrics" aria-label="People summary">
      <Metric label="Active people" value={report.employees.filter((employee) => employee.active).length.toLocaleString()} detail={`${report.employees.length.toLocaleString()} employee records`} />
      <Metric label="Leave to review" value={openLeave.toLocaleString()} detail="Requests waiting for a decision" />
      <Metric label="Open roles" value={activeHiring.toLocaleString()} detail={`${report.applicants.length.toLocaleString()} applicants in the pipeline`} />
      <Metric label="Approved time" value={formatMinutes(totalApprovedMinutes)} detail="This month" />
    </section>
    <div className="hr-overview-grid">
      <section className="hr-card">
        <div className="hr-section-heading"><div><p className="hr-eyebrow">Team</p><h2>Recently added</h2></div><button className="hr-text-button" type="button" onClick={() => onTabChange("people")}>View people</button></div>
        {report.employees.length === 0 ? <div className="hr-empty-action"><p className="hr-muted">Add your first employee to start building the team.</p><button className="hr-primary-button" type="button" onClick={() => onTabChange("people")}>Add your first employee</button></div> : <ul className="hr-person-list">{report.employees.slice(0, 5).map((employee) => <li key={employee.id}><span className="hr-avatar" aria-hidden="true">{employee.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span><span className="hr-person-copy"><strong>{employee.name}</strong><small>{employee.title || employee.department || "Role not set"}</small></span><span className={`hr-pill ${employee.active ? "is-active" : "is-muted"}`}>{employee.active ? "Active" : "Inactive"}</span></li>)}</ul>}
      </section>
      <section className="hr-card">
        <div className="hr-section-heading"><div><p className="hr-eyebrow">Payroll</p><h2>Latest run</h2></div><button className="hr-text-button" type="button" onClick={() => onTabChange("payroll")}>View payroll</button></div>
        {report.runs[0] ? <div className="hr-payroll-highlight"><div><span>{new Date(Date.UTC(report.runs[0].year, report.runs[0].month - 1, 15)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</span><span className={`hr-pill ${report.runs[0].status === "executed" ? "is-active" : "is-muted"}`}>{report.runs[0].status}</span></div><strong>{currency ? formatMoney(report.runs[0].totalNetMinor, currency) : "Loading currency"}</strong><small>{report.runs[0].headcount} employees · net pay</small></div> : <p className="hr-muted">No payroll runs have been recorded yet.</p>}
      </section>
    </div>
  </>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="hr-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function People({ employees, currency, hire, setHire, busy, onHire, onDeactivate, onUpdateStructure }: { employees: HrEmployee[]; currency: string | null; hire: { name: string; email: string; title: string; salary: string }; setHire: (value: { name: string; email: string; title: string; salary: string }) => void; busy: boolean; onHire: () => void; onDeactivate: (employee: HrEmployee) => void; onUpdateStructure: (employee: HrEmployee, department: string, position: string) => void }) {
  const [deactivateTarget, setDeactivateTarget] = useState<HrEmployee | null>(null);
  const [editTarget, setEditTarget] = useState<HrEmployee | null>(null);
  const [structure, setStructure] = useState({ department: "", position: "" });
  const currencyReady = Boolean(currency);
  const minorUnits = currencyMinorUnits(currency ?? "USD") ?? 2;
  return <>
    <section className="hr-card hr-form-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Add to your team</p><h2>Hire an employee</h2></div><small>{currencyReady ? `Salary shown in ${currency}` : "Loading organization currency"}</small></div>
      <form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onHire(); }}>
        <label>Full name<input required disabled={busy} maxLength={120} value={hire.name} onChange={(event) => setHire({ ...hire, name: event.currentTarget.value })} autoComplete="name" /></label>
        <label>Email<input type="email" disabled={busy} maxLength={254} value={hire.email} onChange={(event) => setHire({ ...hire, email: event.currentTarget.value })} autoComplete="email" /></label>
        <label>Job title<input disabled={busy} maxLength={80} value={hire.title} onChange={(event) => setHire({ ...hire, title: event.currentTarget.value })} /></label>
        <label>Monthly salary ({currencyReady ? currency : "..."})<input required disabled={!currencyReady || busy} type="number" min={String(1 / (10 ** minorUnits))} step={String(1 / (10 ** minorUnits))} value={hire.salary} onChange={(event) => setHire({ ...hire, salary: event.currentTarget.value })} /></label>
        <button className="hr-primary-button" type="submit" disabled={busy || !currencyReady || !hire.name.trim() || !hire.salary}>Add employee</button>
      </form>
    </section>
    <section className="hr-card hr-table-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Directory</p><h2>People</h2></div><span className="hr-count">{employees.length} records</span></div>
      {employees.length === 0 ? <p className="hr-muted">No employee records yet.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Employee</th><th scope="col">Department</th><th scope="col">Monthly salary</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id}><th scope="row"><span className="hr-table-person">{employee.name}</span><small>{employee.title || "No title"}{employee.email ? ` · ${employee.email}` : ""}</small></th><td>{employee.department || "Not set"}</td><td>{currency ? formatMoney(employee.monthlySalaryMinor, currency) : "Loading currency"}</td><td><span className={`hr-pill ${employee.active ? "is-active" : "is-muted"}`}>{employee.active ? "Active" : "Inactive"}</span></td><td><div className="hr-row-actions"><button type="button" disabled={busy} onClick={() => { setEditTarget(employee); setStructure({ department: employee.department ?? "", position: employee.title ?? "" }); }}>Edit profile</button>{employee.active ? <button type="button" disabled={busy} onClick={() => setDeactivateTarget(employee)}>Deactivate</button> : <span className="hr-muted">Inactive</span>}</div></td></tr>)}</tbody></table></div>}
    </section>
    {editTarget && <div className="hr-confirm-backdrop"><section className="hr-card hr-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-edit-title"><p className="hr-eyebrow">Team structure</p><h2 id="hr-edit-title">Edit {editTarget.name}</h2><form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onUpdateStructure(editTarget, structure.department, structure.position); setEditTarget(null); }}><label>Department<input disabled={busy} maxLength={100} value={structure.department} onChange={(event) => setStructure({ ...structure, department: event.currentTarget.value })} /></label><label>Job title<input disabled={busy} maxLength={100} value={structure.position} onChange={(event) => setStructure({ ...structure, position: event.currentTarget.value })} /></label><div className="hr-actions"><button type="button" disabled={busy} onClick={() => setEditTarget(null)}>Cancel</button><button className="hr-primary-button" type="submit" disabled={busy || (structure.department === (editTarget.department ?? "") && structure.position === (editTarget.title ?? ""))}>Save profile</button></div></form></section></div>}
    {deactivateTarget && <div className="hr-confirm-backdrop"><section className="hr-card hr-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-deactivate-title"><p className="hr-eyebrow">Confirm employee change</p><h2 id="hr-deactivate-title">Deactivate {deactivateTarget.name}?</h2><p>This removes the employee from active team work and excludes them from future payroll runs. Their historical records remain available.</p><div className="hr-actions"><button type="button" onClick={() => setDeactivateTarget(null)}>Cancel</button><button type="button" className="hr-primary-button" disabled={busy} onClick={() => { onDeactivate(deactivateTarget); setDeactivateTarget(null); }}>Confirm deactivation</button></div></section></div>}
  </>;
}

function Hiring({ openings, applicants, currency, busy, openingTitle, setOpeningTitle, openingDepartment, setOpeningDepartment, openingNote, setOpeningNote, applicantForm, setApplicantForm, onCreateOpening, onCloseOpening, onAddApplicant, onMove, onHire }: { openings: HrOpening[]; applicants: HrApplicant[]; currency: string | null; busy: boolean; openingTitle: string; setOpeningTitle: (value: string) => void; openingDepartment: string; setOpeningDepartment: (value: string) => void; openingNote: string; setOpeningNote: (value: string) => void; applicantForm: { openingId: string; name: string; email: string }; setApplicantForm: (value: { openingId: string; name: string; email: string }) => void; onCreateOpening: () => void; onCloseOpening: (opening: HrOpening) => void; onAddApplicant: () => void; onMove: (applicant: HrApplicant, stage: string) => void; onHire: (applicant: HrApplicant, monthlySalary: string) => void }) {
  const [monthlySalaries, setMonthlySalaries] = useState<Record<string, string>>({});
  const salaryStep = String(1 / (10 ** (currency ? currencyMinorUnits(currency) ?? 2 : 2)));
  const selectableOpenings = openings.filter((opening) => opening.status === "open");
  const openingId = applicantForm.openingId || selectableOpenings[0]?.id || "";
  const pipeline = applicants.filter((applicant) => applicant.openingId === openingId);
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Recruitment</p><h2>Open roles</h2></div><span className="hr-count">{selectableOpenings.length} open</span></div>
      <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); onCreateOpening(); }}><label className="hr-grow">Role title<input required disabled={busy} maxLength={120} value={openingTitle} onChange={(event) => setOpeningTitle(event.currentTarget.value)} placeholder="For example, Operations associate" /></label><label>Department<input disabled={busy} maxLength={100} value={openingDepartment} onChange={(event) => setOpeningDepartment(event.currentTarget.value)} /></label><label>Role notes<input disabled={busy} maxLength={500} value={openingNote} onChange={(event) => setOpeningNote(event.currentTarget.value)} /></label><button className="hr-primary-button" disabled={busy || !openingTitle.trim()}>Create opening</button></form>
      {openings.length === 0 ? <p className="hr-muted">No roles yet. Create an opening to start a pipeline.</p> : <ul className="hr-opening-list">{openings.map((opening) => <li key={opening.id}><span><strong>{opening.title}</strong><small>{opening.department || "General"}</small>{opening.note && <small>{opening.note}</small>}</span><span className={`hr-pill ${opening.status === "open" ? "is-active" : "is-muted"}`}>{opening.status}</span>{opening.status === "open" && <button type="button" disabled={busy} onClick={() => onCloseOpening(opening)}>Close {opening.title}</button>}</li>)}</ul>}
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Candidate pipeline</p><h2>Applicants</h2></div>{selectableOpenings.length > 0 && <label className="hr-select-label">Opening<select disabled={busy} value={openingId} onChange={(event) => setApplicantForm({ ...applicantForm, openingId: event.currentTarget.value })}>{selectableOpenings.map((opening) => <option value={opening.id} key={opening.id}>{opening.title}</option>)}</select></label>}</div>
      {selectableOpenings.length > 0 && <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); onAddApplicant(); }}><label className="hr-grow">Candidate name<input required disabled={busy} maxLength={120} value={applicantForm.name} onChange={(event) => setApplicantForm({ ...applicantForm, name: event.currentTarget.value })} /></label><label>Email<input type="email" disabled={busy} maxLength={254} value={applicantForm.email} onChange={(event) => setApplicantForm({ ...applicantForm, email: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !applicantForm.name.trim()}>Add applicant</button></form>}
      {pipeline.length === 0 ? <p className="hr-muted">No applicants are listed for this opening yet.</p> : <div className="hr-applicant-list">{pipeline.map((applicant) => <article className="hr-applicant" key={applicant.id}><span><strong>{applicant.name}</strong><small>{applicant.note || "No notes"}</small></span>{applicant.stage === "hired" ? <span className="hr-pill is-muted">hired</span> : <label>Stage<select disabled={busy} value={applicant.stage} onChange={(event) => onMove(applicant, event.currentTarget.value)}><option value={applicant.stage}>{applicant.stage}</option>{["applied", "screening", "interview", "offer", "rejected"].filter((stage) => stage !== applicant.stage).map((stage) => <option value={stage} key={stage}>{stage}</option>)}</select></label>}{applicant.stage === "offer" && <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); onHire(applicant, monthlySalaries[applicant.id] ?? ""); }}><label>Monthly salary for {applicant.name} ({currency ?? "currency"})<input required disabled={busy} type="number" min={salaryStep} step={salaryStep} value={monthlySalaries[applicant.id] ?? ""} onChange={(event) => setMonthlySalaries({ ...monthlySalaries, [applicant.id]: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !(Number(monthlySalaries[applicant.id]) > 0)}>Hire {applicant.name}</button></form>}</article>)}</div>}
    </section>
  </>;
}

function Leave({ employees, rows, form, setForm, busy, onRequest, onDecision, onCancel }: { employees: HrEmployee[]; rows: HrReport["leave"]; form: { employeeId: string; kind: string; startDate: string; endDate: string }; setForm: (value: { employeeId: string; kind: string; startDate: string; endDate: string }) => void; busy: boolean; onRequest: () => void; onDecision: (requestId: string, approve: boolean) => void; onCancel: (requestId: string) => void }) {
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Time away</p><h2>Request leave</h2></div></div>
      <form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onRequest(); }}><label>Employee<select required disabled={busy} value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label>Leave type<select disabled={busy} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.currentTarget.value })}>{["annual", "sick", "parental", "unpaid", "other"].map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label><label>Start date<input required disabled={busy} type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.currentTarget.value })} /></label><label>End date<input required disabled={busy} type="date" min={form.startDate || undefined} value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !form.employeeId || !form.startDate || !form.endDate || form.endDate < form.startDate}>Submit leave request</button></form>
    </section>
    <section className="hr-card hr-table-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Requests</p><h2>Leave activity</h2></div></div>
      {rows.length === 0 ? <p className="hr-muted">No leave requests have been recorded.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Employee</th><th scope="col">Dates</th><th scope="col">Type</th><th scope="col">Days</th><th scope="col">Status</th><th scope="col">Review</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><th scope="row">{row.employeeName}</th><td>{formatDate(row.startDate)} to {formatDate(row.endDate)}</td><td>{row.kind}</td><td>{row.calendarDays}</td><td><span className={`hr-pill ${row.status === "approved" ? "is-active" : "is-muted"}`}>{row.status}</span></td><td>{row.status === "pending" ? <div className="hr-row-actions"><button type="button" disabled={busy} onClick={() => onDecision(row.id, true)}>Approve</button><button type="button" disabled={busy} onClick={() => onDecision(row.id, false)}>Decline</button><button type="button" disabled={busy} onClick={() => onCancel(row.id)}>Cancel</button></div> : "-"}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function Time({ employees, attendance, rows, pending, range, setRange, form, setForm, busy, onClock, onLog, onDecision }: { employees: HrEmployee[]; attendance: HrReport["attendance"]; rows: HrTimeReport["rows"]; pending: HrPendingEntry[]; range: { from: string; to: string }; setRange: (value: { from: string; to: string }) => void; form: { employeeId: string; workDate: string; hours: string; note: string }; setForm: (value: { employeeId: string; workDate: string; hours: string; note: string }) => void; busy: boolean; onClock: (employeeId: string, action: "clockIn" | "clockOut") => void; onLog: () => void; onDecision: (entryId: string, decision: "approve" | "reject") => void }) {
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Attendance</p><h2>Current clock-ins</h2></div><span className="hr-count">{attendance.length} active</span></div>
      {employees.length === 0 ? <p className="hr-muted">Add an active employee before recording attendance.</p> : <div className="hr-applicant-list">{employees.map((employee) => {
        const openEntry = attendance.find((entry) => entry.employeeId === employee.id);
        return <article className="hr-applicant" key={employee.id}><span><strong>{employee.name}</strong><small>{openEntry ? `Clocked in ${formatDate(openEntry.clockedInAt)}${openEntry.late ? " · Late" : ""}` : "Not currently clocked in"}</small></span><div className="hr-row-actions"><button type="button" disabled={busy} onClick={() => onClock(employee.id, openEntry ? "clockOut" : "clockIn")}>{openEntry ? "Clock out" : "Clock in"}</button></div></article>;
      })}</div>}
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Time tracking</p><h2>Log hours</h2></div></div>
      <form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onLog(); }}><label>Employee<select required disabled={busy} value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })}><option value="">Select employee</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label><label>Work date<input required disabled={busy} type="date" value={form.workDate} onChange={(event) => setForm({ ...form, workDate: event.currentTarget.value })} /></label><label>Hours<input required disabled={busy} type="number" min="0.01" max="24" step="0.01" value={form.hours} onChange={(event) => setForm({ ...form, hours: event.currentTarget.value })} /></label><label>Note<input disabled={busy} maxLength={300} value={form.note} onChange={(event) => setForm({ ...form, note: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !form.employeeId || !form.hours}>Submit time</button></form>
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Time report</p><h2>Hours by employee</h2></div><span className="hr-count">Approved hours</span></div><div className="hr-range"><label>From<input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.currentTarget.value })} /></label><label>To<input type="date" min={range.from} value={range.to} onChange={(event) => setRange({ ...range, to: event.currentTarget.value })} /></label></div>
      {rows.length === 0 ? <p className="hr-muted">No time has been recorded for this date range.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Employee</th><th scope="col">Approved</th><th scope="col">Pending</th></tr></thead><tbody>{rows.map((row) => <tr key={row.employeeId}><th scope="row">{employeeFullName(employees, row.employeeId)}</th><td>{formatMinutes(row.approvedMinutes)}</td><td>{formatMinutes(row.pendingMinutes)}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Approvals</p><h2>Submitted time</h2></div><span className="hr-count">{pending.length} waiting</span></div>
      {pending.length === 0 ? <p className="hr-muted">No submitted entries need review.</p> : <div className="hr-applicant-list">{pending.map((entry) => <article className="hr-applicant" key={entry.id}><span><strong>{entry.employeeName}</strong><small>{formatDate(entry.workDate)} · {formatMinutes(entry.minutes)}{entry.note ? ` · ${entry.note}` : ""}</small></span><div className="hr-row-actions"><button type="button" disabled={busy} onClick={() => onDecision(entry.id, "approve")}>Approve</button><button type="button" disabled={busy} onClick={() => onDecision(entry.id, "reject")}>Reject</button></div></article>)}</div>}
    </section>
  </>;
}

function Payroll({ runs, employees, currency, period, setPeriod, busy, onCreate, onAction }: { runs: HrReport["runs"]; employees: HrEmployee[]; currency: string | null; period: string; setPeriod: (value: string) => void; busy: boolean; onCreate: () => void; onAction: (action: HrPayrollAction) => void }) {
  const [confirmation, setConfirmation] = useState<{ action: "executePayrollRun" | "voidPayrollRun" | "reversePayrollPosting"; run: HrPayrollRun } | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const periodAlreadyExists = runs.some((run) => `${run.year}-${String(run.month).padStart(2, "0")}` === period);
  const confirmationTitle = confirmation?.action === "executePayrollRun" ? "Execute payroll run"
    : confirmation?.action === "voidPayrollRun" ? "Void payroll draft" : "Reverse payroll posting";
  const confirm = () => {
    if (!confirmation) return;
    const { action, run } = confirmation;
    if (action === "executePayrollRun") onAction({ action, runId: run.id, expectedTotalNetMinor: run.totalNetMinor });
    if (action === "voidPayrollRun") onAction({ action, runId: run.id });
    if (action === "reversePayrollPosting") onAction({ action, runId: run.id, reason: reverseReason.trim() });
    setConfirmation(null);
    setReverseReason("");
  };
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Payroll</p><h2>Prepare a payroll run</h2></div><span className="hr-count">{employees.length} active people</span></div>
      <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); if (!periodAlreadyExists && employees.length > 0) onCreate(); }}><label>Payroll period<input required type="month" value={period} onChange={(event) => setPeriod(event.currentTarget.value)} /></label><button className="hr-primary-button" disabled={busy || !period || employees.length === 0 || periodAlreadyExists}>Create draft run</button></form>
      {employees.length === 0 && <p className="hr-muted">Add an active employee before creating a payroll run.</p>}
      {periodAlreadyExists && <p className="hr-muted" role="status">A payroll run already exists for this period.</p>}
    </section>
    <section className="hr-card hr-table-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">History</p><h2>Payroll runs</h2></div></div>
      {runs.length === 0 ? <p className="hr-muted">No payroll runs have been recorded.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Period</th><th scope="col">Employees</th><th scope="col">Gross</th><th scope="col">Tax</th><th scope="col">Net</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><th scope="row">{new Date(Date.UTC(run.year, run.month - 1, 15)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</th><td>{run.headcount}</td><td>{currency ? formatMoney(run.totalGrossMinor, currency) : "Loading currency"}</td><td>{currency ? formatMoney(run.totalTaxMinor, currency) : "Loading currency"}</td><td>{currency ? formatMoney(run.totalNetMinor, currency) : "Loading currency"}</td><td><span className={`hr-pill ${run.status === "executed" ? "is-active" : "is-muted"}`}>{run.status}</span></td><td><div className="hr-row-actions">{run.status === "draft" && <><button type="button" disabled={busy} onClick={() => setConfirmation({ action: "executePayrollRun", run })}>Execute</button><button type="button" disabled={busy} onClick={() => setConfirmation({ action: "voidPayrollRun", run })}>Void</button></>}{run.status === "executed" && <button type="button" disabled={busy} onClick={() => setConfirmation({ action: "reversePayrollPosting", run })}>Reverse posting</button>}{!(["draft", "executed"].includes(run.status)) && <span className="hr-muted">No actions</span>}</div></td></tr>)}</tbody></table></div>}
    </section>
    {confirmation && <div className="hr-confirm-backdrop"><section className="hr-card hr-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-payroll-confirm-title"><p className="hr-eyebrow">Confirm payroll change</p><h2 id="hr-payroll-confirm-title">{confirmationTitle}</h2>{confirmation.action === "executePayrollRun" && <p>This will post payroll with net pay of <strong>{currency ? formatMoney(confirmation.run.totalNetMinor, currency) : confirmation.run.totalNetMinor}</strong>. Confirm only after reviewing this run.</p>}{confirmation.action === "voidPayrollRun" && <p>This permanently voids this draft payroll run. It cannot be executed afterward.</p>}{confirmation.action === "reversePayrollPosting" && <><p>This creates a reversal entry for the executed payroll posting.</p><label>Reason<textarea required minLength={3} maxLength={500} value={reverseReason} onChange={(event) => setReverseReason(event.currentTarget.value)} /></label></>}<div className="hr-actions"><button type="button" onClick={() => { setConfirmation(null); setReverseReason(""); }}>Cancel</button><button type="button" className="hr-primary-button" disabled={busy || (confirmation.action === "reversePayrollPosting" && reverseReason.trim().length < 3)} onClick={confirm}>Confirm {confirmation.action === "executePayrollRun" ? "execution" : confirmation.action === "voidPayrollRun" ? "void" : "reversal"}</button></div></section></div>}
  </>;
}
