"use client";

import { useCallback, useEffect, useState } from "react";

interface PosSession {
  id: string;
  register: string;
  status: string;
  openingFloatMinor: number;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  openedAt: string;
  closedAt: string | null;
}
interface SaleLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

const usd = (minor: number) =>
  (minor < 0 ? "-" : "") + "$" + (Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

export default function PosPage() {
  const [sessions, setSessions] = useState<PosSession[] | null>(null);
  const [float, setFloat] = useState("100");
  const [line, setLine] = useState({ description: "", price: "" });
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [counted, setCounted] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openSession = sessions?.find((s) => s.status === "open") ?? null;

  const load = useCallback(() => {
    fetch("/api/pos")
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/pos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (res.status === 202) setNotice(`${label} requires approval.`);
      else if (!res.ok) setNotice(`${label} failed: ${json.error}`);
      else if (payload.action === "close") {
        const d = json.data as { expectedCashMinor: number; varianceMinor: number };
        setNotice(
          d.varianceMinor === 0
            ? `Drawer balanced exactly at ${usd(d.expectedCashMinor)}.`
            : `VARIANCE ${usd(d.varianceMinor)} — expected ${usd(d.expectedCashMinor)}. Flagged for review.`,
        );
      } else setNotice(`${label} done.`);
      load();
    } finally {
      setBusy(false);
    }
  }

  function addLine(e: React.FormEvent) {
    e.preventDefault();
    if (!line.description.trim() || !line.price) return;
    setLines((l) => [...l, { description: line.description.trim(), quantity: 1000, unitPriceMinor: Math.round(Number(line.price) * 100) }]);
    setLine({ description: "", price: "" });
  }

  const total = lines.reduce((s, l) => s + l.unitPriceMinor, 0);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Point of sale</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Sales post instantly to the ledger. Closing counts the drawer — variances are recorded, never
        smoothed over.
      </p>

      {notice && <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</p>}

      {!openSession && (
        <div className="max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-3 font-medium">Open the register</h2>
          <div className="flex gap-2">
            <input
              value={float}
              onChange={(e) => setFloat(e.target.value)}
              placeholder="Opening float $"
              inputMode="decimal"
              className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            />
            <button
              onClick={() => post({ action: "open", openingFloatMinor: Math.round(Number(float || "0") * 100) }, "Open session")}
              disabled={busy}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
            >
              Open
            </button>
          </div>
        </div>
      )}

      {openSession && (
        <div className="grid gap-6 md:grid-cols-2">
          <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-medium">
              Ring a sale <span className="font-mono text-xs text-emerald-700">register open</span>
            </h2>
            <form onSubmit={addLine} className="flex gap-2">
              <input
                value={line.description}
                onChange={(e) => setLine((l) => ({ ...l, description: e.target.value }))}
                placeholder="Item"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <input
                value={line.price}
                onChange={(e) => setLine((l) => ({ ...l, price: e.target.value }))}
                placeholder="$"
                inputMode="decimal"
                className="w-20 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <button type="submit" className="rounded-lg border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50">
                Add
              </button>
            </form>

            <ul className="mt-3 space-y-1 text-sm">
              {lines.map((l, i) => (
                <li key={i} className="flex justify-between text-neutral-600">
                  <span>{l.description}</span>
                  <span className="tabular-nums">{usd(l.unitPriceMinor)}</span>
                </li>
              ))}
            </ul>
            {lines.length > 0 && (
              <p className="mt-2 flex justify-between border-t border-neutral-200 pt-2 font-medium">
                <span>Total</span>
                <span className="tabular-nums">{usd(total)}</span>
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as "cash" | "card")}
                className="rounded-lg border border-neutral-300 px-2 py-2 text-sm"
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
              </select>
              <button
                onClick={() =>
                  post(
                    { action: "sale", sessionId: openSession.id, method, lines },
                    `Sale ${usd(total)} (${method})`,
                  ).then(() => setLines([]))
                }
                disabled={busy || lines.length === 0}
                className="flex-1 rounded-lg bg-emerald-700 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
              >
                Complete sale
              </button>
            </div>
          </section>

          <section className="self-start rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-medium">Close &amp; count drawer</h2>
            <p className="mb-3 text-sm text-neutral-500">
              Expected cash so far:{" "}
              <span className="font-medium tabular-nums text-neutral-800">
                {usd(openSession.openingFloatMinor + (openSession.expectedCashMinor ?? 0))}
              </span>
            </p>
            <div className="flex gap-2">
              <input
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                placeholder="Counted cash $"
                inputMode="decimal"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <button
                onClick={() =>
                  confirm("Close this session?") &&
                  post(
                    { action: "close", sessionId: openSession.id, countedCashMinor: Math.round(Number(counted || "0") * 100) },
                    "Close session",
                  )
                }
                disabled={busy || !counted}
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-40"
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {sessions && sessions.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Register history</h2>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2.5">Register</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Opened</th>
                  <th className="px-4 py-2.5 text-right">Expected</th>
                  <th className="px-4 py-2.5 text-right">Counted</th>
                  <th className="px-4 py-2.5 text-right">Variance</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className={`border-b border-neutral-100 last:border-0 ${s.varianceMinor !== null && s.varianceMinor !== 0 ? "bg-orange-50/50" : ""}`}>
                    <td className="px-4 py-2">{s.register}</td>
                    <td className="px-4 py-2 font-mono text-xs">{s.status}</td>
                    <td className="px-4 py-2 text-xs text-neutral-500">{new Date(s.openedAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.expectedCashMinor !== null ? usd(s.expectedCashMinor) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.countedCashMinor !== null ? usd(s.countedCashMinor) : "—"}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${s.varianceMinor ? "font-semibold text-red-700" : ""}`}>
                      {s.varianceMinor !== null ? usd(s.varianceMinor) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
