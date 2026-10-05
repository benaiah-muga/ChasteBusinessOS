import { useCallback, useEffect, useMemo, useState } from "react";
import "./ProposalsPage.css";
import {
  fetchCapabilityGaps,
  fetchCreatorAgent,
  fetchCreatorEnabled,
  fetchProposals,
  ProposalsApiError,
  submitEvolutionAction,
  submitProposalReview,
  verifyCandidateEvidence,
  type AgentStatus,
  type CapabilityGap,
  type CreatorProposal,
  type EvolutionAction,
} from "../api/proposals";
import "./ProposalsPage.css";

const styles = `
.cp-page { width: min(100% - 48px, 1320px); margin: 0 auto; padding: clamp(30px, 5vw, 56px) 0 68px; color: #354137; }
.cp-header { margin-bottom: 20px; }
.cp-eyebrow { margin: 0 0 7px; color: #927b4d; font-size: 9px; font-weight: 750; letter-spacing: .15em; text-transform: uppercase; }
.cp-header h1 { margin: 0 0 8px; color: #29372d; font-family: Georgia, "Times New Roman", serif; font-size: clamp(32px, 4vw, 44px); font-weight: 500; letter-spacing: -.045em; }
.cp-header p:last-child { margin: 0; max-width: 760px; color: #777970; font-size: 12px; line-height: 1.65; }
.cp-tabs { display: flex; gap: 5px; overflow-x: auto; margin-bottom: 16px; border-bottom: 1px solid #e7e4da; }
.cp-tab { flex: 0 0 auto; min-height: 38px; border: 0; border-radius: 5px 5px 0 0; padding: 0 13px; background: transparent; color: #777970; cursor: pointer; font: inherit; font-size: 11px; font-weight: 650; }
.cp-tab span { margin-left: 7px; border-radius: 99px; padding: 2px 6px; background: #efeee9; font-size: 9px; }
.cp-tab[aria-selected=true] { border-bottom: 2px solid #927b4d; color: #34483a; }
.cp-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 14px; border: 1px solid; border-radius: 8px; padding: 10px 13px; font-size: 11px; }
.cp-notice-success { border-color: #cfdfce; background: #f1f7ef; color: #476346; }
.cp-notice-pending { border-color: #eadcad; background: #fbf7e9; color: #796439; }
.cp-notice-error { border-color: #e7c8c0; background: #fff7f4; color: #8c4c40; }
.cp-notice button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 10px; opacity: .75; }
.cp-panel { min-width: 0; border: 1px solid #e5e3da; border-radius: 10px; padding: 15px; background: #fffefa; box-shadow: 0 6px 19px rgb(44 40 29 / 3%); }
.cp-stack { display: grid; gap: 13px; }
.cp-panel-head { display: flex; flex-wrap: align-items: center; gap: 9px; margin-bottom: 9px; }
.cp-panel-head h2 { margin: 0; color: #2c3930; font-size: 12px; font-weight: 700; }
.cp-panel-head time { margin-left: auto; color: #989991; font-size: 9px; white-space: nowrap; }
.cp-summary { margin: 0 0 12px; color: #5f655d; font-size: 11px; line-height: 1.65; }
.cp-badge { display: inline-block; border-radius: 99px; padding: 2px 7px; background: #f0efe7; color: #75776d; font-size: 8px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
.cp-badge-green { background: #e6f0e5; color: #456b47; }
.cp-badge-red { background: #fae8e4; color: #8c4c40; }
.cp-badge-amber { background: #f7efd9; color: #8a6f34; }
.cp-badge-neutral { background: #f0efe7; color: #75776d; }
.cp-verify { display: flex; align-items: flex-start; gap: 7px; margin: 9px 0 0; border-radius: 7px; padding: 8px 10px; font-size: 10px; line-height: 1.6; overflow-wrap: anywhere; }
.cp-verify-verified { border: 1px solid #cfe0cd; background: #f2f8f0; color: #466a48; }
.cp-verify-unverified { border: 1px solid #e7c8c0; background: #fff7f4; color: #8c4c40; }
.cp-verify strong { flex: 0 0 auto; }
.cp-toggle { margin-top: 10px; border: 0; padding: 0; background: transparent; color: #927b4d; cursor: pointer; font: inherit; font-size: 10px; font-weight: 650; text-decoration: underline; text-underline-offset: 2px; }
.cp-toggle:hover { color: #6d5a2f; }
.cp-diff { overflow-x: auto; margin: 10px 0 0; border-radius: 8px; padding: 11px 0; background: #24262b; color: #d5d8dc; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.6; }
.cp-diff div { padding: 0 13px; white-space: pre; }
.cp-diff-added { background: rgb(16 185 129 / 15%); color: #86efac; }
.cp-diff-removed { background: rgb(239 68 68 / 15%); color: #fca5a5; }
.cp-diff-meta { color: #7dd3fc; }
.cp-evidence { margin: 11px 0 0; border-radius: 7px; padding: 9px 11px; font-size: 10px; line-height: 1.65; overflow-wrap: anywhere; }
.cp-evidence-evidence { border: 1px solid #c8dcec; background: #f1f7fb; color: #2f5878; }
.cp-evidence-risk { border: 1px solid #e6d3a8; background: #fdf7e9; color: #7a6027; }
.cp-release { margin-top: 13px; border: 1px solid #ddd2ee; border-radius: 8px; padding: 11px; background: #f8f5fd; color: #453063; font-size: 10px; }
.cp-release-head { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.cp-release-head strong { font-size: 10px; }
.cp-release-facts { display: grid; gap: 4px; margin: 9px 0 0; font-size: 9px; }
.cp-release-facts div { display: flex; flex-wrap: wrap; gap: 5px; }
.cp-release-facts span:first-child { color: #6f5f8c; }
.cp-release code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.cp-release-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 11px; }
.cp-release-actions input { min-width: 230px; flex: 1; min-height: 32px; border: 1px solid #ddd2ee; border-radius: 6px; padding: 5px 8px; background: #fff; color: #3f3355; font: inherit; font-size: 10px; }
.cp-release-note { margin: 9px 0 0; color: #6b5b86; font-size: 9px; line-height: 1.6; }
.cp-lane { margin-top: 13px; border-top: 1px solid #efede7; padding-top: 12px; }
.cp-lane p { margin: 0 0 8px; color: #6a6f66; font-size: 10px; line-height: 1.6; }
.cp-lane input { min-width: 290px; flex: 1; min-height: 32px; border: 1px solid #dfddd4; border-radius: 6px; padding: 5px 8px; background: #f8f7f2; color: #41483f; font: inherit; font-size: 10px; }
.cp-review-note { margin: 11px 0 0; border-top: 1px solid #efede7; padding-top: 10px; color: #777970; font-size: 10px; }
.cp-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 13px; border-top: 1px solid #efede7; padding-top: 13px; }
.cp-page button { min-height: 33px; border: 1px solid #dfddd4; border-radius: 6px; padding: 0 11px; background: #fffefa; color: #596157; cursor: pointer; font: inherit; font-size: 10px; font-weight: 650; }
.cp-page button:disabled { cursor: wait; opacity: .55; }
.cp-page button:not(:disabled):hover { border-color: #c7b780; background: #faf7ed; }
.cp-page button.cp-danger { border-color: #e3c6be; color: #8c4c40; }
.cp-copy { min-height: 24px !important; border: 0 !important; padding: 0 5px !important; background: transparent !important; color: #6f5f8c !important; font-size: 9px !important; }
.cp-error { border: 1px solid #e7c8c0; border-radius: 9px; padding: 15px; background: #fff7f4; color: #8c4c40; }
.cp-error h2 { margin: 0 0 6px; font-family: Georgia, "Times New Roman", serif; font-size: 18px; font-weight: 500; }
.cp-error p { margin: 0 0 10px; font-size: 11px; line-height: 1.6; }
.cp-disabled { border: 1px solid #e5e3da; border-radius: 12px; padding: 22px; background: #fffefa; }
.cp-disabled h2 { margin: 0 0 6px; font-family: Georgia, "Times New Roman", serif; font-size: 20px; font-weight: 500; }
.cp-disabled p { margin: 0; color: #777970; font-size: 11px; line-height: 1.6; }
.cp-empty { padding: 18px 5px; color: #92938a; font-size: 11px; line-height: 1.6; text-align: center; }
.cp-empty span { display: block; margin-bottom: 6px; font-size: 16px; }
.cp-gap { display: grid; gap: 8px; border: 1px solid #e5e3da; border-radius: 9px; padding: 13px; background: #fffefa; }
.cp-gap-head { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.cp-gap-head h2 { margin: 0; color: #2c3930; font-size: 12px; font-weight: 700; }
.cp-gap pre { max-height: 210px; overflow: auto; margin: 0; border-radius: 7px; padding: 10px; background: #f8f7f2; color: #5f655d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.6; white-space: pre-wrap; }
.cp-gap-id { margin: 0; color: #a09f96; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
.cp-agent-ready { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin: 0 0 14px; border: 1px solid #cfe0cd; border-radius: 9px; padding: 12px 14px; background: #f2f8f0; color: #466a48; font-size: 11px; }
.cp-agent-ready small { width: 100%; color: #5e7d5f; font-size: 9px; }
.cp-agent-setup { margin-bottom: 14px; border: 1px solid #e5e3da; border-radius: 10px; padding: 15px; background: #fffefa; }
.cp-agent-setup h2 { display: flex; align-items: center; gap: 7px; margin: 0 0 6px; color: #2c3930; font-size: 12px; font-weight: 700; }
.cp-agent-setup > p { margin: 0; max-width: 720px; color: #6a6f66; font-size: 11px; line-height: 1.65; }
.cp-agent-steps { display: grid; gap: 9px; margin: 12px 0 0; padding: 0; list-style: none; font-size: 11px; }
.cp-agent-steps li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: #5f655d; }
.cp-agent-steps b { display: grid; width: 20px; height: 20px; flex: 0 0 auto; place-items: center; border-radius: 50%; background: #f5edd9; color: #8a6f34; font-size: 10px; }
.cp-agent-steps code { border-radius: 5px; padding: 3px 7px; background: #f1f0ea; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; overflow-wrap: anywhere; }
.cp-agent-steps button { min-height: 26px !important; }
.cp-wait { color: #777970; font-size: 11px; }
@media (max-width: 560px) { .cp-page { width: min(100% - 28px, 1320px); padding-top: 27px; } .cp-release-actions input, .cp-lane input { min-width: 100%; } }
`;

