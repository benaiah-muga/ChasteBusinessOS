"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

export function HrActions() {
  const [employeeNumber, setEmployeeNumber] = useState(`E-${Date.now().toString().slice(-4)}`);
  const [fullName, setFullName] = useState("");
  const [salary, setSalary] = useState("1000");
  const [period, setPeriod] = useState("2026-07");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addEmployee(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // F20 — apiFetch attaches the Bearer token (execute as the user, not admin).
      const body = (await apiFetch("/api/v1/hr/employees", {
        method: "POST",
        body: JSON.stringify({ employeeNumber, fullName, baseSalary: Number(salary) }),
      })) as { fullName?: string };
      setMsg(`Added ${body.fullName ?? fullName}`);
      window.location.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function runPayroll() {
    setMsg(null);
    setBusy(true);
    try {
      const body = (await apiFetch("/api/v1/hr/payroll", {
        method: "POST",
        body: JSON.stringify({ periodLabel: period }),
      })) as { periodLabel?: string };
      setMsg(`Prepared payroll ${body.periodLabel ?? period}`);
      window.location.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
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
          <input
            type="number"
            min="0"
            step="0.01"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Working…" : "Add employee"}
          </button>
        </div>
      </form>
      <div className="row">
        <input value={period} onChange={(e) => setPeriod(e.target.value)} />
        <button className="btn secondary" type="button" disabled={busy} onClick={runPayroll}>
          Prepare payroll
        </button>
      </div>
      {msg ? (
        <p className={msg.startsWith("Added") || msg.startsWith("Prepared") ? "muted" : "error"}>
          {msg}
        </p>
      ) : null}
    </div>
  );
}
