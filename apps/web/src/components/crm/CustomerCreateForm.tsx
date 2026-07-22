"use client";

import { useState } from "react";
import { getApiClient } from "@/lib/api";

export function CustomerCreateFormInline({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setOk(null);
    setErr(null);
    try {
      await getApiClient().createCustomer({
        name,
        email: email || undefined,
        city: city || undefined,
        country: country || undefined,
      });
      setName("");
      setEmail("");
      setCity("");
      setCountry("");
      setOk("Customer created");
      onCreated?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create customer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Ltd" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@acme.example" />
        </label>
        <label>
          City
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Nairobi" />
        </label>
        <label>
          Country
          <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Kenya" />
        </label>
      </div>
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Create customer"}
        </button>
        {ok ? <span className="badge accent">{ok}</span> : null}
        {err ? <span className="error">{err}</span> : null}
      </div>
    </form>
  );
}
