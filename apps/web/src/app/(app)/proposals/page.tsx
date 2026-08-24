"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionNotice,
  type ActionNoticeState,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingPage,
  PageHeader,
} from "@/components/ui";
import { IconAlertTriangle, IconCircleCheck, IconPullRequest } from "@/components/icons";
import { cn, statusTone, timeAgo } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

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

function Diff({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <pre className="overflow-x-auto rounded-lg bg-stone-950 p-4 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        const added = line.startsWith("+") && !line.startsWith("+++");
        const removed = line.startsWith("-") && !line.startsWith("---");
        const meta = line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index ");
        return (
          <div
            key={i}
            className={cn(
              "-mx-4 px-4",
              added && "bg-emerald-500/15 text-emerald-300",
              removed && "bg-red-500/15 text-red-300",
              meta && "text-sky-400",
              !added && !removed && !meta && "text-stone-300",
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export default function ProposalsPage() {
  const __enabled = useModuleEnabled("creator");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ proposals?: Proposal[] }>("/api/proposals");
    if (!res.ok) {
      setError(null);
      setLoadError(res.error?.title ?? "Couldn't load proposals");
      return;
    }
    setProposals(res.data?.proposals ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function review(id: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      const res = await postApi<{ note?: string }>("/api/proposals", { proposalId: id, decision });
      if (res.ok) setNotice({ tone: "success", text: res.data?.note ?? `Proposal ${decision}.` });
      else setNotice({ tone: "error", error: res.error! });
      void load();
    } finally {
      setBusy(false);
    }
  }

  if ((error || loadError) && proposals === null) {
    return (
      <div>
        <PageHeader title="Creator proposals" />
        <EmptyState icon={<IconAlertTriangle />} title={loadError ?? "Couldn't load proposals"} hint={error ?? undefined}
          action={<Button tone="secondary" onClick={() => void load()}>Retry</Button>} />
      </div>
    );
  }

  if (!__enabled) return <ModuleDisabled label="Proposals" />;

  return (
    <div>
      <PageHeader
        title="Creator proposals"
        description="When you enable Creator Mode in the console, the agent can propose changes to this platform itself. Nothing merges automatically, your approval records the decision and the diff lands through a normal pull request where CI verifies it again."
      />

      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {proposals === null ? (
        <LoadingPage />
      ) : proposals.length === 0 ? (
        <EmptyState
          icon={<IconPullRequest />}
          title="No proposals yet"
          hint="Switch on Creator mode in the Console and ask for an improvement, proposed changes arrive here for human review."
        />
      ) : (
        <div className="space-y-4">
          {proposals.map((p) => (
            <Card key={p.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2.5">
                <Badge tone={statusTone(p.status)}>{p.status.replace("_", " ")}</Badge>
                <h2 className="text-[15px] font-semibold text-stone-900">{p.title}</h2>
                <span className="ml-auto text-xs whitespace-nowrap text-stone-400" title={new Date(p.createdAt).toLocaleString()}>
                  {timeAgo(p.createdAt)}
                </span>
              </div>
              <p className="mb-3 text-sm leading-relaxed text-stone-600">{p.summary}</p>

              {openId === p.id ? (
                <>
                  <Diff text={p.diffText} />
                  {p.testEvidence && (
                    <p className="mt-3 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-xs leading-relaxed break-words text-sky-900">
                      <IconCircleCheck className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <strong>Test evidence.</strong> {p.testEvidence}
                      </span>
                    </p>
                  )}
                  {p.riskAssessment && (
                    <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed break-words text-amber-900">
                      <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <strong>Risk assessment.</strong> {p.riskAssessment}
                      </span>
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpenId(null)}
                    className="mt-3 cursor-pointer text-xs font-medium text-stone-500 underline-offset-2 hover:text-stone-700 hover:underline"
                  >
                    Hide diff & evidence
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpenId(p.id)}
                  className="cursor-pointer text-xs font-medium text-maroon-700 underline-offset-2 hover:underline"
                >
                  Show diff &amp; evidence
                </button>
              )}

              {p.status === "in_review" && (
                <div className="mt-4 flex gap-2 border-t border-stone-100 pt-4">
                  <Button loading={busy} onClick={() => review(p.id, "approved")}>
                    Approve → open PR
                  </Button>
                  <Button tone="dangerSecondary" loading={busy} onClick={() => review(p.id, "rejected")}>
                    Reject
                  </Button>
                </div>
              )}
              {p.reviewComment && p.status !== "in_review" && (
                <p className="mt-3 border-t border-stone-100 pt-3 text-xs text-stone-500">Review note: {p.reviewComment}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
