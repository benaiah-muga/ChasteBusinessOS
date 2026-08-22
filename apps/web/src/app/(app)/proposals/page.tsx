"use client";

import { useCallback, useEffect, useState } from "react";

interface Proposal {
  id: string;
  title: string;
  summary: string;
  diffText: string;
  testEvidence: string | null;
  riskAssessment: string | null;
  status: string;
  reviewComment: string | null;
  createdAt: string;
}

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/proposals")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) setError(d.error ?? "failed");
        else setProposals(d.proposals ?? []);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function review(id: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      const res = await fetch("/api/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: id, decision }),
      });
      const json = await res.json();
      setNotice(res.ok ? json.note : `failed: ${json.error}`);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <p className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-400">{error}</p>;
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Creator proposals</h1>
      <p className="mb-6 text-sm text-neutral-500">
        When you enable Creator Mode in the console, the agent can propose changes to this platform
        itself. Nothing merges automatically. Approval records your decision; the diff lands through
        a normal pull request where CI verifies it again.
      </p>

      {notice && <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</p>}

      {proposals === null && !error && <p className="text-sm text-neutral-400">Loading…</p>}
      {proposals?.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-400">
          No proposals yet. Switch the console to Creator Mode and ask for an improvement.
        </p>
      )}

      <div className="space-y-4">
        {proposals?.map((p) => (
          <div key={p.id} className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="mb-2 flex items-center gap-3">
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-xs ${
                  p.status === "in_review"
                    ? "bg-amber-100 text-amber-800"
                    : p.status === "approved" || p.status === "merged"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-red-100 text-red-800"
                }`}
              >
                {p.status}
              </span>
              <span className="font-medium">{p.title}</span>
              <span className="ml-auto font-mono text-xs text-neutral-400">
                {new Date(p.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="mb-3 text-sm leading-relaxed text-neutral-600">{p.summary}</p>

            {openId === p.id ? (
              <>
                <pre className="max-h-72 overflow-auto rounded-lg bg-neutral-950 p-4 text-xs leading-relaxed text-emerald-200">
                  {p.diffText}
                </pre>
                {p.testEvidence && (
                  <p className="mt-2 whitespace-pre-wrap rounded-lg bg-sky-50 p-3 text-xs text-sky-900">
                    Tests: {p.testEvidence}
                  </p>
                )}
                {p.riskAssessment && (
                  <p className="mt-2 whitespace-pre-wrap rounded-lg bg-orange-50 p-3 text-xs text-orange-900">
                    Risks: {p.riskAssessment}
                  </p>
                )}
              </>
            ) : (
              <button onClick={() => setOpenId(p.id)} className="text-xs text-emerald-700 underline underline-offset-2">
                show diff &amp; evidence
              </button>
            )}

            {p.status === "in_review" && (
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => review(p.id, "approved")}
                  disabled={busy}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  onClick={() => review(p.id, "rejected")}
                  disabled={busy}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
