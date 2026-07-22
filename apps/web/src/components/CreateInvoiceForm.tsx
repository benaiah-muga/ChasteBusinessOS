"use client";

import { useState } from "react";
import { getApiClient } from "@/lib/api";

export function CreateInvoiceForm({ onCreated }: { onCreated?: () => void }) {
  const [number, setNumber] = useState(`INV-${Date.now().toString().slice(-6)}`);
  const [total, setTotal] = useState("100");
  const [currency, setCurrency] = useState("USD");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const api = getApiClient();
      const res = await api.createInvoice({ number, total: Number(total), currency });
      setMsg(`Created ${res.number ?? number}`);
      setNumber(`INV-${Date.now().toString().slice(-6)}`);
      setTotal("100");
      onCreated?.();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create invoice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row">
        <label style={{ flex: 2 }}>
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
        <label style={{ flex: 1 }}>
          Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={4} required />
        </label>
      </div>
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create invoice"}
        </button>
        {msg ? (
          <span className={msg.startsWith("Created") ? "badge accent" : "error"}>{msg}</span>
        ) : null}
      </div>
    </form>
  );
}
