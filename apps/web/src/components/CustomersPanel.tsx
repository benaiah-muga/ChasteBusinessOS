"use client";

import type { Customer } from "@chaste/api-client";
import { useState } from "react";
import { getApiClient } from "@/lib/api";

export function CustomersPanel({ initialCustomers }: { initialCustomers: Customer[] }) {
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
        <h2>Customers</h2>
        <p className="muted" style={{ margin: 0 }}>
          Manual UI → <span className="mono">POST /api/v1/crm/customers</span> →{" "}
          <span className="mono">crm.customer.create</span>
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

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>City</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          {customers.length === 0 ? (
            <tr>
              <td colSpan={3} className="muted">
                No customers yet
              </td>
            </tr>
          ) : (
            customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.city ?? "—"}</td>
                <td>{c.email ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
