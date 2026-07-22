"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export function CreateVendorForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/purchasing/vendors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email: email.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
      if (!res.ok) {
        setMsg(body.message ?? "Failed to create vendor");
        return;
      }
      setMsg(`Created ${body.name ?? name}`);
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
        <input
          style={{ flex: 1 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Vendor name"
          required
        />
        <input
          style={{ flex: 1 }}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email (optional)"
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add vendor"}
        </button>
      </div>
      {msg ? <p className={msg.startsWith("Created") ? "muted" : "error"}>{msg}</p> : null}
    </form>
  );
}
