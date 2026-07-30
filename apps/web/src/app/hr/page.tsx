import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";
import { HrActions } from "@/components/HrActions";

export const dynamic = "force-dynamic";

export default async function HrPage() {
  let data: {
    employees: {
      employeeNumber: string;
      fullName: string;
      department?: string | null;
      baseSalary: string;
    }[];
    payrollRuns: {
      periodLabel: string;
      status: string;
      totalGross: string;
      employeeCount: number;
    }[];
  } = { employees: [], payrollRuns: [] };
  try {
    data = await apiFetch("/api/v1/hr");
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="HR — employees and payroll preparation">
      <div className="grid">
        <section className="card stack">
          <h2>Employees</h2>
          <HrActions />
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Dept</th>
                <th>Salary</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.employeeNumber}>
                  <td className="mono">{e.employeeNumber}</td>
                  <td>{e.fullName}</td>
                  <td>{e.department ?? "—"}</td>
                  <td>{e.baseSalary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card stack">
          <h2>Payroll runs</h2>
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
              {data.payrollRuns.map((p) => (
                <tr key={p.periodLabel + p.status}>
                  <td>{p.periodLabel}</td>
                  <td>{p.status}</td>
                  <td>{p.employeeCount}</td>
                  <td>{p.totalGross}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}
