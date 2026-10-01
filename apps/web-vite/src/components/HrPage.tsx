import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { fetchExpenses, ExpensesApiError, submitExpenseAction, type ExpenseAction, type ExpenseClaim, type ExpensePolicy } from "../api/expenses";
import { fetchHrEnabled, fetchHrPendingEntries, fetchHrReport, fetchHrTime, HrApiError, submitHrAction, submitHrTimeAction, type HrApplicant, type HrEmployee, type HrOpening, type HrPendingEntry, type HrReport, type HrTimeReport } from "../api/hr";
import { legacyUrl } from "../legacy";
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

export function HrPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tab, setTab] = useState<TabId>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return tabs.find((item) => item.id === requested)?.id ?? "overview";
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState(monthRange);
  const [timeReport, setTimeReport] = useState<HrTimeReport | null>(null);
  const [pendingEntries, setPendingEntries] = useState<HrPendingEntry[]>([]);
  const [hire, setHire] = useState({ name: "", email: "", title: "", salary: "" });
  const [leaveRequest, setLeaveRequest] = useState({ employeeId: "", kind: "annual", startDate: "", endDate: "" });
  const [timeEntry, setTimeEntry] = useState({ employeeId: "", workDate: dateOnly(new Date()), hours: "", note: "" });
  const [openingTitle, setOpeningTitle] = useState("");
  const [applicantForm, setApplicantForm] = useState({ openingId: "", name: "", email: "" });
  const [payrollPeriod, setPayrollPeriod] = useState(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const currency = baseCurrency;

  const load = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    if (!signal) setState({ status: "loading" });
    try {
      const enabled = await fetchHrEnabled(signal);
      if (signal?.aborted) return false;
      if (!enabled) {
        setState({ status: "disabled" });
        return false;
      }
      const report = await fetchHrReport(signal);
      if (!signal?.aborted) setState({ status: "ready", report });
      return !signal?.aborted;
    } catch (error) {
      if (signal?.aborted) return false;
      const apiError = error instanceof HrApiError ? error : new HrApiError(0, "Could not load People workspace data.");
      setState({ status: "failed", message: apiError.message, statusCode: apiError.status });
      return false;
    }
  }, []);

  const refreshTime = useCallback(async (from: string, to: string, signal?: AbortSignal) => {
    try {
      const [report, entries] = await Promise.all([fetchHrTime(from, to, signal), fetchHrPendingEntries(signal)]);
      if (!signal?.aborted) {
        setTimeReport(report);
        setPendingEntries(entries);
      }
    } catch (error) {
      if (!signal?.aborted) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load time data." });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((enabled) => {
      if (enabled) void refreshTime(range.from, range.to, controller.signal);
    });
    return () => controller.abort();
  }, [load, range.from, range.to, refreshTime]);

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
    if (await load()) await refreshTime(range.from, range.to);
  }

  async function runAction(label: string, action: Parameters<typeof submitHrAction>[0], after: () => void = () => undefined): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrAction(action);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: `${label} needs human approval. Check the Approvals inbox.` });
      } else {
        setNotice({ tone: "success", text: `${label} completed.` });
        after();
        await refreshAll();
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      setBusy(false);
    }
  }

  async function submitTimeAction(action: Parameters<typeof submitHrTimeAction>[0], label: string, after?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitHrTimeAction(action);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: `${label} needs human approval. Check the Approvals inbox.` });
      } else {
        setNotice({ tone: "success", text: `${label} completed.` });
        after?.();
        await refreshAll();
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return <main className="hr-page"><p className="hr-loading" role="status">Loading People workspace…</p></main>;
  }
  if (state.status === "failed") {
    return (
      <main className="hr-page">
        <section className="hr-error" role="alert" aria-labelledby="hr-error-title">
          <div><p className="hr-eyebrow">People workspace</p><h1 id="hr-error-title">Could not load employee data</h1><p>{state.message}</p></div>
          <div className="hr-actions">{state.statusCode === 401 && <a href="/login">Sign in again</a>}<button type="button" onClick={() => void load()}>Try again</button></div>
        </section>
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
        <a className="hr-full-workspace" href={legacyUrl("/hr")}>Open full HR workspace <span aria-hidden="true">↗</span></a>
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
      <section id="hr-tab-panel" className="hr-content" role="tabpanel" aria-labelledby={`hr-tab-${tab}`}>
        {tab === "overview" && <Overview report={data} timeRows={timeRows} currency={currency} onTabChange={changeTab} />}
        {tab === "people" && <People employees={data.employees} currency={currency} hire={hire} setHire={setHire} busy={busy} onHire={() => {
          if (!currency) return;
          const salaryMinor = Math.round(Number(hire.salary) * (10 ** (currencyMinorUnits(currency) ?? 2)));
          if (!hire.name.trim() || !Number.isSafeInteger(salaryMinor) || salaryMinor <= 0) return;
          void runAction("Employee hire", { action: "hireEmployee", name: hire.name.trim(), email: hire.email.trim() || undefined, title: hire.title.trim() || undefined, monthlySalaryMinor: salaryMinor }, () => setHire({ name: "", email: "", title: "", salary: "" }));
        }} />}
        {tab === "hiring" && <Hiring openings={openings} applicants={data.applicants} busy={busy} openingTitle={openingTitle} setOpeningTitle={setOpeningTitle} applicantForm={applicantForm} setApplicantForm={setApplicantForm} onCreateOpening={() => {
          if (!openingTitle.trim()) return;
          void runAction("Opening creation", { action: "createOpening", title: openingTitle.trim() }, () => setOpeningTitle(""));
        }} onAddApplicant={() => {
          if (!selectedOpening || !applicantForm.name.trim()) return;
          void runAction("Applicant creation", { action: "addApplicant", openingId: selectedOpening.id, name: applicantForm.name.trim(), email: applicantForm.email.trim() || undefined }, () => setApplicantForm({ ...applicantForm, name: "", email: "" }));
        }} onMove={(applicant, stage) => void runAction("Applicant stage update", { action: "moveApplicant", applicantId: applicant.id, stage })} />}
        {tab === "leave" && <Leave employees={activeEmployees} rows={data.leave} form={leaveRequest} setForm={setLeaveRequest} busy={busy} onRequest={() => {
          if (!leaveRequest.employeeId || !leaveRequest.startDate || !leaveRequest.endDate || leaveRequest.endDate < leaveRequest.startDate) return;
          void runAction("Leave request", { action: "requestLeave", ...leaveRequest }, () => setLeaveRequest({ ...leaveRequest, startDate: "", endDate: "" }));
        }} onDecision={(requestId, approve) => void runAction(approve ? "Leave approval" : "Leave rejection", { action: "decideLeave", requestId, approve })} />}
        {tab === "time" && <Time employees={activeEmployees} rows={timeRows} pending={pendingEntries} range={range} setRange={setRange} form={timeEntry} setForm={setTimeEntry} busy={busy} onLog={() => {
          const hours = Number(timeEntry.hours);
          const minutes = Math.round(hours * 60);
          if (!timeEntry.employeeId || !timeEntry.workDate || !Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(minutes)) return;
          void submitTimeAction({ action: "log", employeeId: timeEntry.employeeId, workDate: timeEntry.workDate, minutes, note: timeEntry.note.trim() || undefined }, "Time entry", () => setTimeEntry({ ...timeEntry, hours: "", note: "" }));
        }} onDecision={(entryId, decision) => void submitTimeAction({ action: "decide", entryId, decision }, "Time entry review")} />}
        {tab === "payroll" && <Payroll runs={data.runs} employees={activeEmployees} currency={currency} period={payrollPeriod} setPeriod={setPayrollPeriod} busy={busy} onCreate={() => {
          const [year, month] = payrollPeriod.split("-").map(Number);
          if (!year || !month) return;
          void runAction("Payroll draft", { action: "createPayrollRun", year, month });
        }} />}
        {tab === "expenses" && <ExpensesTab currency={currency} />}
      </section>
    </main>
  );
}

