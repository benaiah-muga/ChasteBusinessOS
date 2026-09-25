"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardTitle, ConfirmDialog, EmptyState } from "@/components/ui";
import { IconFileText, IconPlus } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { formatMoneyIn } from "@/lib/prefs";

type TaxProfile = { jurisdictionCode: string; registrationNumber: string | null; filingFrequency: string; providerMode: string };
type TaxCode = { id: string; code: string; name: string; jurisdictionCode: string; direction: "output" | "input"; rateBasisPoints: number; priceIncludesTax: boolean; recoverable: boolean; active: boolean };
type TaxReturn = {
  id: string;
  jurisdictionCode: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  outputTaxMinor: number;
  inputTaxMinor: number;
  taxMinor: number;
  taxBreakdown: { code: string; name: string; direction: "output" | "input"; rateBasisPoints: number | null; priceIncludesTax: boolean; recoverable: boolean; taxableBaseMinor: number; taxMinor: number; lineCount: number }[];
  status: "draft" | "submitted" | "accepted" | "rejected" | "unknown" | "cancelled";
  submissionReference: string | null;
  acknowledgment: unknown;
  evidenceReference: string | null;
  amendsReturnId: string | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  settledAt: string | null;
  settlementEntryId: string | null;
  settlementDelta: { outputMinor: number; inputMinor: number; netMinor: number } | null;
  hasActiveAmendment: boolean;
};
type TaxData = { profile: TaxProfile | null; codes: TaxCode[]; returns: TaxReturn[]; settlements: { id: string; taxReturnId: string | null; periodFrom: string; periodTo: string; taxMinor: number; settledAt: string }[] };
type TaxEnvelope = { ok?: boolean; data?: unknown; error?: string; reason?: string };

