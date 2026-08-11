"use client";

import { useEffect, useState } from "react";
import { GitBranch, Plus } from "lucide-react";
import { getApiClient } from "@/lib/api";

type Branch = {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  active: boolean;
  isActiveBranch: boolean;
  grantType: "all" | "explicit";
};

export function BranchesPanel() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", code: "" });

  async function load() {
    const res = await getApiClient().listBranches();
    setBranches(res.branches ?? []);
  }

  useEffect(() => {
    load().catch(() => setErr("Failed to load branches"));
  }, []);

  async function createBranch() {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      await getApiClient().createBranch({ name: form.name, code: form.code });
      setForm({ name: "", code: "" });
      setMsg("Branch created.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create branch");
    } finally {
      setBusy(false);
    }
  }

  async function switchBranch(id: string) {
    setErr("");
    setMsg("");
    try {
      await getApiClient().setActiveBranch({ branchId: id });
      setMsg("Active branch updated.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to switch branch");
    }
  }

  return (
    <>
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Branches</h2>
            <p className="muted">
              {branches.length} branch{branches.length === 1 ? "" : "es"} in this org.
            </p>
          </div>
          <GitBranch size={18} />
        </div>
        {err ? <span className="error">{err}</span> : null}
        {msg ? <span className="badge accent">{msg}</span> : null}
        {branches.length === 0 ? (
          <div className="empty-state">
            <p>No branches yet — create the first one below.</p>
          </div>
        ) : (
          <div className="stack">
            {branches.map((b) => (
              <div key={b.id} className="row between">
                <div className="stack" style={{ gap: 2, flex: 1 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{b.name}</strong>
                    {b.isActiveBranch ? <span className="badge accent">active</span> : null}
                    <span className="badge">{b.grantType}</span>
                  </div>
                  <span className="muted small">
                    {b.code} · {b.timezone ?? "UTC"}
                  </span>
                </div>
                {!b.isActiveBranch ? (
                  <button className="btn secondary" type="button" onClick={() => switchBranch(b.id)}>
                    Switch here
                  </button>
                ) : (
                  <span className="muted small">Current</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>New branch</h2>
            <p className="muted">Give it a name and a short code; timezone defaults to the org.</p>
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="London" />
          </label>
          <label>
            Code
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="LON" />
          </label>
          <button className="btn" type="button" disabled={busy || !form.name || !form.code} onClick={createBranch}>
            <Plus size={15} /> Create
          </button>
        </div>
      </section>
    </>
  );
}
