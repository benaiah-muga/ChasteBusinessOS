import { useCallback, useEffect, useMemo, useState } from "react";
import { ApprovalApiError, fetchApprovals, submitApprovalDecision, type Approval, type ApprovalList } from "../api/approvals";
import { legacyUrl } from "../legacy";
import "./ApprovalsPage.css";

type CurrencyStyle = { symbol: string; minorUnits: number };
type Notice = { tone: "success" | "error"; message: string; linkToLedger?: boolean };

const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];
const CURRENCY_STYLES: Record<string, CurrencyStyle> = {
  USD: { symbol: "$", minorUnits: 2 },
  KES: { symbol: "KSh", minorUnits: 2 },
  EUR: { symbol: "€", minorUnits: 2 },
  GBP: { symbol: "£", minorUnits: 2 },
  TZS: { symbol: "TSh", minorUnits: 0 },
  UGX: { symbol: "USh", minorUnits: 0 },
};
const SENSITIVE_KEY = /(password|secret|token|credential|base64|api[_-]?key|private[_-]?key|authorization|bearer)/i;

function currencyFor(baseCurrency: string | null): CurrencyStyle {
  let preference: string | null = null;
  try {
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("chaste_display_currency="));
    if (cookie) {
      const value = decodeURIComponent(cookie.slice("chaste_display_currency=".length));
      if (CURRENCY_PREFERENCES.includes(value)) preference = value;
    }
  } catch {
    // A blocked cookie leaves the device preference available.
  }
  if (!preference) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("chaste-prefs") ?? "null");
      if (stored && typeof stored === "object" && "currency" in stored && typeof stored.currency === "string" && CURRENCY_PREFERENCES.includes(stored.currency)) {
        preference = stored.currency;
      }
    } catch {
      // Invalid local preferences fall back to the active organization.
    }
  }
  const code = !preference || preference === "org" ? baseCurrency ?? "USD" : preference;
  return CURRENCY_STYLES[code] ?? { symbol: `${code} `, minorUnits: 2 };
}

function formatMoney(minor: number, currency: CurrencyStyle): string {
  const amount = Math.abs(minor) / 10 ** currency.minorUnits;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: currency.minorUnits,
    maximumFractionDigits: currency.minorUnits,
  });
  return `${minor < 0 ? "−" : ""}${currency.symbol}${formatted}`;
}

