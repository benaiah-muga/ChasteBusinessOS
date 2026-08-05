"use client";

import { useState } from "react";
import type { Customer } from "@chaste/api-client";
import { getApiClient } from "@/lib/api";

type Mode = "create" | "edit";

/**
 * Shared customer form. In `create` mode it POSTs a new customer; in `edit`
 * mode it PATCHes an existing one. Both paths go through the same command bus
 * as the agent (crm.customer.create / crm.customer.update).
 */
export function CustomerForm({
  mode,
  customer,
  onDone,
  onCancel,
}: {
  mode: Mode;
  customer?: Customer;
  onDone: (c: Customer) => void;
  onCancel?: () => void;
}) {
  const api = getApiClient();
  const [name, setName] = useState(customer?.name ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [city, setCity] = useState(customer?.city ?? "");
  const [country, setCountry] = useState(customer?.country ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        name,
        email: email || undefined,
        city: city || undefined,
        country: country || undefined,
      };
      const result =
        mode === "create"
          ? await api.createCustomer(payload)
          : await api.updateCustomer(customer!.id, payload);
      onDone(result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save customer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="field">
          <span>Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Ltd" />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@acme.example" />
        </label>
        <label className="field">
          <span>City</span>
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Nairobi" />
        </label>
        <label className="field">
          <span>Country</span>
          <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Kenya" />
        </label>
      </div>
      {err ? <p className="error">{err}</p> : null}
      <div className="form-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create customer" : "Save changes"}
        </button>
        {onCancel ? (
          <button className="btn secondary" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
