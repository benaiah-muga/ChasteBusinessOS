"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Button,
  EmptyState,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
  PageHeader,
  RiskBadge,
} from "@/components/ui";
import { IconAlertTriangle, IconCircleCheck, IconInbox } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ approvals: Approval[] }>("/api/approvals");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load approvals");
      return;
    }
    setApprovals(res.data!.approvals);
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
      ) : approvals.length === 0 ? (
        <EmptyState icon={<IconInbox />} title="Inbox zero" hint="The agent is within policy, nothing is waiting on your authority." />
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <article key={a.id} className="card overflow-hidden p-0">
              {/* Header strip */}
              <header className="flex flex-wrap items-center gap-2.5 border-b border-stone-100 bg-stone-50/60 px-5 py-3">
                <RiskBadge risk={a.riskClass} />
                <span className="font-mono text-[13px] font-medium text-stone-800">{a.capabilityId}</span>
                <time className="ml-auto text-xs whitespace-nowrap text-stone-400" dateTime={a.createdAt}>
                  {new Date(a.createdAt).toLocaleString()}
                </time>
              </header>

              <div className="p-5">
                {a.rationale && (
                  <blockquote className="mb-4 border-l-2 border-maroon-300 pl-3.5 text-sm leading-relaxed text-stone-600 italic">
                    {a.rationale}
                  </blockquote>
                )}

                <details open>
                  <summary className="mb-2 cursor-pointer text-[11px] font-semibold tracking-wider text-stone-400 uppercase select-none hover:text-stone-600">
                    Proposed action · evidence
                  </summary>
                  <pre className="max-h-56 overflow-auto rounded-lg bg-stone-950 p-4 font-mono text-xs leading-relaxed text-stone-200">
                    {JSON.stringify(a.payload, null, 2)}
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
        </div>
      )}
    </div>
  );
}
