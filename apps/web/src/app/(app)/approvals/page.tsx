"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Button,
  Badge,
  CopyButton,
  EmptyState,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
  PageHeader,
  RiskBadge,
} from "@/components/ui";
import { IconAlertTriangle, IconCircleCheck, IconInbox } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { formatMoney } from "@/lib/format";

interface Approval {
  id: string;
  capabilityId: string;
  riskClass: string;
  payload: unknown;
  rationale: string;
  createdAt: string;
  status?: string;
  decidedAt?: string | null;
  decisionComment?: string | null;
  decidedBy?: string | null;
  relatedDocuments?: Array<{ id: string; title: string }>;
  raisedBy?: { name: string; kind: "agent" | "human" };
}

function actionTitle(capabilityId: string): string {
  const action = capabilityId.split(".").at(-1) ?? capabilityId;
  return action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function friendlyValue(key: string, value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && /(amount|total|value|price|minor)/i.test(key)) return formatMoney(value);
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return "Details available";
  return String(value);
}

function previewFields(payload: unknown): Array<[string, unknown]> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const hidden = /(password|secret|token|credential|base64)/i;
  return Object.entries(payload as Record<string, unknown>)
    .filter(([key]) => !hidden.test(key) && !["intentId", "sessionId"].includes(key))
    .slice(0, 8);
}

function targetName(payload: unknown): string | null {
  const entry = previewFields(payload).find(([key]) => /name|title|description/i.test(key))?.[1];
  return typeof entry === "string" ? entry : null;
}

function safePayload(value: unknown, key = "", depth = 0): unknown {
  if (/(password|secret|token|credential|base64)/i.test(key)) return "[hidden]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 497)}…` : value;
  if (depth >= 5) return "[nested details hidden]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safePayload(entry, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, entry]) => [childKey, safePayload(entry, childKey, depth + 1)]));
  }
  return value;
}

