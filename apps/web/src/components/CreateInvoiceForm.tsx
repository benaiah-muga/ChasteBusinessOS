"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export function CreateInvoiceForm() {
  const [number, setNumber] = useState(`INV-${Date.now().toString().slice(-6)}`);
  const [total, setTotal] = useState("100");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/accounting/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number, total: Number(total), currency: "USD" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        number?: string;
      };
      if (!res.ok) {
        setMsg(body.message ?? "Failed to create invoice");
        return;
      }
      setMsg(`Created ${body.number ?? number}`);
      window.location.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row">
        <label style={{ flex: 1 }}>
          Number
          <input value={number} onChange={(e) => setNumber(e.target.value)} required />
        </label>
        <label style={{ flex: 1 }}>
          Total
          <input
            type="number"
            min="0"
            step="0.01"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            required
          />
        </label>
      </div>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create invoice"}
      </button>
      {msg ? <p className={msg.startsWith("Created") ? "muted" : "error"}>{msg}</p> : null}
    </form>
  );
}
