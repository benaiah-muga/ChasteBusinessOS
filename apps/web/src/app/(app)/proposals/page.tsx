"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionNotice,
  type ActionNoticeState,
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  LoadingPage,
  PageHeader,
} from "@/components/ui";
import { IconAlertTriangle, IconCircleCheck, IconPullRequest, IconSparkle } from "@/components/icons";
import { cn, statusTone, timeAgo } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "proposals" | "gaps" | "setup";

interface AgentCandidate {
  cli: string;
  label: string;
  install: string;
  authNote: string;
}
interface DetectedAgentInfo {
  id: string;
  label: string;
  version: string | null;
  viaBinary: boolean;
  configDirs: string[];
}
interface AgentStatus {
  installed: boolean;
  cli: string | null;
  label: string | null;
  version: string | null;
  agents: DetectedAgentInfo[];
  candidates: AgentCandidate[];
}

/**
 * Creator-mode onboarding: detect an installed coding agent, or walk the
 * human through installing one - the app never runs the install itself,
 * it only hands over the command and verifies afterwards.
 */
function AgentSetupCard() {
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    const res = await callApi<AgentStatus>("/api/creator/agent");
    if (res.data) setAgent(res.data);
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (!agent) return null;
  if (agent.installed) {
    return (
      <div className="mb-6 flex flex-wrap items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3.5 text-sm">
        <IconCircleCheck className="size-4 shrink-0 text-emerald-600" />
        <span className="text-emerald-900">
          <strong className="font-medium">{agent.label}</strong> is connected{agent.version ? ` · ${agent.version}` : ""}.
          Switch on Creator mode in the console and ask it for an improvement.
        </span>
        {agent.agents.length > 1 && (
          <span className="w-full text-xs text-emerald-800/80">
            Also detected:{" "}
            {agent.agents
              .filter((a) => a.label !== agent.label)
              .map((a) => `${a.label}${a.version ? ` (${a.version})` : a.viaBinary ? "" : " (config only)"}`)
              .join(" · ")}
          </span>
        )}
      </div>
    );
  }
  const first = agent.candidates[0];
  return (
    <div className="mb-6 rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
        <IconSparkle className="size-4 text-gold-700" />
        Connect a coding agent to use Creator mode
      </h2>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
        Creator mode works by an agent proposing changes as reviewed diffs. No supported coding CLI
        {agent.candidates.map((c) => ` ${c.label}`).join(" ·")} was found on this machine's PATH.
        Install one - you only leave the app to sign in with the vendor.
      </p>
      <ol className="mt-3 space-y-2.5 text-sm">
        <li className="flex flex-wrap items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gold-100 text-[11px] font-bold text-gold-800">
            1
          </span>
          <span className="text-stone-600">Install {first?.label ?? "an agent"}:</span>
          <code className="rounded bg-stone-100 px-2 py-0.5 font-mono text-xs">{first?.install}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(first?.install ?? "").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            className="cursor-pointer text-xs font-medium text-gold-700 underline underline-offset-2"
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </li>
        <li className="flex flex-wrap items-start gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gold-100 text-[11px] font-bold text-gold-800">
            2
          </span>
          <span className="text-stone-600">{first?.authNote}</span>
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gold-100 text-[11px] font-bold text-gold-800">
            3
          </span>
          <Button size="sm" loading={checking} onClick={() => void check()}>
            Check again
          </Button>
        </li>
      </ol>
    </div>
  );
}

