"use client";

import { use, useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { IconSparkle } from "@/components/icons";
import { cn } from "@/lib/format";

interface PortalInvoice {
  number: number;
  status: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  issuedAt: string | null;
  customerName: string;
  lines: Array<{ description: string; quantity: number; unitPriceMinor: number; taxMinor: number }>;
}

const STATUS_TONE: Record<string, "green" | "amber" | "neutral"> = {
  paid: "green",
  sent: "amber",
  draft: "neutral",
};

export function PortalLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center gap-2 text-stone-400">
        <IconSparkle className="size-4 text-maroon-800" />
        <span className="text-sm font-medium tracking-tight text-stone-600">Chaste · Invoice portal</span>
      </div>
      <div className="animate-pulse space-y-3 rounded-xl border border-stone-200 bg-white p-6">
        <div className="h-5 w-40 rounded bg-stone-100" />
        <div className="h-3 w-64 rounded bg-stone-100" />
        <div className="h-24 w-full rounded bg-stone-100" />
      </div>
    </div>
  );
}

export function PortalInvoiceContent({ params }: { params: Promise<{ token: string }> }) {
  // use(params) suspends here — inside the Suspense boundary on the server
  // page — so the shell prerenders without knowing the token.
  const { token } = use(params);
  const [invoice, setInvoice] = useState<PortalInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/portal/invoice/${token}`)
      .then(async (r) => {
        if (!r.ok) {
          setError(r.status === 429 ? "Too many requests — try again shortly." : "This link is not valid.");
          return;
        }
        const data = (await r.json()) as { invoice?: PortalInvoice };
        setInvoice(data.invoice ?? null);
      })
      .catch(() => setError("Couldn't load this invoice."));
  }, [token]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center gap-2 text-stone-400">
        <IconSparkle className="size-4 text-maroon-800" />
        <span className="text-sm font-medium tracking-tight text-stone-600">Chaste · Invoice portal</span>
      </div>

      {error && (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-14 text-center">
          <p className="text-sm font-medium text-stone-700">{error}</p>
          <p className="mt-1 text-[13px] text-stone-500">
            Ask the business for a fresh link if you still need your invoice.
          </p>
        </div>
      )}

      {!error && !invoice && (
        <div className="animate-pulse space-y-3 rounded-xl border border-stone-200 bg-white p-6">
          <div className="h-5 w-40 rounded bg-stone-100" />
          <div className="h-3 w-64 rounded bg-stone-100" />
          <div className="h-24 w-full rounded bg-stone-100" />
        </div>
      )}

      {invoice && (
        <article className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xs">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 p-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-stone-900">
                Invoice #{invoice.number}
              </h1>
              <p className="mt-0.5 text-sm text-stone-500">
                Billed to {invoice.customerName}
                {invoice.issuedAt ? ` · issued ${new Date(invoice.issuedAt).toLocaleDateString()}` : ""}
              </p>
            </div>
            <Badge tone={STATUS_TONE[invoice.status] ?? "neutral"}>{invoice.status}</Badge>
          </header>

          <ul className="divide-y divide-stone-100">
            {invoice.lines.map((l, i) => (
              <li key={i} className="flex items-baseline justify-between gap-4 px-6 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-stone-800">{l.description}</span>
                <span className={cn("shrink-0 tabular-nums text-stone-600")}>
                  {(l.quantity / 1000).toLocaleString()} ×{" "}
                  {(l.unitPriceMinor / 100).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          <footer className="space-y-1 border-t border-stone-100 bg-stone-50/60 p-6 text-sm tabular-nums">
            <div className="flex justify-between text-stone-600">
              <span>Total</span>
              <span>
                {invoice.currency} {(invoice.totalMinor / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-stone-600">
              <span>Paid</span>
              <span>
                {invoice.currency} {(invoice.paidMinor / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between pt-1 text-base font-semibold text-stone-900">
              <span>Outstanding</span>
              <span>
                {invoice.currency} {(invoice.outstandingMinor / 100).toFixed(2)}
              </span>
            </div>
          </footer>
        </article>
      )}
    </div>
  );
}