function ExpensesTab({ currency }: { currency: string | null }) {
  const [claims, setClaims] = useState<ExpenseClaim[] | null>(null);
  const [policies, setPolicies] = useState<ExpensePolicy[]>([]);
  const [error, setError] = useState<ExpensesApiError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ amount: "", memo: "", accountCode: "" });
  const [policyForm, setPolicyForm] = useState({ category: "", limit: "" });

  const loadClaims = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const data = await fetchExpenses(signal);
      if (signal?.aborted) return false;
      setClaims(data.claims);
      setPolicies(data.policies);
      setError(null);
      return true;
    } catch (reason) {
      if (signal?.aborted) return false;
      setError(reason instanceof ExpensesApiError ? reason : new ExpensesApiError(0, "Could not load expense claims."));
      return false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadClaims(controller.signal);
    return () => controller.abort();
  }, [loadClaims]);

  async function post(action: ExpenseAction, label: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitExpenseAction(action);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: `${label} is above the payment threshold and is in the Approvals inbox. ${result.reason}` });
        return false;
      }
      setNotice({ tone: "success", text: `${label} done.` });
      await loadClaims();
      return true;
    } catch (reason) {
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : `${label} failed.` });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitClaim(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const amountMinor = Math.round(Number(form.amount || "0") * 100);
    const memo = form.memo.trim();
    if (!memo || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      setNotice({ tone: "error", text: "An amount and a short explanation of the expense are both required." });
      return;
    }
    if (await post({ action: "submit", amountMinor, memo, accountCode: form.accountCode.trim() || undefined }, "Expense claim")) {
      setForm({ amount: "", memo: "", accountCode: "" });
    }
  }

  async function setPolicy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const category = policyForm.category.trim();
    const limitMinor = Math.round(Number(policyForm.limit || "0") * 100);
    if (!category || !policyForm.limit || !Number.isSafeInteger(limitMinor) || limitMinor < 0) {
      setNotice({ tone: "error", text: "Enter a category and a valid non-negative scrutiny limit." });
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

  return <div className="hr-content hr-expenses">
    {notice && <p className={`hr-notice hr-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}{notice.tone === "pending" && <> <a href={legacyUrl("/approvals")}>Open approvals</a></>}</p>}
    <section className="hr-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Reimbursement</p><h2>Submit an expense claim</h2></div></div>
      <form className="hr-expense-form" onSubmit={(event) => void submitClaim(event)}>
        <label>Amount<input aria-label="Expense amount" inputMode="decimal" type="number" min="0.01" step="0.01" placeholder="120.00" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label className="hr-expense-memo">What &amp; why<input aria-label="Expense explanation" maxLength={500} placeholder="Taxi to the client kickoff" value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} /></label>
        <label>Account <span className="hr-muted">(optional)</span><input aria-label="Expense account code" placeholder="6900" value={form.accountCode} onChange={(event) => setForm({ ...form, accountCode: event.target.value })} /></label>
        <button className="hr-primary-button" type="submit" disabled={busy || !form.amount || !form.memo.trim()}>{busy ? "Working…" : "Submit claim"}</button>
      </form>
      <p className="hr-muted hr-expense-help">The spend category is suggested from your explanation. A claim waits for a decision before any money moves, and reimbursements above the policy threshold need a second approval.</p>
    </section>

    <section className="hr-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Controls</p><h2>Expense policy limits</h2></div><span className="hr-muted">{policies.length} cap{policies.length === 1 ? "" : "s"} set</span></div>
      <form className="hr-expense-form hr-expense-policy-form" onSubmit={(event) => void setPolicy(event)}>
        <label>Category<input aria-label="Policy category" maxLength={40} placeholder="e.g. travel" value={policyForm.category} onChange={(event) => setPolicyForm({ ...policyForm, category: event.target.value })} /></label>
        <label>Scrutiny limit<input aria-label="Policy scrutiny limit" inputMode="decimal" type="number" min="0" step="0.01" placeholder="250.00" value={policyForm.limit} onChange={(event) => setPolicyForm({ ...policyForm, limit: event.target.value })} /></label>
        <button className="hr-primary-button" type="submit" disabled={busy || !policyForm.category.trim() || !policyForm.limit}>{busy ? "Working…" : "Set limit"}</button>
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
              {(claims ?? []).map((claim) => <tr key={claim.id}><th scope="row" className="hr-expense-claim">{claim.memo}</th><td title={claim.claimantUserId} className="hr-expense-claimant">{claim.claimantUserId.slice(0, 8)}</td><td className="hr-expense-number">{formatMoney(claim.amountMinor, displayCurrency)}</td><td><span className={`hr-pill hr-expense-${claim.status}`}>{claim.status}</span></td><td><div className="hr-row-actions hr-expense-actions">
                {claim.status === "submitted" && <><button type="button" disabled={busy} onClick={() => void decide(claim, "approved")}>Approve</button><button type="button" disabled={busy} onClick={() => void decide(claim, "rejected")}>Reject</button></>}
                {claim.status === "approved" && <button type="button" disabled={busy} onClick={() => void pay(claim)}>Pay {formatMoney(claim.amountMinor, displayCurrency)}</button>}
              </div></td></tr>)}
            </tbody></table></div>}
      {claims && (pendingCount > 0 || approvedCount > 0) && <p className="hr-muted hr-expense-help">{pendingCount > 0 && `${pendingCount} awaiting decision. `}{approvedCount > 0 && `${approvedCount} approved and awaiting reimbursement.`}</p>}
    </section>
  </div>;
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
        {report.employees.length === 0 ? <p className="hr-muted">Add your first employee to start building the team.</p> : <ul className="hr-person-list">{report.employees.slice(0, 5).map((employee) => <li key={employee.id}><span className="hr-avatar" aria-hidden="true">{employee.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span><span className="hr-person-copy"><strong>{employee.name}</strong><small>{employee.title || employee.department || "Role not set"}</small></span><span className={`hr-pill ${employee.active ? "is-active" : "is-muted"}`}>{employee.active ? "Active" : "Inactive"}</span></li>)}</ul>}
      </section>
      <section className="hr-card">
        <div className="hr-section-heading"><div><p className="hr-eyebrow">Payroll</p><h2>Latest run</h2></div><button className="hr-text-button" type="button" onClick={() => onTabChange("payroll")}>View payroll</button></div>
        {report.runs[0] ? <div className="hr-payroll-highlight"><div><span>{new Date(Date.UTC(report.runs[0].year, report.runs[0].month - 1, 15)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</span><span className={`hr-pill ${report.runs[0].status === "posted" ? "is-active" : "is-muted"}`}>{report.runs[0].status}</span></div><strong>{currency ? formatMoney(report.runs[0].totalNetMinor, currency) : "Loading currency"}</strong><small>{report.runs[0].headcount} employees · net pay</small></div> : <p className="hr-muted">No payroll runs have been recorded yet.</p>}
      </section>
    </div>
  </>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="hr-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function People({ employees, currency, hire, setHire, busy, onHire }: { employees: HrEmployee[]; currency: string | null; hire: { name: string; email: string; title: string; salary: string }; setHire: (value: { name: string; email: string; title: string; salary: string }) => void; busy: boolean; onHire: () => void }) {
  const currencyReady = Boolean(currency);
  const minorUnits = currencyMinorUnits(currency ?? "USD") ?? 2;
  return <>
    <section className="hr-card hr-form-card">
      <div className="hr-section-heading"><div><p className="hr-eyebrow">Add to your team</p><h2>Hire an employee</h2></div><small>{currencyReady ? `Salary shown in ${currency}` : "Loading organization currency"}</small></div>
      <form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onHire(); }}>
        <label>Full name<input required maxLength={120} value={hire.name} onChange={(event) => setHire({ ...hire, name: event.currentTarget.value })} autoComplete="name" /></label>
        <label>Email<input type="email" maxLength={254} value={hire.email} onChange={(event) => setHire({ ...hire, email: event.currentTarget.value })} autoComplete="email" /></label>
        <label>Job title<input maxLength={120} value={hire.title} onChange={(event) => setHire({ ...hire, title: event.currentTarget.value })} /></label>
        <label>Monthly salary ({currencyReady ? currency : "..."})<input required disabled={!currencyReady} type="number" min={String(1 / (10 ** minorUnits))} step={String(1 / (10 ** minorUnits))} value={hire.salary} onChange={(event) => setHire({ ...hire, salary: event.currentTarget.value })} /></label>
        <button className="hr-primary-button" type="submit" disabled={busy || !currencyReady || !hire.name.trim() || !hire.salary}>Add employee</button>
      </form>
    </section>
    <section className="hr-card hr-table-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Directory</p><h2>People</h2></div><span className="hr-count">{employees.length} records</span></div>
      {employees.length === 0 ? <p className="hr-muted">No employee records yet.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Employee</th><th scope="col">Department</th><th scope="col">Monthly salary</th><th scope="col">Status</th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id}><th scope="row"><span className="hr-table-person">{employee.name}</span><small>{employee.email || employee.title || "No contact details"}</small></th><td>{employee.department || "Not set"}</td><td>{currency ? formatMoney(employee.monthlySalaryMinor, currency) : "Loading currency"}</td><td><span className={`hr-pill ${employee.active ? "is-active" : "is-muted"}`}>{employee.active ? "Active" : "Inactive"}</span></td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function Hiring({ openings, applicants, busy, openingTitle, setOpeningTitle, applicantForm, setApplicantForm, onCreateOpening, onAddApplicant, onMove }: { openings: HrOpening[]; applicants: HrApplicant[]; busy: boolean; openingTitle: string; setOpeningTitle: (value: string) => void; applicantForm: { openingId: string; name: string; email: string }; setApplicantForm: (value: { openingId: string; name: string; email: string }) => void; onCreateOpening: () => void; onAddApplicant: () => void; onMove: (applicant: HrApplicant, stage: string) => void }) {
  const selectableOpenings = openings.filter((opening) => opening.status === "open");
  const openingId = applicantForm.openingId || selectableOpenings[0]?.id || "";
  const pipeline = applicants.filter((applicant) => applicant.openingId === openingId);
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Recruitment</p><h2>Open roles</h2></div><span className="hr-count">{selectableOpenings.length} open</span></div>
      <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); onCreateOpening(); }}><label className="hr-grow">Role title<input required maxLength={120} value={openingTitle} onChange={(event) => setOpeningTitle(event.currentTarget.value)} placeholder="For example, Operations associate" /></label><button className="hr-primary-button" disabled={busy || !openingTitle.trim()}>Create opening</button></form>
      {openings.length === 0 ? <p className="hr-muted">No roles yet. Create an opening to start a pipeline.</p> : <ul className="hr-opening-list">{openings.map((opening) => <li key={opening.id}><span><strong>{opening.title}</strong><small>{opening.department || "General"}</small></span><span className={`hr-pill ${opening.status === "open" ? "is-active" : "is-muted"}`}>{opening.status}</span></li>)}</ul>}
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Candidate pipeline</p><h2>Applicants</h2></div>{selectableOpenings.length > 0 && <label className="hr-select-label">Opening<select value={openingId} onChange={(event) => setApplicantForm({ ...applicantForm, openingId: event.currentTarget.value })}>{selectableOpenings.map((opening) => <option value={opening.id} key={opening.id}>{opening.title}</option>)}</select></label>}</div>
      {selectableOpenings.length > 0 && <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); onAddApplicant(); }}><label className="hr-grow">Candidate name<input required maxLength={120} value={applicantForm.name} onChange={(event) => setApplicantForm({ ...applicantForm, name: event.currentTarget.value })} /></label><label>Email<input type="email" maxLength={254} value={applicantForm.email} onChange={(event) => setApplicantForm({ ...applicantForm, email: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !applicantForm.name.trim()}>Add applicant</button></form>}
      {pipeline.length === 0 ? <p className="hr-muted">No applicants are listed for this opening yet.</p> : <div className="hr-applicant-list">{pipeline.map((applicant) => <article className="hr-applicant" key={applicant.id}><span><strong>{applicant.name}</strong><small>{applicant.note || "No notes"}</small></span><label>Stage<select disabled={busy} value={applicant.stage} onChange={(event) => onMove(applicant, event.currentTarget.value)}><option value={applicant.stage}>{applicant.stage}</option>{["applied", "screening", "interview", "offer", "rejected"].filter((stage) => stage !== applicant.stage).map((stage) => <option value={stage} key={stage}>{stage}</option>)}</select></label></article>)}</div>}
    </section>
  </>;
}

function Leave({ employees, rows, form, setForm, busy, onRequest, onDecision }: { employees: HrEmployee[]; rows: HrReport["leave"]; form: { employeeId: string; kind: string; startDate: string; endDate: string }; setForm: (value: { employeeId: string; kind: string; startDate: string; endDate: string }) => void; busy: boolean; onRequest: () => void; onDecision: (requestId: string, approve: boolean) => void }) {
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Time away</p><h2>Request leave</h2></div></div>
      <form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onRequest(); }}><label>Employee<select required value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label>Leave type<select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.currentTarget.value })}>{["annual", "sick", "parental", "unpaid", "other"].map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label><label>Start date<input required type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.currentTarget.value })} /></label><label>End date<input required type="date" min={form.startDate || undefined} value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !form.employeeId || !form.startDate || !form.endDate || form.endDate < form.startDate}>Submit leave request</button></form>
    </section>
    <section className="hr-card hr-table-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Requests</p><h2>Leave activity</h2></div></div>
      {rows.length === 0 ? <p className="hr-muted">No leave requests have been recorded.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Employee</th><th scope="col">Dates</th><th scope="col">Type</th><th scope="col">Days</th><th scope="col">Status</th><th scope="col">Review</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><th scope="row">{row.employeeName}</th><td>{formatDate(row.startDate)} to {formatDate(row.endDate)}</td><td>{row.kind}</td><td>{row.calendarDays}</td><td><span className={`hr-pill ${row.status === "approved" ? "is-active" : "is-muted"}`}>{row.status}</span></td><td>{row.status === "pending" ? <div className="hr-row-actions"><button type="button" disabled={busy} onClick={() => onDecision(row.id, true)}>Approve</button><button type="button" disabled={busy} onClick={() => onDecision(row.id, false)}>Decline</button></div> : "-"}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function Time({ employees, rows, pending, range, setRange, form, setForm, busy, onLog, onDecision }: { employees: HrEmployee[]; rows: HrTimeReport["rows"]; pending: HrPendingEntry[]; range: { from: string; to: string }; setRange: (value: { from: string; to: string }) => void; form: { employeeId: string; workDate: string; hours: string; note: string }; setForm: (value: { employeeId: string; workDate: string; hours: string; note: string }) => void; busy: boolean; onLog: () => void; onDecision: (entryId: string, decision: "approve" | "reject") => void }) {
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Time tracking</p><h2>Log hours</h2></div></div>
      <form className="hr-form-grid" onSubmit={(event) => { event.preventDefault(); onLog(); }}><label>Employee<select required value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })}><option value="">Select employee</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label><label>Work date<input required type="date" value={form.workDate} onChange={(event) => setForm({ ...form, workDate: event.currentTarget.value })} /></label><label>Hours<input required type="number" min="0.01" max="24" step="0.01" value={form.hours} onChange={(event) => setForm({ ...form, hours: event.currentTarget.value })} /></label><label>Note<input maxLength={500} value={form.note} onChange={(event) => setForm({ ...form, note: event.currentTarget.value })} /></label><button className="hr-primary-button" disabled={busy || !form.employeeId || !form.hours}>Submit time</button></form>
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Time report</p><h2>Hours by employee</h2></div><span className="hr-count">Approved hours</span></div><div className="hr-range"><label>From<input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.currentTarget.value })} /></label><label>To<input type="date" min={range.from} value={range.to} onChange={(event) => setRange({ ...range, to: event.currentTarget.value })} /></label></div>
      {rows.length === 0 ? <p className="hr-muted">No time has been recorded for this date range.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Employee</th><th scope="col">Approved</th><th scope="col">Pending</th></tr></thead><tbody>{rows.map((row) => <tr key={row.employeeId}><th scope="row">{employeeFullName(employees, row.employeeId)}</th><td>{formatMinutes(row.approvedMinutes)}</td><td>{formatMinutes(row.pendingMinutes)}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Approvals</p><h2>Submitted time</h2></div><span className="hr-count">{pending.length} waiting</span></div>
      {pending.length === 0 ? <p className="hr-muted">No submitted entries need review.</p> : <div className="hr-applicant-list">{pending.map((entry) => <article className="hr-applicant" key={entry.id}><span><strong>{entry.employeeName}</strong><small>{formatDate(entry.workDate)} · {formatMinutes(entry.minutes)}{entry.note ? ` · ${entry.note}` : ""}</small></span><div className="hr-row-actions"><button type="button" disabled={busy} onClick={() => onDecision(entry.id, "approve")}>Approve</button><button type="button" disabled={busy} onClick={() => onDecision(entry.id, "reject")}>Reject</button></div></article>)}</div>}
    </section>
  </>;
}

function Payroll({ runs, employees, currency, period, setPeriod, busy, onCreate }: { runs: HrReport["runs"]; employees: HrEmployee[]; currency: string | null; period: string; setPeriod: (value: string) => void; busy: boolean; onCreate: () => void }) {
  return <>
    <section className="hr-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">Payroll</p><h2>Prepare a payroll run</h2></div><span className="hr-count">{employees.length} active people</span></div>
      <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); onCreate(); }}><label>Payroll period<input required type="month" value={period} onChange={(event) => setPeriod(event.currentTarget.value)} /></label><button className="hr-primary-button" disabled={busy || !period}>Create draft run</button></form>
    </section>
    <section className="hr-card hr-table-card"><div className="hr-section-heading"><div><p className="hr-eyebrow">History</p><h2>Payroll runs</h2></div></div>
      {runs.length === 0 ? <p className="hr-muted">No payroll runs have been recorded.</p> : <div className="hr-table-scroll"><table><thead><tr><th scope="col">Period</th><th scope="col">Employees</th><th scope="col">Gross</th><th scope="col">Tax</th><th scope="col">Net</th><th scope="col">Status</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><th scope="row">{new Date(Date.UTC(run.year, run.month - 1, 15)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</th><td>{run.headcount}</td><td>{currency ? formatMoney(run.totalGrossMinor, currency) : "Loading currency"}</td><td>{currency ? formatMoney(run.totalTaxMinor, currency) : "Loading currency"}</td><td>{currency ? formatMoney(run.totalNetMinor, currency) : "Loading currency"}</td><td><span className={`hr-pill ${run.status === "posted" ? "is-active" : "is-muted"}`}>{run.status}</span></td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