interface Proposal {
  id: string;
  title: string;
  summary: string;
  diffText: string;
  testEvidence: string | null;
  riskAssessment: string | null;
  status: string;
  gapTicketId: string | null;
  reviewComment: string | null;
  createdAt: string;
  releases: EvolutionRelease[];
}
interface EvolutionOutcome {
  id: string;
  verdict: "pass" | "fail";
  evidenceRef: string;
  metrics: Record<string, string | number | boolean>;
  observedAt: string;
}
interface EvolutionRelease {
  id: string;
  gapTicketId: string | null;
  candidateDigest: string;
  artifactRef: string;
  status: "staged" | "promoted" | "rolled_back";
  stagedAt: string;
  promotedAt: string | null;
  rolledBackAt: string | null;
  outcomes: EvolutionOutcome[];
}
interface CapabilityGap {
  id: string;
  title: string;
  description: string;
  status: string;
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
  const [tab, setTab] = useState<Tab>("proposals");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [gaps, setGaps] = useState<CapabilityGap[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [artifactRefs, setArtifactRefs] = useState<Record<string, string>>({});
  const [evidenceRefs, setEvidenceRefs] = useState<Record<string, string>>({});

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
    void callApi<{ gaps?: CapabilityGap[] }>("/api/capability-gaps").then((res) => setGaps(res.data?.gaps ?? []));
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

  async function evolution(input: Record<string, unknown>, successText: string) {
    setBusy(true);
    try {
      const res = await postApi<{ pendingApproval?: boolean; reason?: string }>("/api/creator/evolution", input);
      if (res.status === 202) setNotice({ tone: "pending", text: "Approval requested. Review it in the Approvals inbox before anything changes." });
      else if (res.ok) setNotice({ tone: "success", text: successText });
      else setNotice({ tone: "error", error: res.error! });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function candidateDigest(proposal: Proposal): string | null {
    if (!proposal.testEvidence) return null;
    try {
      const value = JSON.parse(proposal.testEvidence) as { candidateDigest?: unknown };
      return typeof value.candidateDigest === "string" ? value.candidateDigest : null;
    } catch {
      return null;
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
    <AppFrame
      appId="creator"
      description="When you enable Creator Mode in the console, the agent can propose changes to this platform itself. Nothing merges automatically - your approval records the decision and the diff lands through a normal pull request where CI verifies it again."
      persistKey="proposals"
      tabs={[
        { id: "proposals", label: "Proposals", count: proposals?.length || undefined },
        { id: "gaps", label: "Capability gaps", count: gaps?.filter((gap) => gap.status === "open").length || undefined },
        { id: "setup", label: "Setup" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "setup" && <AgentSetupCard />}

      {tab === "gaps" && (
        gaps === null ? <LoadingPage /> : gaps.length === 0 ? (
          <EmptyState icon={<IconCircleCheck />} title="No capability gaps" hint="When Creator cannot honestly perform a requested action, it will leave the gap here without pretending it ran." />
        ) : (
          <div className="space-y-3">
            {gaps.map((gap) => (
              <Card key={gap.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={gap.status === "open" ? "amber" : "neutral"}>{gap.status}</Badge>
                  <h2 className="text-[15px] font-semibold text-stone-900">{gap.title}</h2>
                  <span className="ml-auto text-xs text-stone-400">{timeAgo(gap.createdAt)}</span>
                </div>
                <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-mono text-xs leading-relaxed text-stone-600">{gap.description}</pre>
                <p className="mt-2 font-mono text-[10px] text-stone-400">gap {gap.id}</p>
              </Card>
            ))}
          </div>
        )
      )}

      {tab === "proposals" &&
      (proposals === null ? (
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
                  {p.releases.map((release) => {
                    const outcome = release.outcomes[0];
                    const evidenceRef = evidenceRefs[release.id] ?? `evidence://canary/manual/${release.id}`;
                    return (
                      <div key={release.id} className="mt-4 rounded-lg border border-violet-200 bg-violet-50/50 p-3.5 text-xs text-violet-950">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">Controlled release</span>
                          <Badge tone={release.status === "promoted" ? "green" : release.status === "rolled_back" ? "red" : "amber"}>{release.status.replace("_", " ")}</Badge>
                          {outcome && <Badge tone={outcome.verdict === "pass" ? "green" : "red"}>canary {outcome.verdict}</Badge>}
                        </div>
                        <div className="mt-2 grid gap-1 text-[11px] text-violet-900 sm:grid-cols-2">
                          <span>Artifact: <code className="break-all">{release.artifactRef}</code></span>
                          <span className="flex items-center gap-1">Digest: <code className="break-all">{release.candidateDigest.slice(0, 16)}…</code><CopyButton text={release.candidateDigest} label="Copy digest" /></span>
                          <span>Gap ticket: <code>{release.gapTicketId ?? "not linked"}</code></span>
                          {outcome && <span>Evidence: <code className="break-all">{outcome.evidenceRef}</code></span>}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {release.status === "staged" && (
                            <Button size="sm" loading={busy} onClick={() => void evolution({ action: "promote", releaseId: release.id, candidateDigest: release.candidateDigest }, "Promotion requested. The approval inbox is the authority.")}>Request promotion</Button>
                          )}
                          {release.status !== "rolled_back" && (
                            <Button size="sm" tone="dangerSecondary" loading={busy} onClick={() => void evolution({ action: "rollback", releaseId: release.id, candidateDigest: release.candidateDigest }, "Rollback requested through the governed release path.")}>Request rollback</Button>
                          )}
                          {release.status === "promoted" && !outcome && release.gapTicketId && (
                            <>
                              <input
                                aria-label="Canary evidence reference"
                                value={evidenceRef}
                                onChange={(event) => setEvidenceRefs((current) => ({ ...current, [release.id]: event.target.value }))}
                                className="min-w-56 rounded-md border border-violet-200 bg-white px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-violet-500"
                              />
                              <Button size="sm" loading={busy} onClick={() => void evolution({ action: "canary", releaseId: release.id, gapTicketId: release.gapTicketId, candidateDigest: release.candidateDigest, verdict: "pass", evidenceRef }, "Canary pass recorded as evidence; the release remains promoted.")}>Record pass</Button>
                              <Button size="sm" tone="dangerSecondary" loading={busy} onClick={() => void evolution({ action: "canary", releaseId: release.id, gapTicketId: release.gapTicketId, candidateDigest: release.candidateDigest, verdict: "fail", evidenceRef }, "Canary fail recorded as evidence; no automatic rollback occurred.")}>Record fail</Button>
                            </>
                          )}
                        </div>
                        <p className="mt-2 text-[11px] text-violet-800">Release actions request approval where required. Canary evidence never installs, executes, promotes, or rolls back source.</p>
                      </div>
                    );
                  })}
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
                  className="cursor-pointer text-xs font-medium text-gold-700 underline-offset-2 hover:underline"
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
              {p.status === "approved" && p.releases.length === 0 && p.gapTicketId && candidateDigest(p) && (
                <div className="mt-4 border-t border-stone-100 pt-4">
                  <p className="mb-2 text-xs text-stone-500">This approved candidate can enter the controlled release lane. The handoff records metadata only.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label="Artifact reference"
                      value={artifactRefs[p.id] ?? `artifact://creator/candidate/${candidateDigest(p)}`}
                      onChange={(event) => setArtifactRefs((current) => ({ ...current, [p.id]: event.target.value }))}
                      className="min-w-72 rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 font-mono text-xs text-stone-700 outline-none focus:border-maroon-500"
                    />
                    <Button size="sm" loading={busy} onClick={() => void evolution({ action: "stage", proposalId: p.id, gapTicketId: p.gapTicketId, candidateDigest: candidateDigest(p), artifactRef: artifactRefs[p.id] ?? `artifact://creator/candidate/${candidateDigest(p)}` }, "Staging requested. Review the exact digest in the Approvals inbox.")}>Request staging</Button>
                  </div>
                </div>
              )}
              {p.reviewComment && p.status !== "in_review" && (
                <p className="mt-3 border-t border-stone-100 pt-3 text-xs text-stone-500">Review note: {p.reviewComment}</p>
              )}
            </Card>
          ))}
        </div>
      ))}
    </AppFrame>
  );
}