function ApprovalContext({ approval }: { approval: Approval }) {
  const payload = approval.payload as Record<string, unknown>;
  if (approval.capabilityId === "harness.approveComposition") {
    const digest = typeof payload.compositionDigest === "string" ? payload.compositionDigest : null;
    return (
      <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50/60 px-3.5 py-3 text-xs text-violet-950">
        <div className="flex items-center gap-2"><Badge tone="violet">Runtime composition</Badge><span>Exact profile and bundle identity must match before a durable run can mount.</span></div>
        {digest && <div className="mt-2 flex flex-wrap items-center gap-1">Composition digest <code className="break-all">{digest}</code><CopyButton text={digest} label="Copy digest" /></div>}
      </div>
    );
  }
  if (approval.capabilityId.startsWith("creator.")) {
    const digest = typeof payload.candidateDigest === "string" ? payload.candidateDigest : null;
    return (
      <div className="mb-4 rounded-lg border border-maroon-200 bg-maroon-50/60 px-3.5 py-3 text-xs text-maroon-950">
        <div className="flex items-center gap-2"><Badge tone="gold">Creator release</Badge><span>Approval records a controlled artifact handoff; it does not install or execute source.</span></div>
        {digest && <div className="mt-2 flex flex-wrap items-center gap-1">Candidate digest <code className="break-all">{digest}</code><CopyButton text={digest} label="Copy digest" /></div>}
      </div>
    );
  }
  return null;
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [history, setHistory] = useState<Approval[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ approvals: Approval[]; history?: Approval[] }>("/api/approvals");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load approvals");
      return;
    }
    setApprovals(res.data!.approvals);
    setHistory(res.data!.history ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    try {
      const res = await postApi<{ ok?: boolean }>(`/api/approvals?id=${id}`, { decision });
      if (res.status === 422 && res.error) {
        // Execution failed after approval, the gate held, the action didn't land.
        setNotice({ tone: "error", error: res.error });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice(
          decision === "approve"
            ? { tone: "success", text: "Approved and executed, the result is in the ledger." }
            : { tone: "success", text: "Rejected. The action was not executed and the decision is on record." },
        );
      }
      await load();
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Actions that need human authority, money above thresholds, identity changes, destructive operations. Nothing executes until you decide."
        actions={approvals && approvals.length > 0 ? <span className="text-sm font-medium text-stone-500">{approvals.length} waiting</span> : undefined}
      />

      {notice && (
        <ActionNotice state={notice.tone === "error" ? notice : { ...notice, text: <>{notice.text} <Link href="/ledger">View in the ledger</Link></> }} onDismiss={() => setNotice(null)} />
      )}

      {loadError && !approvals ? (
        <EmptyState
          icon={<IconAlertTriangle />}
          title={loadError}
          hint="Check your connection, then retry."
          action={
            <Button tone="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : approvals === null ? (
        <LoadingPage />
      ) : (
        <>
        {approvals.length === 0 ? <EmptyState icon={<IconInbox />} title="Inbox zero" hint="The agent is within policy, nothing is waiting on your authority." /> : <div className="space-y-4">
          {approvals.map((a) => (
            <article key={a.id} className="card overflow-hidden p-0">
              {/* Header strip */}
              <header className="flex flex-wrap items-center gap-2.5 border-b border-stone-100 bg-stone-50/60 px-5 py-3">
                <RiskBadge risk={a.riskClass} />
                <span className="text-sm font-semibold text-stone-900">{actionTitle(a.capabilityId)}</span>
                {a.raisedBy && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      a.raisedBy.kind === "agent" ? "bg-violet-100 text-violet-800" : "bg-stone-200 text-stone-700"
                    }`}
                    title={
                      a.raisedBy.kind === "agent"
                        ? `Raised by the workmate acting for ${a.raisedBy.name}`
                        : "Raised by a person in your organization"
                    }
                  >
                    {a.raisedBy.kind === "agent" ? "agent · for " : "human · "}
                    {a.raisedBy.name}
                  </span>
                )}
                <time className="ml-auto text-xs whitespace-nowrap text-stone-400" dateTime={a.createdAt}>
                  {new Date(a.createdAt).toLocaleString()}
                </time>
              </header>

              <div className="p-5">
                <ApprovalContext approval={a} />
                <div className="mb-4 rounded-lg border border-gold-200 bg-gold-50/50 p-3.5">
                  <p className="text-[11px] font-semibold tracking-wide text-gold-900 uppercase">What this does</p>
                  <p className="mt-1 text-sm leading-relaxed text-stone-800">
                    {a.rationale || `${actionTitle(a.capabilityId)} will run after approval.`}
                    {targetName(a.payload) && <> It relates to <strong>{targetName(a.payload)}</strong>.</>}
                  </p>
                </div>
                {previewFields(a.payload).length > 0 && (
                  <section className="mb-4 rounded-lg border border-stone-200 p-3.5" aria-label="Affected record preview">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Affected record preview</h3>
                    <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">{previewFields(a.payload).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-[11px] text-stone-500">{key.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}</dt><dd className="mt-0.5 break-words text-sm text-stone-800">{friendlyValue(key, value)}</dd></div>)}</dl>
                  </section>
                )}
                {a.relatedDocuments && a.relatedDocuments.length > 0 && (
                  <section className="mb-4 rounded-lg border border-blue-200 bg-blue-50/50 p-3">
                    <h3 className="text-xs font-semibold text-blue-900">Related documents</h3>
                    <ul className="mt-1 space-y-1 text-sm">{a.relatedDocuments.map((document) => <li key={document.id}><Link className="text-blue-800 underline underline-offset-2" href={`/documents?documentId=${encodeURIComponent(document.id)}`}>{document.title}</Link></li>)}</ul>
                  </section>
                )}
                <details>
                  <summary className="mb-2 cursor-pointer text-[11px] font-semibold tracking-wider text-stone-400 uppercase select-none hover:text-stone-600">
                    Technical details
                  </summary>
                  <pre className="max-h-56 overflow-auto rounded-lg bg-stone-950 p-4 font-mono text-xs leading-relaxed text-stone-200">
                    {JSON.stringify(safePayload(a.payload), null, 2)}
                  </pre>
                </details>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button loading={busyId === a.id} onClick={() => decide(a.id, "approve")}>
                    <IconCircleCheck className="size-4" />
                    Approve &amp; execute
                  </Button>
                  <Button tone="dangerSecondary" disabled={busyId === a.id} onClick={() => decide(a.id, "reject")}>
                    Reject
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>}
        {history.length > 0 && <section className="mt-8">
          <div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-stone-900">Recent decisions</h2><p className="mt-0.5 text-xs text-stone-500">Approvals, rejections, and expiry history for this organization.</p></div><Link href="/ledger" className="text-xs font-medium text-gold-800 hover:underline">Open audit ledger</Link></div>
          <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white">
            {history.map((approval) => <li key={approval.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"><Badge tone={approval.status === "executed" || approval.status === "approved" ? "green" : approval.status === "rejected" ? "red" : "neutral"}>{approval.status}</Badge><span className="font-medium text-stone-800">{actionTitle(approval.capabilityId)}</span><span className="text-xs text-stone-500">{approval.decidedBy ? `by ${approval.decidedBy}` : "Decision recorded"}</span><time className="ml-auto text-xs text-stone-400">{approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : new Date(approval.createdAt).toLocaleString()}</time>{approval.decisionComment && <p className="basis-full pl-1 text-xs text-stone-500">{approval.decisionComment}</p>}</li>)}
          </ul>
          <p className="mt-2 text-xs text-stone-500">Decision outcomes are recorded in the audit ledger. Reversal, when supported, must be made through the linked business action.</p>
        </section>}
        </>
      )}
    </div>
  );
}