function friendlyError(error: unknown): string {
  if (error instanceof ApprovalApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The approvals service took too long. Try again.";
  return "Could not reach the approvals service. Check your connection and try again.";
}

function actionTitle(capabilityId: string): string {
  const action = capabilityId.split(".").at(-1) ?? capabilityId;
  return action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function previewFields(payload: unknown): Array<[string, unknown]> {
  if (!isRecord(payload)) return [];
  return Object.entries(payload)
    .filter(([key]) => !SENSITIVE_KEY.test(key) && !["intentId", "sessionId"].includes(key))
    .slice(0, 8);
}

function safePayload(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[hidden]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 497)}…` : value;
  if (depth >= 5) return "[nested details hidden]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safePayload(entry, "", depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, entry]) => [childKey, safePayload(entry, childKey, depth + 1)]));
  }
  return value;
}

function friendlyValue(key: string, value: unknown, currency: CurrencyStyle): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value) && /(amount|total|value|price|minor)/i.test(key)) {
    return Number.isSafeInteger(value) ? formatMoney(value, currency) : String(value);
  }
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isRecord(value)) return "Details available";
  return String(value);
}

function targetName(payload: unknown): string | null {
  const entry = previewFields(payload).find(([key]) => /name|title|description/i.test(key))?.[1];
  return typeof entry === "string" ? entry : null;
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return <button className="approval-copy" type="button" onClick={() => void copy()}>{copied ? "Copied" : label}</button>;
}

function ApprovalContext({ approval }: { approval: Approval }) {
  const payload = isRecord(approval.payload) ? approval.payload : {};
  if (approval.capabilityId === "harness.approveComposition") {
    const digest = typeof payload.compositionDigest === "string" ? payload.compositionDigest : null;
    return (
      <div className="approval-context approval-context-runtime">
        <div><strong>Runtime composition</strong><span>Exact profile and bundle identity must match before a durable run can mount.</span></div>
        {digest && <p>Composition digest <code>{digest}</code><CopyValueButton value={digest} label="Copy digest" /></p>}
      </div>
    );
  }
  if (approval.capabilityId.startsWith("creator.")) {
    const digest = typeof payload.candidateDigest === "string" ? payload.candidateDigest : null;
    return (
      <div className="approval-context approval-context-creator">
        <div><strong>Creator release</strong><span>Approval records a controlled artifact handoff; it does not install or execute source.</span></div>
        {digest && <p>Candidate digest <code>{digest}</code><CopyValueButton value={digest} label="Copy digest" /></p>}
      </div>
    );
  }
  return null;
}

function ApprovalCard({
  approval,
  currency,
  busy,
  onDecision,
}: {
  approval: Approval;
  currency: CurrencyStyle;
  busy: boolean;
  onDecision: (id: string, decision: "approve" | "reject") => void;
}) {
  const fields = previewFields(approval.payload);
  const name = targetName(approval.payload);
  const documents = approval.relatedDocuments ?? [];

  return (
    <article className="approval-card">
      <header className="approval-card-head">
        <span className={`approval-risk approval-risk-${approval.riskClass.toLowerCase()}`}>{approval.riskClass}</span>
        <strong>{actionTitle(approval.capabilityId)}</strong>
        {approval.raisedBy && <span className={`approval-raised approval-raised-${approval.raisedBy.kind}`} title={approval.raisedBy.kind === "agent" ? `Raised by the workmate acting for ${approval.raisedBy.name}` : "Raised by a person in your organization"}>{approval.raisedBy.kind === "agent" ? `agent · for ${approval.raisedBy.name}` : `human · ${approval.raisedBy.name}`}</span>}
        <time dateTime={approval.createdAt}>{new Date(approval.createdAt).toLocaleString()}</time>
      </header>

      <div className="approval-card-body">
        <ApprovalContext approval={approval} />
        <section className="approval-rationale" aria-label="What this does">
          <h3>What this does</h3>
          <p>{approval.rationale || `${actionTitle(approval.capabilityId)} will run after approval.`}{name && <> It relates to <strong>{name}</strong>.</>}</p>
        </section>

        {fields.length > 0 && (
          <section className="approval-preview" aria-label="Affected record preview">
            <h3>Affected record preview</h3>
            <dl>{fields.map(([key, value]) => <div key={key}><dt>{key.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}</dt><dd>{friendlyValue(key, value, currency)}</dd></div>)}</dl>
          </section>
        )}

        {documents.length > 0 && (
          <section className="approval-documents" aria-label="Related documents">
            <h3>Related documents</h3>
            <ul>{documents.map((document) => <li key={document.id}><a href={legacyUrl(`/documents?documentId=${encodeURIComponent(document.id)}`)}>{document.title}</a></li>)}</ul>
          </section>
        )}

        <details className="approval-technical">
          <summary>Technical details</summary>
          <pre>{JSON.stringify(safePayload(approval.payload), null, 2)}</pre>
        </details>

        <div className="approval-actions">
          <button className="approval-button approval-button-approve" type="button" disabled={busy} onClick={() => onDecision(approval.id, "approve")}>
            {busy ? "Saving decision" : "✓  Approve & execute"}
          </button>
          <button className="approval-button approval-button-reject" type="button" disabled={busy} onClick={() => onDecision(approval.id, "reject")}>Reject</button>
        </div>
      </div>
    </article>
  );
}

function RecentDecisions({ history }: { history: Approval[] }) {
  if (history.length === 0) return null;
  return (
    <section className="approval-history" aria-labelledby="approval-history-title">
      <header>
        <div><h2 id="approval-history-title">Recent decisions</h2><p>Approvals, rejections, and expiry history for this organization.</p></div>
        <a href={legacyUrl("/ledger")}>Open audit ledger</a>
      </header>
      <ul>
        {history.map((approval) => (
          <li key={approval.id}>
            <span className={`approval-status approval-status-${(approval.status ?? "unknown").toLowerCase()}`}>{approval.status ?? "recorded"}</span>
            <strong>{actionTitle(approval.capabilityId)}</strong>
            <span>{approval.decidedBy ? `by ${approval.decidedBy}` : "Decision recorded"}</span>
            <time dateTime={approval.decidedAt ?? approval.createdAt}>{new Date(approval.decidedAt ?? approval.createdAt).toLocaleString()}</time>
            {approval.decisionComment && <p>{approval.decisionComment}</p>}
          </li>
        ))}
      </ul>
      <p className="approval-history-note">Decision outcomes are recorded in the audit ledger. Reversal, when supported, must be made through the linked business action.</p>
    </section>
  );
}

export function ApprovalsPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [list, setList] = useState<ApprovalList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    setLoading(true);
    try {
      const result = await fetchApprovals(signal);
      if (!signal?.aborted) setList(result);
    } catch (error) {
      if (!signal?.aborted) setLoadError(friendlyError(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setNotice(null);
    try {
      await submitApprovalDecision(id, decision);
      setNotice({
        tone: "success",
        message: decision === "approve"
          ? "Approved and executed, the result is in the ledger."
          : "Rejected. The action was not executed and the decision is on record.",
        linkToLedger: decision === "approve",
      });
    } catch (error) {
      setNotice({ tone: "error", message: friendlyError(error) });
    }
    await load();
    setBusyId(null);
  }

  const approvals = list?.approvals ?? [];
  const history = list?.history ?? [];

  return (
    <main className="approvals-page" aria-labelledby="approvals-title">
      <header className="approvals-page-header">
        <div>
          <p className="approvals-eyebrow">Authority & review</p>
          <h1 id="approvals-title">Approvals</h1>
          <p>Actions that need human authority, money above thresholds, identity changes, destructive operations. Nothing executes until you decide.</p>
        </div>
        {list && approvals.length > 0 && <span className="approval-waiting-count">{approvals.length} waiting</span>}
      </header>

      {notice && <div className={`approval-notice approval-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
        <span>{notice.message}</span>{notice.linkToLedger && <> <a href={legacyUrl("/ledger")}>View in the ledger</a></>}
      </div>}

      {loadError && <div className="approval-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>Try again</button></div>}
      {loading && !list ? <p className="approval-loading" role="status">Loading approvals…</p> : list ? (
        <>
          {approvals.length === 0
            ? <section className="approval-empty"><span aria-hidden="true">✓</span><h2>Inbox zero</h2><p>The agent is within policy, nothing is waiting on your authority.</p></section>
            : <section className="approval-queue" aria-label="Pending approvals">
                {loading && <p className="approval-refreshing" role="status">Refreshing decisions…</p>}
                {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} currency={currency} busy={busyId === approval.id} onDecision={(id, decision) => void decide(id, decision)} />)}
              </section>}
          <RecentDecisions history={history} />
        </>
      ) : null}
    </main>
  );
}
