"use client";

import { useMemo, useState } from "react";
import {
  Banknote,
  LayoutDashboard,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";
import { BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { getApiClient } from "@/lib/api";

type Employee = {
  id?: string;
  employeeNumber: string;
  fullName: string;
  email?: string;
  department?: string | null;
  jobTitle?: string | null;
  baseSalary: string;
  isActive?: boolean;
};

type PayrollRun = {
  id?: string;
  periodLabel: string;
  status: string;
  totalGross: string;
  employeeCount: number;
};

export function HrWorkspace({
  initialEmployees,
  initialPayroll,
}: {
  initialEmployees: Employee[];
  initialPayroll: PayrollRun[];
}) {
  const [employees, setEmployees] = useState(initialEmployees);
  const [payroll, setPayroll] = useState(initialPayroll);
  const [tab, setTab] = useState("overview");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [employeeNumber, setEmployeeNumber] = useState(`E-${Date.now().toString().slice(-4)}`);
  const [fullName, setFullName] = useState("");
  const [department, setDepartment] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [salary, setSalary] = useState("1000");
  const [period, setPeriod] = useState("2026-07");

  async function refresh() {
    try {
      const data = await getApiClient().listHr();
      setEmployees(data.employees);
      setPayroll(data.payrollRuns);
    } catch {
      /* keep */
    }
  }

  const byDept = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees) {
      const d = e.department || "Unassigned";
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [employees]);

  const salaryByDept = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees) {
      const d = e.department || "Unassigned";
      m.set(d, (m.get(d) ?? 0) + Number(e.baseSalary || 0));
    }
    return Array.from(m, ([name, payroll]) => ({ name, payroll }));
  }, [employees]);

  const totalPayroll = employees.reduce((s, e) => s + Number(e.baseSalary || 0), 0);

  async function addEmployee(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await getApiClient().createEmployee({
        employeeNumber,
        fullName,
        department: department || undefined,
        jobTitle: jobTitle || undefined,
        baseSalary: Number(salary),
      });
      setMsg(`Added ${fullName}`);
      setFullName("");
      setEmployeeNumber(`E-${Date.now().toString().slice(-4)}`);
      await refresh();
      setTab("employees");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to add employee");
    } finally {
      setBusy(false);
    }
  }

  async function runPayroll() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await getApiClient().preparePayroll({ periodLabel: period });
      setMsg(`Prepared payroll for ${res.periodLabel}`);
      await refresh();
      setTab("payroll");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to prepare payroll");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Employees" icon={Users} value="employees" count={employees.length} />
      <Tab label="Payroll" icon={Banknote} value="payroll" count={payroll.length} />
      <Tab label="Add employee" icon={UserPlus} value="add" />
      <Tab label="Run payroll" icon={Plus} value="run" />

      <TabPanel value="overview">
        <div className="stack">
          <div className="kpi-grid">
            <Kpi label="Headcount" value={employees.length} icon={Users} />
            <Kpi
              label="Monthly base pay"
              value={totalPayroll.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              icon={Banknote}
            />
            <Kpi label="Departments" value={byDept.length} icon={Users} />
            <Kpi label="Payroll runs" value={payroll.length} icon={Banknote} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ChartCard title="Headcount by department">
              <DonutChart data={byDept.length ? byDept : [{ name: "None", value: 1 }]} />
            </ChartCard>
            <ChartCard title="Base pay by department">
              <BarSeries
                data={salaryByDept.length ? salaryByDept : [{ name: "None", payroll: 0 }]}
                xKey="name"
                keys={[{ key: "payroll", label: "Base pay" }]}
              />
            </ChartCard>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="employees">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Employees</h2>
              <p className="muted">Active workforce records for this workspace.</p>
            </div>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Department</th>
                  <th>Title</th>
                  <th>Base salary</th>
                </tr>
              </thead>
              <tbody>
                {employees.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No employees yet
                    </td>
                  </tr>
                ) : (
                  employees.map((e) => (
                    <tr key={e.employeeNumber}>
                      <td className="mono">{e.employeeNumber}</td>
                      <td>{e.fullName}</td>
                      <td>{e.department ?? <span className="placeholder">unassigned</span>}</td>
                      <td>{e.jobTitle ?? <span className="placeholder">not set</span>}</td>
                      <td>{e.baseSalary}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="payroll">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Payroll runs</h2>
              <p className="muted">Prepared payroll periods and totals.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Employees</th>
                  <th>Gross</th>
                </tr>
              </thead>
              <tbody>
                {payroll.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No payroll runs yet
                    </td>
                  </tr>
                ) : (
                  payroll.map((p) => (
                    <tr key={(p.id ?? "") + p.periodLabel + p.status}>
                      <td>{p.periodLabel}</td>
                      <td>
                        <span className="badge accent">{p.status}</span>
                      </td>
                      <td>{p.employeeCount}</td>
                      <td>{p.totalGross}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="add">
        <section className="card stack">
          <h2>Add employee</h2>
          <form className="stack" onSubmit={addEmployee}>
            <div className="row">
              <label>
                Employee number
                <input value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)} required />
              </label>
              <label style={{ flex: 1 }}>
                Full name
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </label>
            </div>
            <div className="row">
              <label style={{ flex: 1 }}>
                Department
                <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Sales" />
              </label>
              <label style={{ flex: 1 }}>
                Job title
                <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Account manager" />
              </label>
              <label>
                Base salary
                <input type="number" min="0" step="0.01" value={salary} onChange={(e) => setSalary(e.target.value)} />
              </label>
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving..." : "Add employee"}
            </button>
          </form>
          {msg ? <p className={msg.startsWith("Added") || msg.startsWith("Prepared") ? "muted" : "error"}>{msg}</p> : null}
        </section>
      </TabPanel>

      <TabPanel value="run">
        <section className="card stack">
          <h2>Prepare payroll</h2>
          <p className="muted">Generate a payroll run from current base salaries.</p>
          <div className="row">
            <label>
              Period label
              <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" />
            </label>
            <button className="btn" type="button" disabled={busy} onClick={runPayroll}>
              {busy ? "Working..." : "Prepare payroll"}
            </button>
          </div>
          {msg ? <p className={msg.startsWith("Added") || msg.startsWith("Prepared") ? "muted" : "error"}>{msg}</p> : null}
        </section>
      </TabPanel>
    </Tabs>
  );
}
