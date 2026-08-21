"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Approval {
  id: string;
  capabilityId: string;
  riskClass: string;
  payload: unknown;
  rationale: string;
  createdAt: string;
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/approvals");
    if (res.ok) {
      const data = await res.json();
      setApprovals(data.approvals);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/approvals?id=${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setNotice(decision === "approve" ? "Approved and executed." : "Rejected.");
      await load();
      router.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Approvals</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Actions that need human authority — money above thresholds, identity changes, destructive
        operations. Nothing executes until you decide.
      </p>

      {notice && <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</p>}

      {approvals === null && <p className="text-sm text-neutral-400">Loading…</p>}
      {approvals?.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-400">
          Inbox zero. The agent is within policy.
        </p>
      )}

      <div className="space-y-4">
        {approvals?.map((a) => (
          <div key={a.id} className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-3">
              <span className={`rounded-full px-2.5 py-0.5 font-mono text-xs ${
                a.riskClass === "money" ? "bg-amber-100 text-amber-800" :
                a.riskClass === "identity" || a.riskClass === "destructive" ? "bg-red-100 text-red-800" :
                "bg-neutral-100 text-neutral-700"
              }`}>
                {a.riskClass}
              </span>
              <span className="font-mono text-sm font-medium">{a.capabilityId}</span>
              <span className="ml-auto font-mono text-xs text-neutral-400">
                {new Date(a.createdAt).toLocaleString()}
              </span>
            </div>
            <pre className="mb-2 max-h-48 overflow-auto rounded-lg bg-neutral-950 p-4 text-xs leading-relaxed text-emerald-200">
              {JSON.stringify(a.payload, null, 2)}
            </pre>
            <p className="mb-4 text-xs text-neutral-500">{a.rationale}</p>
            <div className="flex gap-3">
              <button
                onClick={() => decide(a.id, "approve")}
                disabled={busyId === a.id}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
              >
                Approve & execute
              </button>
              <button
                onClick={() => decide(a.id, "reject")}
                disabled={busyId === a.id}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
