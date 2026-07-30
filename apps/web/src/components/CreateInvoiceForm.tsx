"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export function CreateInvoiceForm() {
  const [number, setNumber] = useState(`INV-${Date.now().toString().slice(-6)}`);
  const [total, setTotal] = useState("100");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await fetch(`${getApiBaseUrl()}/api/v1/accounting/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number, total: Number(total), currency: "USD" }),
    });
    const body = await res.json();
    if (!res.ok) {
      setMsg(body.message ?? "Failed");
      return;
    }
    setMsg(`Created ${body.number}`);
    window.location.reload();
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
          <input value={total} onChange={(e) => setTotal(e.target.value)} required />
        </label>
      </div>
      <button className="btn" type="submit">
        Create invoice
      </button>
      {msg ? <p className="muted">{msg}</p> : null}
    </form>
  );
}
