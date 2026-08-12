"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

export function CreateProductForm() {
  const [sku, setSku] = useState(`SKU-${Date.now().toString().slice(-5)}`);
  const [name, setName] = useState("Widget");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // F20 — apiFetch attaches the Bearer token (execute as the user, not admin).
      const body = (await apiFetch("/api/v1/inventory/products", {
        method: "POST",
        body: JSON.stringify({ sku, name }),
      })) as { sku?: string };
      setMsg(`Created ${body.sku ?? sku}`);
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
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" required />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add product"}
        </button>
      </div>
      {msg ? <p className={msg.startsWith("Created") ? "muted" : "error"}>{msg}</p> : null}
    </form>
  );
}
