"use client";

import type { Customer } from "@chaste/api-client";
import { useState } from "react";
import { getApiClient } from "@/lib/api";

export function CustomersPanel({
  initialCustomers,
  compact = false,
}: {
  initialCustomers: Customer[];
  compact?: boolean;
}) {
  const [customers, setCustomers] = useState(initialCustomers);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const api = getApiClient();
    const data = await api.listCustomers();
    setCustomers(data.items);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const api = getApiClient();
      await api.createCustomer({
        name,
        city: city || undefined,
        email: email || undefined,
      });
      setName("");
      setCity("");
      setEmail("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div>
        <h2>{compact ? "Customer intake" : "Customers"}</h2>
        <p className="muted" style={{ margin: 0 }}>
          Add a new customer below to start tracking activity, quotes, and orders.
        </p>
      </div>

      <form className="stack" onSubmit={onSubmit}>
        <label>
          Name
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Ltd"
          />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>
            City
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Nairobi"
            />
          </label>
          <label style={{ flex: 1 }}>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ops@acme.example"
            />
          </label>
        </div>
        <div className="row">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Create customer"}
          </button>
          <button className="btn secondary" type="button" onClick={() => refresh()} disabled={busy}>
            Refresh
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>City</th>
              <th>Email</th>
              {!compact ? <th>Status</th> : null}
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={compact ? 3 : 4} className="muted">
                  No customers yet
                </td>
              </tr>
            ) : (
                  customers.slice(0, compact ? 5 : customers.length).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.city ?? <span className="placeholder">not set</span>}</td>
                  <td>{c.email ?? <span className="placeholder">not set</span>}</td>
                  {!compact ? <td>{c.status ?? "active"}</td> : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
