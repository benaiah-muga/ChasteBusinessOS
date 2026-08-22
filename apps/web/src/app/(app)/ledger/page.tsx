"use client";

import { useEffect, useState } from "react";

interface LedgerEvent {
  seq: number;
  kind: string;
  capabilityId: string | null;
  actorType: string;
  payload: unknown;
  hash: string | null;
  prevHash: string | null;
  occurredAt: string;
}

export default function LedgerPage() {
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);

  useEffect(() => {
    fetch("/api/ledger?limit=100")
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []));
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Event Ledger</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Append-only and hash-chained. Every action — human or agent — with its evidence. Each
        entry commits to the previous one; tampering breaks the chain visibly.
      </p>

      {events === null && <p className="text-sm text-neutral-400">Loading…</p>}
      {events?.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-400">
          Nothing yet. Do something in the console.
        </p>
      )}

      {events && events.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Capability</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Chain</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-400">{e.seq}</td>
                  <td className="px-4 py-2.5 font-medium">{e.kind}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{e.capabilityId ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${
                      e.actorType === "agent" ? "bg-indigo-100 text-indigo-800" : "bg-neutral-100"
                    }`}>
                      {e.actorType}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-neutral-500">
                    {new Date(e.occurredAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-400" title={`prev: ${e.prevHash}`}>
                    {e.hash?.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
