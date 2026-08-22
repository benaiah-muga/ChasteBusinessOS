"use client";

import { useCallback, useEffect, useState } from "react";

const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
type Stage = (typeof STAGES)[number];

interface Deal {
  id: string;
  title: string;
  stage: Stage;
  valueMinor: number;
  note: string | null;
  updatedAt: string;
}

const usd = (minor: number) =>
  "$" + (minor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });

const stageColor: Record<Stage, string> = {
  lead: "border-neutral-300",
  qualified: "border-sky-300",
  proposal: "border-indigo-300",
  negotiation: "border-violet-300",
  won: "border-emerald-400",
  lost: "border-red-300",
};

export default function CrmPage() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/deals")
      .then((r) => r.json())
      .then((d) => setDeals(d.deals ?? []));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title: newTitle.trim(),
          valueMinor: Math.round(Number(newValue || "0") * 100),
        }),
      });
      setNewTitle("");
      setNewValue("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function move(dealId: string, stage: Stage) {
    setBusy(true);
    try {
      await fetch("/api/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "move", dealId, stage }),
      });
      load();
    } finally {
      setBusy(false);
    }
  }

  const openDeals = deals?.filter((d) => d.stage !== "won" && d.stage !== "lost") ?? [];
  const openValue = openDeals.reduce((s, d) => s + d.valueMinor, 0);
  const weights: Record<Stage, number> = { lead: 0.1, qualified: 0.3, proposal: 0.5, negotiation: 0.7, won: 1, lost: 0 };
  const forecast = openDeals.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {openDeals.length} open deals · {usd(openValue)} pipeline ·{" "}
            <span className="font-medium text-neutral-700">{usd(forecast)}</span> weighted forecast
          </p>
        </div>
        <form onSubmit={create} className="flex gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New deal…"
            className="w-44 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
          <input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="$"
            inputMode="decimal"
            className="w-24 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !newTitle.trim()}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </div>

      <div className="grid grid-cols-6 gap-3">
        {STAGES.map((stage) => {
          const column = deals?.filter((d) => d.stage === stage) ?? [];
          return (
            <div key={stage} className={`min-h-[50vh] rounded-xl border-t-4 bg-white p-2 shadow-sm ${stageColor[stage]}`}>
              <p className="mb-2 px-1 font-mono text-xs uppercase tracking-wide text-neutral-500">
                {stage} <span className="text-neutral-300">{column.length}</span>
              </p>
              <div className="space-y-2">
                {column.map((deal) => (
                  <div key={deal.id} className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5">
                    <p className="text-sm font-medium leading-snug">{deal.title}</p>
                    {deal.valueMinor > 0 && <p className="mt-0.5 text-xs tabular-nums text-neutral-500">{usd(deal.valueMinor)}</p>}
                    {stage !== "won" && stage !== "lost" && (
                      <div className="mt-2 flex gap-1">
                        <button
                          onClick={() => move(deal.id, STAGES[Math.min(STAGES.indexOf(stage) + 1, STAGES.length - 2)]!)}
                          disabled={busy}
                          className="flex-1 rounded border border-neutral-200 bg-white py-0.5 text-[10px] text-neutral-600 hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-40"
                        >
                          →
                        </button>
                        <button
                          onClick={() => move(deal.id, "lost")}
                          disabled={busy}
                          className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-red-600 disabled:opacity-40"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    {(stage === "lost" || stage === "won") && (
                      <button
                        onClick={() => move(deal.id, "lead")}
                        disabled={busy}
                        className="mt-2 w-full rounded border border-neutral-200 bg-white py-0.5 text-[10px] text-neutral-500 hover:text-neutral-800 disabled:opacity-40"
                      >
                        reopen
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