const styleTag = <style>{styles}</style>;

type Tab = "proposals" | "gaps" | "setup";
type Notice = { tone: "success" | "pending" | "error"; message: string };
/** Every governed write answers completed or pending; pending is not a failure. */
type GovernedOutcome = { kind: "pending"; reason: string } | { kind: "completed"; data: unknown };
type ModuleState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; enabled: boolean };
type ProposalState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; proposals: CreatorProposal[] };
type GapState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; gaps: CapabilityGap[] };

const tabs: { id: Tab; label: string }[] = [
  { id: "proposals", label: "Proposals" },
  { id: "gaps", label: "Capability gaps" },
  { id: "setup", label: "Setup" },
];

function messageFor(error: unknown): string {
  if (error instanceof ProposalsApiError) return error.message;
  return "Could not reach the Creator service. Check your connection and try again.";
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "just now";
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusTone(status: string): "green" | "red" | "amber" | "neutral" {
  const value = status.toLowerCase();
  if (/(executed|parsed|approved|merged|posted|paid|balanced|won)/.test(value)) return "green";
  if (/(failed|rejected|voided|lost|unbalanced|blocked)/.test(value)) return "red";
  if (/(draft|pending|in_review|review|open)/.test(value)) return "amber";
  return "neutral";
}

function humanStatus(status: string): string {
  return status.replace("_", " ");
}

function Diff({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <pre className="cp-diff">
      {lines.map((line, index) => {
        const added = line.startsWith("+") && !line.startsWith("+++");
        const removed = line.startsWith("-") && !line.startsWith("---");
        const meta = line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index ");
        const className = added ? "cp-diff-added" : removed ? "cp-diff-removed" : meta ? "cp-diff-meta" : undefined;
        return <div key={index} className={className}>{line || " "}</div>;
      })}
    </pre>
  );
}

function CopyDigest({ value, label = "Copy digest" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cp-copy"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/**
 * Creator-mode onboarding: detect an installed coding agent, or walk the human
 * through installing one. The app never runs the install itself, it only hands
 * over the command and verifies afterwards.
 */
function AgentSetupCard() {
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setChecking(true);
    const status = await fetchCreatorAgent(signal);
    if (signal?.aborted) return;
    setAgent(status);
    if (!signal) setChecking(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);

  if (!agent) return null;
  if (agent.installed) {
    return (
      <p className="cp-agent-ready">
        <strong>{agent.label}</strong>
        <span>is connected{agent.version ? ` · ${agent.version}` : ""}. Switch on Creator mode in the console and ask it for an improvement.</span>
        {agent.agents.length > 1 && (
          <small>
            Also detected:{" "}
            {agent.agents
              .filter((entry) => entry.label !== agent.label)
              .map((entry) => `${entry.label}${entry.version ? ` (${entry.version})` : entry.viaBinary ? "" : " (config only)"}`)
              .join(" · ")}
          </small>
        )}
      </p>
    );
  }

  const first = agent.candidates[0];
  return (
    <section className="cp-agent-setup" aria-labelledby="cp-agent-setup-heading">
      <h2 id="cp-agent-setup-heading">Connect a coding agent to use Creator mode</h2>
      <p>
        Creator mode works by an agent proposing changes as reviewed diffs. No supported coding CLI
        {agent.candidates.map((candidate) => ` ${candidate.label}`).join(" ·")} was found on this machine&apos;s PATH.
        Install one: you only leave the app to sign in with the vendor.
      </p>
      <ol className="cp-agent-steps">
        <li><b>1</b><span>Install {first?.label ?? "an agent"}:</span><code>{first?.install}</code><CopyDigest value={first?.install ?? ""} label="Copy install command" /></li>
        <li><b>2</b><span>{first?.authNote}</span></li>
        <li><b>3</b><button type="button" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button></li>
      </ol>
    </section>
  );
}

export function ProposalsPage() {
  const [moduleState, setModuleState] = useState<ModuleState>({ status: "loading" });
  const [proposalState, setProposalState] = useState<ProposalState>({ status: "loading" });
  const [gapState, setGapState] = useState<GapState>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("proposals");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [artifactRefs, setArtifactRefs] = useState<Record<string, string>>({});
  const [evidenceRefs, setEvidenceRefs] = useState<Record<string, string>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setProposalState({ status: "loading" });
    try {
      const proposals = await fetchProposals(signal);
      if (!signal?.aborted) setProposalState({ status: "ready", proposals });
    } catch (error) {
      if (!signal?.aborted) setProposalState({ status: "failed", message: messageFor(error) });
    }
  }, []);

  const loadGaps = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setGapState({ status: "loading" });
    try {
      const gaps = await fetchCapabilityGaps(signal);
      if (!signal?.aborted) setGapState({ status: "ready", gaps });
    } catch (error) {
      if (!signal?.aborted) setGapState({ status: "failed", message: messageFor(error) });
    }
  }, []);

  const loadModules = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setModuleState({ status: "loading" });
    try {
      const enabled = await fetchCreatorEnabled(signal);
      if (signal?.aborted) return;
      setModuleState({ status: "ready", enabled });
      if (!enabled) {
        setProposalState({ status: "ready", proposals: [] });
        setGapState({ status: "ready", gaps: [] });
        return;
      }
      await load(signal);
      await loadGaps(signal);
    } catch (error) {
      if (signal?.aborted) return;
      setModuleState({ status: "failed", message: messageFor(error) });
    }
  }, [load, loadGaps]);

  useEffect(() => {
    const controller = new AbortController();
    void loadModules(controller.signal);
    return () => controller.abort();
  }, [loadModules]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    const known = (value: string | null): Tab | null => (value && tabs.some((entry) => entry.id === value) ? (value as Tab) : null);
    const target = known(requested) ?? (requested ? null : known(window.localStorage.getItem("chaste-app-tab:proposals")));
    if (target) setTab(target);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("chaste-app-tab:proposals", tab);
    } catch {
      // Session-only memory when storage is unavailable.
    }
  }, [tab]);

  async function run(send: () => Promise<GovernedOutcome>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await send();
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", message: outcome.reason });
        return false;
      }
      await load();
      return true;
    } catch (error) {
      setNotice({ tone: "error", message: messageFor(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function review(id: string, decision: "approved" | "rejected"): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await submitProposalReview({ proposalId: id, decision });
      if (outcome.kind === "pending") setNotice({ tone: "pending", message: outcome.reason });
      else setNotice({ tone: "success", message: outcome.note });
      await load();
    } catch (error) {
      setNotice({ tone: "error", message: messageFor(error) });
    } finally {
      setBusy(false);
    }
  }

  async function evolution<Action extends EvolutionAction>(input: Action, completedText: string): Promise<boolean> {
    const accepted = await run(async (): Promise<GovernedOutcome> => {
      const outcome = await submitEvolutionAction(input);
      if (outcome.kind === "pending") {
        return { kind: "pending", reason: `Approval requested. Review it in the Approvals inbox before anything changes. ${outcome.reason}` };
      }
      return { kind: "completed", data: outcome.data };
    });
    if (accepted) setNotice({ tone: "success", message: completedText });
    return accepted;
  }

  const proposals = proposalState.status === "ready" ? proposalState.proposals : [];
  const openGapCount = gapState.status === "ready" ? gapState.gaps.filter((gap) => gap.status === "open").length : undefined;

  if (moduleState.status === "loading") {
    return <main className="cp-page">{styleTag}<p className="cp-wait" role="status">Checking whether Creator mode is available…</p></main>;
  }
  if (moduleState.status === "failed") {
    return (
      <main className="cp-page">
        {styleTag}
        <header className="cp-header"><p className="cp-eyebrow">Workspace settings unavailable</p><h1>Could not check Creator mode</h1></header>
        <section className="cp-error" role="alert"><h2>Creator mode is unavailable</h2><p>{moduleState.message}</p><button type="button" onClick={() => void loadModules()}>Try again</button></section>
      </main>
    );
  }
  if (!moduleState.enabled) {
    return (
      <main className="cp-page">
        {styleTag}
        <header className="cp-header"><p className="cp-eyebrow">Creator Mode</p><h1>Creator proposals</h1></header>
        <section className="cp-disabled">
          <h2>Proposals are disabled</h2>
          <p>This module is switched off for your organization. An org admin can re-enable it under Team &amp; roles → Modules.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="cp-page">
      {styleTag}
      <header className="cp-header">
        <p className="cp-eyebrow">Creator Mode</p>
        <h1>Creator proposals</h1>
        <p>
          When you enable Creator Mode in the console, the agent can propose changes to this platform itself.
          Nothing merges automatically: your approval records the decision and the diff lands through a normal
          pull request where CI verifies it again.
        </p>
      </header>

      <div className="cp-tabs" role="tablist" aria-label="Creator mode sections">
        {tabs.map((entry) => {
          const count = entry.id === "proposals" ? (proposalState.status === "ready" ? proposals.length : 0) : entry.id === "gaps" ? (openGapCount ?? 0) : 0;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`cp-${entry.id}-tab`}
              aria-selected={tab === entry.id}
              aria-controls={`cp-${entry.id}-panel`}
              tabIndex={tab === entry.id ? 0 : -1}
              className="cp-tab"
              onClick={() => setTab(entry.id)}
            >
              {entry.label}{count > 0 && <span>{count}</span>}
            </button>
          );
        })}
      </div>

      {notice && (
        <div className={`cp-notice cp-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div role="tabpanel" id={`cp-${tab}-panel`} aria-labelledby={`cp-${tab}-tab`} tabIndex={0}>
        {tab === "setup" && <AgentSetupCard />}

        {tab === "gaps" && (
          gapState.status === "loading"
            ? <p className="cp-wait" role="status">Loading capability gaps…</p>
            : gapState.status === "failed"
              ? <section className="cp-error" role="alert"><h2>Could not load capability gaps</h2><p>{gapState.message}</p><button type="button" onClick={() => void loadGaps()}>Try again</button></section>
              : gapState.gaps.length === 0
                ? <p className="cp-empty"><span aria-hidden="true">✓</span>No capability gaps. When Creator cannot honestly perform a requested action, it leaves the gap here without pretending it ran.</p>
                : (
                  <div className="cp-stack">
                    {gapState.gaps.map((gap) => (
                      <article className="cp-gap" key={gap.id}>
                        <div className="cp-gap-head">
                          <span className={`cp-badge ${gap.status === "open" ? "cp-badge-amber" : "cp-badge-neutral"}`}>{gap.status}</span>
                          <h2>{gap.title}</h2>
                          <time dateTime={gap.createdAt}>{timeAgo(gap.createdAt)}</time>
                        </div>
                        <pre>{gap.description}</pre>
                        <p className="cp-gap-id">gap {gap.id}</p>
                      </article>
                    ))}
                  </div>
                )
        )}

        {tab === "proposals" && (
          proposalState.status === "loading"
            ? <p className="cp-wait" role="status">Loading proposals…</p>
            : proposalState.status === "failed"
              ? <section className="cp-error" role="alert"><h2>Could not load proposals</h2><p>{proposalState.message}</p><button type="button" onClick={() => void load()}>Try again</button></section>
              : proposals.length === 0
                ? <p className="cp-empty"><span aria-hidden="true">⑂</span>No proposals yet. Switch on Creator mode in the Console and ask for an improvement; proposed changes arrive here for human review.</p>
                : (
                  <div className="cp-stack">
                    {proposals.map((proposal) => {
                      const verification = verifyCandidateEvidence(proposal.testEvidence);
                      const proposalGapTicketId = proposal.gapTicketId;
                      const expanded = openId === proposal.id;
                      return (
                        <article className="cp-panel" key={proposal.id}>
                          <div className="cp-panel-head">
                            <span className={`cp-badge cp-badge-${statusTone(proposal.status)}`}>{humanStatus(proposal.status)}</span>
                            <h2>{proposal.title}</h2>
                            <time dateTime={proposal.createdAt} title={new Date(proposal.createdAt).toLocaleString()}>{timeAgo(proposal.createdAt)}</time>
                          </div>
                          <p className="cp-summary">{proposal.summary}</p>

                          <p className={`cp-verify ${verification.state === "verified" ? "cp-verify-verified" : "cp-verify-unverified"}`}>
                            <strong>{verification.state === "verified" ? "Evidence verified." : "Evidence not verified."}</strong>
                            <span>
                              {verification.state === "verified"
                                ? `The candidate ran in isolation against baseline ${verification.evidence.baselineCommit} with no production credentials, across ${verification.evidence.files.length} file${verification.evidence.files.length === 1 ? "" : "s"}. Digest ${verification.digest.slice(0, 16)}… is the only artifact this release may reference.`
                                : verification.reason}
                            </span>
                          </p>

                          {expanded && (
                            <>
                              <Diff text={proposal.diffText} />
                              {proposal.testEvidence && (
                                <p className="cp-evidence cp-evidence-evidence"><strong>Test evidence.</strong> {proposal.testEvidence}</p>
                              )}
                              {proposal.riskAssessment && (
                                <p className="cp-evidence cp-evidence-risk"><strong>Risk assessment.</strong> {proposal.riskAssessment}</p>
                              )}
                              {proposal.releases.map((release) => {
                                const outcome = release.outcomes[0];
                                const releaseGapTicketId = release.gapTicketId;
                                const evidenceRef = evidenceRefs[release.id] ?? `evidence://canary/manual/${release.id}`;
                                return (
                                  <div className="cp-release" key={release.id}>
                                    <div className="cp-release-head">
                                      <strong>Controlled release</strong>
                                      <span className={`cp-badge ${release.status === "promoted" ? "cp-badge-green" : release.status === "rolled_back" ? "cp-badge-red" : "cp-badge-amber"}`}>{humanStatus(release.status)}</span>
                                      {outcome && <span className={`cp-badge ${outcome.verdict === "pass" ? "cp-badge-green" : "cp-badge-red"}`}>canary {outcome.verdict}</span>}
                                    </div>
                                    <div className="cp-release-facts">
                                      <div><span>Artifact:</span><code>{release.artifactRef}</code></div>
                                      <div><span>Digest:</span><code>{release.candidateDigest.slice(0, 16)}…</code><CopyDigest value={release.candidateDigest} /></div>
                                      <div><span>Gap ticket:</span><code>{releaseGapTicketId ?? "not linked"}</code></div>
                                      {outcome && <div><span>Evidence:</span><code>{outcome.evidenceRef}</code></div>}
                                    </div>
                                    <div className="cp-release-actions">
                                      {release.status === "staged" && (
                                        <button type="button" disabled={busy} onClick={() => void evolution({ action: "promote", releaseId: release.id, candidateDigest: release.candidateDigest }, "Promotion recorded. The approval inbox remains the authority and the digest is unchanged.") }>Request promotion</button>
                                      )}
                                      {release.status !== "rolled_back" && (
                                        <button type="button" className="cp-danger" disabled={busy} onClick={() => void evolution({ action: "rollback", releaseId: release.id, candidateDigest: release.candidateDigest }, "Rollback recorded through the governed release path. The proposal and its digest are untouched.") }>Request rollback</button>
                                      )}
                                      {release.status === "promoted" && !outcome && releaseGapTicketId && (
                                        <>
                                          <label className="sr-only" htmlFor={`cp-evidence-${release.id}`}>Canary evidence reference</label>
                                          <input id={`cp-evidence-${release.id}`} aria-label="Canary evidence reference" value={evidenceRef} onChange={(event) => setEvidenceRefs((current) => ({ ...current, [release.id]: event.currentTarget.value }))} />
                                          <button type="button" disabled={busy} onClick={() => void evolution({ action: "canary", releaseId: release.id, gapTicketId: releaseGapTicketId, candidateDigest: release.candidateDigest, verdict: "pass", evidenceRef }, "Canary pass recorded as evidence; the release remains promoted.") }>Record pass</button>
                                          <button type="button" className="cp-danger" disabled={busy} onClick={() => void evolution({ action: "canary", releaseId: release.id, gapTicketId: releaseGapTicketId, candidateDigest: release.candidateDigest, verdict: "fail", evidenceRef }, "Canary fail recorded as evidence; no automatic rollback occurred.") }>Record fail</button>
                                        </>
                                      )}
                                    </div>
                                    <p className="cp-release-note">Release actions request approval where required. Canary evidence never installs, executes, promotes, or rolls back source.</p>
                                  </div>
                                );
                              })}
                              <button type="button" className="cp-toggle" onClick={() => setOpenId(null)}>Hide diff &amp; evidence</button>
                            </>
                          )}

                          {!expanded && (
                            <button type="button" className="cp-toggle" onClick={() => setOpenId(proposal.id)}>Show diff &amp; evidence</button>
                          )}

                          {proposal.status === "in_review" && (
                            <div className="cp-actions">
                              <button type="button" disabled={busy} onClick={() => void review(proposal.id, "approved")}>Approve → open PR</button>
                              <button type="button" className="cp-danger" disabled={busy} onClick={() => void review(proposal.id, "rejected")}>Reject</button>
                            </div>
                          )}

                          {proposal.status === "approved" && proposal.releases.length === 0 && proposalGapTicketId && (
                            <div className="cp-lane">
                              {verification.state === "verified" ? (
                                <>
                                  <p>This approved candidate can enter the controlled release lane. The handoff records metadata only: the exact verified digest and an immutable artifact reference.</p>
                                  <div className="cp-release-actions">
                                    <label className="sr-only" htmlFor={`cp-artifact-${proposal.id}`}>Artifact reference</label>
                                    <input
                                      id={`cp-artifact-${proposal.id}`}
                                      aria-label="Artifact reference"
                                      value={artifactRefs[proposal.id] ?? `artifact://creator/candidate/${verification.digest}`}
                                      onChange={(event) => setArtifactRefs((current) => ({ ...current, [proposal.id]: event.currentTarget.value }))}
                                    />
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void evolution(
                                        { action: "stage", proposalId: proposal.id, gapTicketId: proposalGapTicketId, candidateDigest: verification.digest, artifactRef: artifactRefs[proposal.id] ?? `artifact://creator/candidate/${verification.digest}` },
                                        "Candidate staged for controlled release. Nothing was installed or executed.",
                                      )}
                                    >
                                      Request staging
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <p>
                                  <span>This approved candidate cannot enter the controlled release lane, and it is not offered as verified. </span>
                                  <span>{verification.reason} </span>
                                  <span>The server refuses staging until the proposal carries isolated candidate evidence that verifies against its own digest.</span>
                                </p>
                              )}
                            </div>
                          )}

                          {proposal.reviewComment && proposal.status !== "in_review" && (
                            <p className="cp-review-note">Review note: {proposal.reviewComment}</p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )
        )}
      </div>
    </main>
  );
}