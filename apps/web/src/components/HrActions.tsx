"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export function HrActions() {
  const [employeeNumber, setEmployeeNumber] = useState(`E-${Date.now().toString().slice(-4)}`);
  const [fullName, setFullName] = useState("");
  const [salary, setSalary] = useState("1000");
  const [period, setPeriod] = useState("2026-03");

  async function addEmployee(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`${getApiBaseUrl()}/api/v1/hr/employees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employeeNumber,
        fullName,
        baseSalary: Number(salary),
      }),
    });
    window.location.reload();
  }

  async function runPayroll() {
    await fetch(`${getApiBaseUrl()}/api/v1/hr/payroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ periodLabel: period }),
    });
    window.location.reload();
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={addEmployee}>
        <div className="row">
          <input value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)} />
          <input
            style={{ flex: 1 }}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
            required
          />
          <input value={salary} onChange={(e) => setSalary(e.target.value)} />
          <button className="btn" type="submit">
            Add employee
          </button>
        </div>
      </form>
      <div className="row">
        <input value={period} onChange={(e) => setPeriod(e.target.value)} />
        <button className="btn secondary" type="button" onClick={runPayroll}>
          Prepare payroll
        </button>
      </div>
    </div>
  );
}