const today = new Date();
const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
const defaultFrom = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, "0")}-01`;
const defaultToDate = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0));
const defaultTo = `${defaultToDate.getUTCFullYear()}-${String(defaultToDate.getUTCMonth() + 1).padStart(2, "0")}-${String(defaultToDate.getUTCDate()).padStart(2, "0")}`;

function statusTone(status: TaxReturn["status"]): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "accepted") return "green";
  if (status === "rejected") return "red";
  if (status === "submitted" || status === "unknown") return "amber";
  if (status === "draft") return "blue";
  return "neutral";
}

function safeReference(reference: string | null): string | null {
  if (!reference) return null;
  try {
    const url = new URL(reference);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function TaxWorkbench({ baseCurrency }: { baseCurrency: string }) {
  const [data, setData] = useState<TaxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; text: string } | null>(null);
  const [periodFrom, setPeriodFrom] = useState(defaultFrom);
  const [periodTo, setPeriodTo] = useState(defaultTo);
  const [amendReturnId, setAmendReturnId] = useState("");
  const [profileForm, setProfileForm] = useState({ jurisdictionCode: "", registrationNumber: "", filingFrequency: "monthly" });
  const [codeForm, setCodeForm] = useState({ code: "", name: "", direction: "output" as "output" | "input", ratePercent: "0", priceIncludesTax: false, recoverable: true });
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [submissionTarget, setSubmissionTarget] = useState<string | null>(null);
  const [submissionForm, setSubmissionForm] = useState({ submissionReference: "", evidenceReference: "" });
  const [ackTarget, setAckTarget] = useState<string | null>(null);
  const [ackForm, setAckForm] = useState({ status: "accepted" as "accepted" | "rejected" | "unknown", acknowledgmentReference: "", details: "", evidenceReference: "" });
  const [settleTarget, setSettleTarget] = useState<TaxReturn | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await callApi<TaxData>("/api/accounting/tax");
    if (!res.ok || !res.data) {
      setData(null);
      setError(res.error?.title ?? "Could not load tax setup and return history.");
    } else {
      setData(res.data);
    }
    setLoading(false);
  }, [refresh]);

  useEffect(() => { void load(); }, [load]);

  const amendmentOptions = useMemo(() => (data?.returns ?? []).filter((item) => ["accepted", "rejected"].includes(item.status) && !item.hasActiveAmendment), [data]);

  async function mutate(body: Record<string, unknown>, label: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const res = await postApi<TaxEnvelope>("/api/accounting/tax", { ...body, intentId: crypto.randomUUID() });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: res.data?.reason ?? `${label} is waiting for approval.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", text: res.error?.title ?? res.data?.error ?? `${label} could not be completed.` });
      } else {
        setNotice({ tone: "success", text: `${label} recorded.` });
        setRefresh((value) => value + 1);
        return true;
      }
    } catch {
      setNotice({ tone: "error", text: `Could not complete ${label.toLowerCase()}. Check your connection and try again.` });
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function createProfile() {
    const jurisdictionCode = profileForm.jurisdictionCode.trim().toUpperCase();
    if (!/^[A-Z]{2}(-[A-Z0-9]{1,8})?$/.test(jurisdictionCode)) {
      setNotice({ tone: "error", text: "Use a country code such as UG, or a region code such as US-CA." });
      return;
    }
    const ok = await mutate({ action: "profile", jurisdictionCode, registrationNumber: profileForm.registrationNumber.trim() || undefined, filingFrequency: profileForm.filingFrequency }, "Tax profile");
    if (ok) setProfileForm({ jurisdictionCode: "", registrationNumber: "", filingFrequency: "monthly" });
  }

  async function createCode() {
    const rate = Number(codeForm.ratePercent);
    const code = codeForm.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,24}$/.test(code) || codeForm.name.trim().length < 2 || !Number.isFinite(rate) || rate < 0 || rate > 10_000) {
      setNotice({ tone: "error", text: "Check the code, name, and percentage. Rates must be between 0% and 10,000%." });
      return;
    }
    const ok = await mutate({ action: "createCode", code, name: codeForm.name.trim(), direction: codeForm.direction, rateBasisPoints: Math.round(rate * 100), priceIncludesTax: codeForm.priceIncludesTax, recoverable: codeForm.direction === "input" && codeForm.recoverable }, "Tax code");
    if (ok) {
      setCodeForm({ code: "", name: "", direction: "output", ratePercent: "0", priceIncludesTax: false, recoverable: true });
      setCodeEditorOpen(false);
    }
  }

  if (loading && !data) return <Card><CardTitle>Tax returns and rules</CardTitle><p role="status" className="text-sm text-stone-600">Loading jurisdiction setup and saved return history…</p></Card>;
  if (error && !data) return <Card><CardTitle>Tax returns and rules</CardTitle><div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-red-700">{error}</p><Button size="sm" tone="secondary" onClick={() => setRefresh((value) => value + 1)}>Retry</Button></div></Card>;

  return (
    <section className="space-y-5">
      {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : notice.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</div>}

      {!data?.profile ? (
        <Card>
          <CardTitle>Set up a tax jurisdiction</CardTitle>
          <p className="mb-4 max-w-3xl text-sm text-stone-600">Tax rates and filing rules vary by jurisdiction. Add your registration details, then configure the tax codes your accountant has verified for local use.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs font-medium text-stone-600">Jurisdiction code
              <input className="input mt-1 block w-full uppercase" autoComplete="country" maxLength={11} placeholder="UG or US-CA" value={profileForm.jurisdictionCode} onChange={(event) => setProfileForm((value) => ({ ...value, jurisdictionCode: event.target.value }))} />
            </label>
            <label className="text-xs font-medium text-stone-600">Tax registration number <span className="font-normal text-stone-600">(optional)</span>
              <input className="input mt-1 block w-full" maxLength={100} value={profileForm.registrationNumber} onChange={(event) => setProfileForm((value) => ({ ...value, registrationNumber: event.target.value }))} />
            </label>
            <label className="text-xs font-medium text-stone-600">Filing frequency
              <select className="input mt-1 block w-full" value={profileForm.filingFrequency} onChange={(event) => setProfileForm((value) => ({ ...value, filingFrequency: event.target.value }))}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select>
            </label>
          </div>
          <Button className="mt-4" disabled={busy || !profileForm.jurisdictionCode.trim()} loading={busy} onClick={() => void createProfile()}>Save tax profile</Button>
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle right={<Badge tone="blue">{data.profile.jurisdictionCode}</Badge>}>Tax setup</CardTitle>
                <p className="text-sm text-stone-600">Registration {data.profile.registrationNumber || "not provided"} · {data.profile.filingFrequency} filing · {data.profile.providerMode === "manual" ? "manual authority portal" : "connected provider"}</p>
              </div>
              <Button size="sm" tone="secondary" onClick={() => setCodeEditorOpen((open) => !open)}><IconPlus className="size-3.5" /> Add tax code</Button>
            </div>
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">No tax authority connection is configured. Submit through your authority portal, then record its reference and evidence here. Codes and rates are configured by your finance team and should follow local tax advice.</p>

            {codeEditorOpen && <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-4">
              <h3 className="text-sm font-semibold text-stone-800">Create a jurisdiction tax code</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs font-medium text-stone-600">Code<input className="input mt-1 block w-full uppercase" maxLength={24} placeholder="VAT-18" value={codeForm.code} onChange={(event) => setCodeForm((value) => ({ ...value, code: event.target.value }))} /></label>
                <label className="text-xs font-medium text-stone-600">Name<input className="input mt-1 block w-full" maxLength={100} placeholder="Standard rated" value={codeForm.name} onChange={(event) => setCodeForm((value) => ({ ...value, name: event.target.value }))} /></label>
                <label className="text-xs font-medium text-stone-600">Tax rate (%)<input className="input mt-1 block w-full" type="number" min="0" max="10000" step="0.01" value={codeForm.ratePercent} onChange={(event) => setCodeForm((value) => ({ ...value, ratePercent: event.target.value }))} /></label>
                <label className="text-xs font-medium text-stone-600">Treatment<select className="input mt-1 block w-full" value={codeForm.direction} onChange={(event) => setCodeForm((value) => ({ ...value, direction: event.target.value as "output" | "input" }))}><option value="output">Sales tax collected</option><option value="input">Purchase tax paid</option></select></label>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-stone-700">
                <label className="flex items-center gap-2"><input type="checkbox" className="accent-emerald-700" checked={codeForm.priceIncludesTax} onChange={(event) => setCodeForm((value) => ({ ...value, priceIncludesTax: event.target.checked }))} />Price includes tax</label>
                {codeForm.direction === "input" && <label className="flex items-center gap-2"><input type="checkbox" className="accent-emerald-700" checked={codeForm.recoverable} onChange={(event) => setCodeForm((value) => ({ ...value, recoverable: event.target.checked }))} />Recoverable input tax</label>}
                <div className="ml-auto flex gap-2"><Button size="sm" tone="ghost" onClick={() => setCodeEditorOpen(false)}>Cancel</Button><Button size="sm" loading={busy} disabled={busy} onClick={() => void createCode()}>Save code</Button></div>
              </div>
            </div>}

            {data.codes.length === 0 ? <p className="mt-4 rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">No tax codes yet. Add the verified rates and treatments used on sales and supplier bills.</p> : <div className="mt-4 divide-y divide-stone-200 rounded-xl border border-stone-200">
              {data.codes.map((code) => <div key={code.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="font-mono text-xs font-semibold text-stone-700">{code.code}</span><span className="text-sm font-medium text-stone-800">{code.name}</span><Badge>{code.direction === "output" ? "Output" : "Input"}</Badge><span className="text-xs text-stone-600">{(code.rateBasisPoints / 100).toFixed(2)}%{code.priceIncludesTax ? " · tax inclusive" : ""}{code.direction === "input" ? (code.recoverable ? " · recoverable" : " · non-recoverable") : ""}</span>{!code.active && <Badge>Archived</Badge>}</div>
                <Button size="sm" tone="ghost" disabled={busy} onClick={() => void mutate({ action: code.active ? "archiveCode" : "activateCode", taxCodeId: code.id }, `${code.active ? "Archive" : "Activate"} ${code.code}`)}>{code.active ? "Archive" : "Activate"}</Button>
              </div>)}
            </div>}
          </Card>

          <Card>
            <CardTitle>Prepare a return</CardTitle>
            <p className="-mt-2 mb-4 text-sm text-stone-600">Save a read-only snapshot of sales tax and recoverable input tax before submitting it externally.</p>
            <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <label className="text-xs font-medium text-stone-600">Period start<input className="input mt-1 block w-full" type="date" value={periodFrom} onChange={(event) => setPeriodFrom(event.target.value)} /></label>
              <label className="text-xs font-medium text-stone-600">Period end<input className="input mt-1 block w-full" type="date" value={periodTo} onChange={(event) => setPeriodTo(event.target.value)} /></label>
              <Button disabled={busy || !periodFrom || !periodTo || periodFrom > periodTo} loading={busy} onClick={() => void mutate({ action: "prepare", periodFrom, periodTo, amendsReturnId: amendReturnId || undefined }, "Return snapshot")}>{amendReturnId ? "Prepare amendment snapshot" : "Prepare return snapshot"}</Button>
            </div>
            {amendmentOptions.length > 0 && <label className="mt-3 block max-w-xl text-xs font-medium text-stone-600">Amend an accepted or rejected return <span className="font-normal text-stone-600">(optional)</span>
              <select className="input mt-1 block w-full" value={amendReturnId} onChange={(event) => { const parent = amendmentOptions.find((item) => item.id === event.target.value); setAmendReturnId(event.target.value); if (parent) { setPeriodFrom(parent.periodFrom); setPeriodTo(parent.periodTo); } }}><option value="">New filing period</option>{amendmentOptions.map((item) => <option key={item.id} value={item.id}>{item.periodFrom} to {item.periodTo} · {item.status}</option>)}</select>
            </label>}
            {amendReturnId && <Button className="mt-2" size="sm" tone="ghost" onClick={() => { setAmendReturnId(""); setPeriodFrom(defaultFrom); setPeriodTo(defaultTo); }}>Clear amendment selection</Button>}
          </Card>

          <Card>
            <CardTitle right={data.returns.length ? <Badge>{data.returns.length} recent</Badge> : undefined}>Return history and filing evidence</CardTitle>
            <p className="-mt-2 mb-4 text-sm text-stone-600">External submission and ledger settlement are separate steps. Each saved return keeps the tax amounts used at preparation.</p>
            {data.returns.length === 0 ? <EmptyState icon={<IconFileText />} title="No tax returns prepared" hint="Choose a reporting window above to save the first snapshot. Foreign-currency tax documents must be converted before a return can be prepared." /> : <div className="space-y-3">
              {data.returns.map((item) => <article key={item.id} className="rounded-xl border border-stone-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-stone-900">{item.periodFrom} to {item.periodTo}</h3><Badge tone={statusTone(item.status)}>{item.status}</Badge>{item.amendsReturnId && <Badge tone="violet">Amendment</Badge>}{item.hasActiveAmendment && <Badge tone="amber">Amendment in progress</Badge>}</div>
                    <p className="mt-1 text-xs text-stone-600">{item.jurisdictionCode} · saved in {item.currency} · {item.submissionReference ? `Submission ${item.submissionReference}` : "not submitted"}</p>
                  </div>
                  <div className="text-left sm:text-right"><p className="text-xs text-stone-600">Net tax on this return</p><p className="tnum text-base font-semibold text-stone-900">{formatMoneyIn(item.currency, item.taxMinor)}</p>{item.settlementDelta && item.amendsReturnId && <p className="mt-1 text-xs text-stone-600">Settlement change: {formatMoneyIn(item.currency, item.settlementDelta.netMinor)}</p>}</div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <TaxAmount label="Output tax" value={formatMoneyIn(item.currency, item.outputTaxMinor)} />
                  <TaxAmount label="Recoverable input tax" value={formatMoneyIn(item.currency, item.inputTaxMinor)} />
                  <TaxAmount label="Net payable / (credit)" value={formatMoneyIn(item.currency, item.taxMinor)} />
                  <TaxAmount label="Settlement" value={item.settledAt ? `Recorded ${new Date(item.settledAt).toLocaleDateString()}` : "Not recorded"} />
                </div>
                <details className="mt-3 rounded-lg border border-stone-200 px-3 py-2">
                  <summary className="cursor-pointer text-sm font-medium text-stone-700">Tax-code detail <span className="font-normal text-stone-600">({item.taxBreakdown?.length ?? 0} lines)</span></summary>
                  {item.taxBreakdown?.length ? <div className="table-shell mt-3 overflow-x-auto"><table className="data-table min-w-[620px]">
                    <thead><tr><th>Tax code</th><th>Treatment</th><th className="text-right">Taxable base</th><th className="text-right">Rate</th><th className="text-right">Tax</th></tr></thead>
                    <tbody>{item.taxBreakdown.map((line, index) => <tr key={`${line.direction}:${line.code}:${index}`}>
                      <td><span className="font-medium text-stone-800">{line.name}</span><span className="ml-2 font-mono text-xs text-stone-600">{line.code}</span></td>
                      <td>{line.direction === "output" ? "Output tax" : line.recoverable ? "Recoverable input" : "Non-recoverable input"}{line.priceIncludesTax ? " · inclusive" : ""}</td>
                      <td className="num">{formatMoneyIn(item.currency, line.taxableBaseMinor)}</td>
                      <td className="num">{line.rateBasisPoints === null ? "Adjustment" : `${(line.rateBasisPoints / 100).toFixed(2)}%`}</td>
                      <td className="num">{formatMoneyIn(item.currency, line.taxMinor)}</td>
                    </tr>)}</tbody>
                  </table></div> : <p className="mt-2 text-sm text-stone-600">No tax-coded lines were included in this saved return.</p>}
                </details>
                {item.evidenceReference && <p className="mt-3 break-all text-xs text-stone-600">Evidence: {safeReference(item.evidenceReference) ? <a className="text-emerald-800 underline underline-offset-2" href={safeReference(item.evidenceReference) ?? undefined} target="_blank" rel="noreferrer">{item.evidenceReference}</a> : item.evidenceReference}</p>}
                {item.acknowledgment != null && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-stone-600">Authority response: {typeof item.acknowledgment === "string" ? item.acknowledgment : JSON.stringify(item.acknowledgment)}</p>}

                {submissionTarget === item.id && <div className="mt-4 grid gap-2 rounded-lg bg-stone-50 p-3 sm:grid-cols-2">
                  <p className="sm:col-span-2 text-xs text-stone-600">After submitting the saved return in the authority portal, record the portal reference and link or storage reference for your evidence.</p>
                  <label className="text-xs font-medium text-stone-600">Submission reference<input className="input mt-1 block w-full" maxLength={200} value={submissionForm.submissionReference} onChange={(event) => setSubmissionForm((value) => ({ ...value, submissionReference: event.target.value }))} /></label>
                  <label className="text-xs font-medium text-stone-600">Evidence URL or reference<input className="input mt-1 block w-full" maxLength={500} value={submissionForm.evidenceReference} onChange={(event) => setSubmissionForm((value) => ({ ...value, evidenceReference: event.target.value }))} /></label>
                  <div className="flex justify-end gap-2 sm:col-span-2"><Button size="sm" tone="ghost" onClick={() => setSubmissionTarget(null)}>Cancel</Button><Button size="sm" disabled={busy || !submissionForm.submissionReference.trim() || !submissionForm.evidenceReference.trim()} loading={busy} onClick={() => void mutate({ action: "submit", taxReturnId: item.id, ...submissionForm }, "External submission").then((ok) => ok && setSubmissionTarget(null))}>Record submission</Button></div>
                </div>}

                {ackTarget === item.id && <div className="mt-4 grid gap-2 rounded-lg bg-stone-50 p-3 sm:grid-cols-2">
                  <label className="text-xs font-medium text-stone-600">Authority response<select className="input mt-1 block w-full" value={ackForm.status} onChange={(event) => setAckForm((value) => ({ ...value, status: event.target.value as typeof value.status }))}><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="unknown">Status unclear</option></select></label>
                  <label className="text-xs font-medium text-stone-600">Acknowledgment reference<input className="input mt-1 block w-full" maxLength={200} value={ackForm.acknowledgmentReference} onChange={(event) => setAckForm((value) => ({ ...value, acknowledgmentReference: event.target.value }))} /></label>
                  <label className="text-xs font-medium text-stone-600">Evidence URL or reference<input className="input mt-1 block w-full" maxLength={500} value={ackForm.evidenceReference} onChange={(event) => setAckForm((value) => ({ ...value, evidenceReference: event.target.value }))} /></label>
                  <label className="text-xs font-medium text-stone-600">Details<input className="input mt-1 block w-full" maxLength={1000} value={ackForm.details} onChange={(event) => setAckForm((value) => ({ ...value, details: event.target.value }))} /></label>
                  <div className="flex justify-end gap-2 sm:col-span-2"><Button size="sm" tone="ghost" onClick={() => setAckTarget(null)}>Cancel</Button><Button size="sm" disabled={busy} loading={busy} onClick={() => void mutate({ action: "acknowledge", taxReturnId: item.id, ...ackForm }, "Authority acknowledgment").then((ok) => ok && setAckTarget(null))}>Save acknowledgment</Button></div>
                </div>}

                <div className="mt-4 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                  {item.status === "draft" && <>
                    <Button size="sm" tone="secondary" disabled={busy} onClick={() => { setSubmissionTarget(item.id); setSubmissionForm({ submissionReference: "", evidenceReference: "" }); }}>Record external submission</Button>
                    <Button size="sm" tone="ghost" disabled={busy} onClick={() => void mutate({ action: "cancelDraft", taxReturnId: item.id }, "Cancel return draft")}>Cancel draft</Button>
                  </>}
                  {(item.status === "submitted" || item.status === "unknown") && <Button size="sm" tone="secondary" disabled={busy} onClick={() => { setAckTarget(item.id); setAckForm({ status: "accepted", acknowledgmentReference: "", details: "", evidenceReference: "" }); }}>Record authority acknowledgment</Button>}
                  {["submitted", "accepted"].includes(item.status) && !item.settlementEntryId && !item.hasActiveAmendment && Boolean(item.settlementDelta && (item.settlementDelta.outputMinor !== 0 || item.settlementDelta.inputMinor !== 0)) && <Button size="sm" disabled={busy} onClick={() => setSettleTarget(item)}>Record ledger settlement</Button>}
                  {["accepted", "rejected"].includes(item.status) && !item.hasActiveAmendment && <Button size="sm" tone="ghost" disabled={busy} onClick={() => { setAmendReturnId(item.id); setPeriodFrom(item.periodFrom); setPeriodTo(item.periodTo); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Prepare amendment</Button>}
                  {item.settlementEntryId && <Badge tone="green">Settlement posted</Badge>}
                </div>
              </article>)}
            </div>}
          </Card>

          {data.settlements.length > 0 && <Card><CardTitle>Recent ledger settlements</CardTitle><div className="divide-y divide-stone-200">{data.settlements.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span className="text-stone-700">{item.periodFrom} to {item.periodTo}</span><span className="tnum font-medium">{formatMoneyIn(baseCurrency, item.taxMinor)}</span><span className="text-xs text-stone-600">{new Date(item.settledAt).toLocaleDateString()}</span></div>)}</div></Card>}
        </>
      )}

      <ConfirmDialog open={settleTarget !== null} onClose={() => setSettleTarget(null)} onConfirm={() => { if (!settleTarget) return; void mutate({ action: "settle", taxReturnId: settleTarget.id }, "Tax ledger settlement").then((ok) => ok && setSettleTarget(null)); }} title="Record tax ledger settlement" body={<>This posts an approval-gated journal entry for the amendment-adjusted net amount of <strong>{settleTarget ? formatMoneyIn(settleTarget.currency, settleTarget.settlementDelta?.netMinor ?? settleTarget.taxMinor) : ""}</strong>. It records the ledger settlement only. Submit the return through the authority portal separately.</>} confirmLabel="Request settlement" busy={busy} />
    </section>
  );
}

function TaxAmount({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-stone-50 p-3"><p className="text-xs text-stone-600">{label}</p><p className="mt-1 break-words text-sm font-medium text-stone-800">{value}</p></div>;
}
