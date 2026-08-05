"use client";

import { useEffect, useState } from "react";
import { Check, Lightbulb, Plus, Search } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";
import type { CatalogItem } from "@chaste/api-client";

type Gap = {
  id: string;
  status: string;
  title: string;
  abstractRequirement: string;
  proposedCapabilityId: string;
  deploymentTarget: string;
  createdAt: string;
};

type Recommendation = {
  deploymentTarget: string;
  rationale: string[];
  signals: string[];
};

export default function GapsPage() {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [form, setForm] = useState({ capabilityId: "", title: "", requirement: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    const res = await getApiClient().listCapabilityGaps();
    setGaps(res.tickets ?? []);
  }

  useEffect(() => {
    load().catch(() => setErr("Failed to load capability gaps"));
  }, []);

  async function searchCatalog() {
    setErr("");
    setSearched(true);
    try {
      const res = await getApiClient().searchCapabilityCatalog({ query });
      setResults(res.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed");
    }
  }

  async function recommend() {
    setErr("");
    try {
      const res = await getApiClient().recommendCapability({
        abstractRequirement: form.requirement,
      });
      setRec({
        deploymentTarget: res.deploymentTarget,
        rationale: res.rationale ?? [],
        signals: res.signals ?? [],
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Recommendation failed");
    }
  }

  async function confirmGap() {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const created = await getApiClient().createCapabilityGap({
        proposedCapabilityId: form.capabilityId.trim(),
        title: form.title,
        abstractRequirement: form.requirement,
        deploymentTarget: rec?.deploymentTarget ?? "undecided",
      });
      const ticketId = (created as { data?: { id: string } }).data?.id;
      if (!ticketId) throw new Error("No ticket id returned");
      await getApiClient().confirmCapabilityGap({ ticketId });
      setForm({ capabilityId: "", title: "", requirement: "" });
      setRec(null);
      setMsg("Gap ticket confirmed and recorded for the platform.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to file gap");
    } finally {
      setBusy(false);
    }
  }

  const open = gaps.filter((g) => g.status !== "confirmed" && g.status !== "closed");
  const confirmed = gaps.filter((g) => g.status === "confirmed");

  return (
    <AppShell subtitle="Find it in the catalog, or file a gap the platform can close.">
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Search the capability catalog</h2>
            <p className="muted">Check whether the platform already covers a need before filing a gap.</p>
          </div>
          <Lightbulb size={18} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchCatalog()}
            placeholder="e.g. recurring invoices, stock count, follow-up emails"
            style={{ flex: 1 }}
          />
          <button className="btn" type="button" onClick={searchCatalog}>
            <Search size={15} /> Search
          </button>
        </div>
        {searched ? (
          results.length === 0 ? (
            <div className="empty-state">
              <p>No catalog items match — this is likely a genuine gap.</p>
            </div>
          ) : (
            <div className="stack">
              {results.map((r) => (
                <div key={r.id} className="row between">
                  <div className="stack" style={{ gap: 2, flex: 1 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <code className="mono">{r.capabilityId}</code>
                      {r.implemented ? <span className="badge accent">implemented</span> : <span className="badge">catalog</span>}
                    </div>
                    <strong>{r.name}</strong>
                    {r.description ? <span className="muted small">{r.description}</span> : null}
                  </div>
                  {r.implemented ? <span className="muted small">Already available</span> : null}
                </div>
              ))}
            </div>
          )
        ) : null}
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>File a gap</h2>
            <p className="muted">Describe the need; we recommend where it should live.</p>
          </div>
        </div>
        <div className="stack">
          <div className="grid" style={{ gridTemplateColumns: "1fr 2fr" }}>
            <label>
              Capability id
              <input
                value={form.capabilityId}
                onChange={(e) => setForm({ ...form, capabilityId: e.target.value })}
                placeholder="sales.trial_followup"
              />
            </label>
            <label>
              Title
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Automated trial follow-up"
              />
            </label>
          </div>
          <label>
            Abstract requirement
            <textarea
              value={form.requirement}
              onChange={(e) => setForm({ ...form, requirement: e.target.value })}
              placeholder="We need to remind customers their trial is ending and close the loop."
              rows={3}
            />
          </label>
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <button
              className="btn secondary"
              type="button"
              onClick={recommend}
              disabled={!form.requirement}
            >
              Recommend placement
            </button>
            {rec ? (
              <span className="badge accent">
                Placement: {rec.deploymentTarget}
              </span>
            ) : null}
          </div>
          {rec ? (
            <div className="rec-card">
              <p>
                <strong>Recommended placement:</strong>{" "}
                <code className="mono">{rec.deploymentTarget}</code>
              </p>
              {rec.rationale.map((r, i) => (
                <p key={i} className="muted small">
                  {r}
                </p>
              ))}
              {rec.signals.length > 0 ? (
                <p className="muted small">Signals: {rec.signals.join(" · ")}</p>
              ) : null}
            </div>
          ) : null}
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn"
              type="button"
              disabled={busy || !form.capabilityId || !form.title || !form.requirement}
              onClick={confirmGap}
            >
              <Plus size={15} /> File &amp; confirm gap
            </button>
            {msg ? <span className="badge accent">{msg}</span> : null}
            {err ? <span className="error">{err}</span> : null}
          </div>
        </div>
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Open gaps</h2>
            <p className="muted">Confirmed tickets are the platform&apos;s input queue.</p>
          </div>
        </div>
        {open.length === 0 ? (
          <div className="empty-state">
            <p>No open gaps.</p>
          </div>
        ) : (
          <div className="stack">
            {open.map((g) => (
              <div key={g.id} className="row between">
                <div className="stack" style={{ gap: 2, flex: 1 }}>
                  <strong>{g.title}</strong>
                  <span className="muted small">
                    {g.status} · {g.deploymentTarget ?? "no placement yet"} · {new Date(g.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {confirmed.length > 0 ? (
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Confirmed</h2>
              <p className="muted">Awaiting platform implementation.</p>
            </div>
          </div>
          <div className="stack">
            {confirmed.map((g) => (
              <div key={g.id} className="row between">
                <div className="stack" style={{ gap: 2, flex: 1 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <Check size={15} />
                    <strong>{g.title}</strong>
                  </div>
                  <span className="muted small">
                    {g.deploymentTarget ?? "placement TBD"} · {new Date(g.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}