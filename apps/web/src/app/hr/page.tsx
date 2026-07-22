import { AppShell } from "@/components/AppShell";
import { HrWorkspace } from "@/components/hr/HrWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HrPage() {
  const api = getApiClient();
  let employees: Awaited<ReturnType<typeof api.listHr>>["employees"] = [];
  let payrollRuns: Awaited<ReturnType<typeof api.listHr>>["payrollRuns"] = [];
  try {
    const data = await api.listHr();
    employees = data.employees;
    payrollRuns = data.payrollRuns;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Employees, departments, and payroll preparation.">
      <HrWorkspace initialEmployees={employees} initialPayroll={payrollRuns} />
    </AppShell>
  );
}
