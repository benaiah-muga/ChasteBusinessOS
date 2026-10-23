import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalApiError, fetchApprovals, submitApprovalDecision, type Approval, type ApprovalList } from "../api/approvals";
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

function moneyHint(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  for (const key of ["totalMinor", "amountMinor", "total", "amount"]) {
    if (typeof payload[key] === "number" && Number.isSafeInteger(payload[key])) return payload[key];
  }
  if (Array.isArray(payload.lines)) {
    let total = 0;
    for (const line of payload.lines) {
      if (!isRecord(line)) continue;
      const quantity = typeof line.quantity === "number" ? line.quantity : 0;
      const unitPrice = typeof line.unitPriceMinor === "number" ? line.unitPriceMinor : 0;
      if (quantity > 0 && unitPrice > 0) total += Math.round((quantity * unitPrice) / 1000);
    }
    if (total > 0) return total;
  }
  return null;
}

const APPROVAL_REVERSALS: Record<string, string> = {
  "accounting.createInvoice": "credit note or reversing entry",
  "accounting.recordPayment": "reverse payment",
  "accounting.createQuote": "void quote",
  "purchasing.createBill": "reversing entry",
  "purchasing.payBill": "reverse vendor payment",
  "inventory.adjustStock": "reverse stock adjustment",
  "inventory.createTransfer": "reverse transfer",
  "iam.createRole": "human identity review",
  "crm.mergeCustomers": "restore prior customer record",
};

function approvalPlan(capabilityId: string, payload: unknown, currency: CurrencyStyle): string[] {
  const amount = moneyHint(payload);
  const money = amount === null ? null : formatMoney(amount, currency);
  switch (capabilityId) {
    case "accounting.createInvoice":
      return [
        `Issue an invoice${money ? ` for ${money}` : ""} to the named customer.`,
        "Projected ledger direction: debit accounts receivable, credit revenue and any tax.",
        "The invoice posts only after this approval.",
      ];
    case "accounting.recordPayment":
      return [
        `Record a payment${money ? ` of ${money}` : ""} against the invoice.`,
        "Projected ledger direction: debit cash, credit accounts receivable.",
        "The payment posts only after this approval.",
      ];
    case "purchasing.createBill":
      return [
        `Enter a supplier bill${money ? ` for ${money}` : ""}.`,
        "Projected ledger direction: debit the expense or inventory account, credit accounts payable.",
        "The bill posts only after this approval.",
      ];
    case "purchasing.payBill":
      return [
        `Pay a supplier bill${money ? ` for ${money}` : ""}.`,
        "Projected ledger direction: debit accounts payable, credit cash.",
        "The payment posts only after this approval.",
      ];
    case "inventory.adjustStock":
      return [
        "Write a stock movement for the named SKU and quantity.",
        "Stock value and any linked valuation summary update only after this approval.",
      ];
    case "inventory.createTransfer":
      return [
        "Move stock between the named locations.",
        "Both location balances update only after this approval.",
      ];
    case "iam.createRole":
      return [
        "Create an organization role with the supplied permission keys.",
        "Identity changes always require human authority and are audited.",
      ];
    default:
      return [
        `${actionTitle(capabilityId)} will run with the payload shown below.`,
        "The executor records a receipt and the inverse action when it commits.",
      ];
  }
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

        <section className="approval-plan" aria-label="Execution plan">
          <h3>Execution plan</h3>
          <ol>{approvalPlan(approval.capabilityId, approval.payload, currency).map((step) => <li key={step}>{step}</li>)}</ol>
          <p><strong>Reversible by:</strong> {APPROVAL_REVERSALS[approval.capabilityId] ?? "no automatic inverse is declared; a person must correct it"}. <strong>Policy:</strong> risk class {approval.riskClass}; the decision and receipt are recorded in the audit ledger.</p>
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
            <ul>{documents.map((document) => <li key={document.id}><a href={`/documents?documentId=${encodeURIComponent(document.id)}`}>{document.title}</a></li>)}</ul>
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
        <a href="/ledger">Open audit ledger</a>
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

export function ApprovalsPage({ baseCurrency = null, organizationId = null }: { baseCurrency?: string | null; organizationId?: string | null }) {
  const [list, setList] = useState<{ organizationId: string; data: ApprovalList } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const listRequestGeneration = useRef(0);
  const currentOrganizationId = useRef(organizationId);
  currentOrganizationId.current = organizationId?.trim() || null;
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const scope = organizationId?.trim() ?? "";
    if (scope !== (currentOrganizationId.current?.trim() ?? "")) return;
    const generation = ++listRequestGeneration.current;
    setLoadError(null);
    setLoading(true);
    try {
      const result = await fetchApprovals(organizationId, signal);
      if (!signal?.aborted && generation === listRequestGeneration.current && currentOrganizationId.current === scope) {
        setList({ organizationId: scope, data: result });
      }
    } catch (error) {
      if (!signal?.aborted && generation === listRequestGeneration.current && currentOrganizationId.current === scope) setLoadError(friendlyError(error));
    } finally {
      if (!signal?.aborted && generation === listRequestGeneration.current && currentOrganizationId.current === scope) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    setList(null);
    setNotice(null);
    setBusyId(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, organizationId]);

  async function decide(id: string, decision: "approve" | "reject") {
    const scope = organizationId;
    setBusyId(id);
    setNotice(null);
    try {
      const result = await submitApprovalDecision(id, decision, scope);
      if (currentOrganizationId.current === scope) {
        setList((current) => current?.organizationId === scope
          ? { ...current, data: { ...current.data, approvals: current.data.approvals.filter((approval) => approval.id !== id) } }
          : current);
        setNotice({
          tone: "success",
          message: decision === "reject"
            ? "Rejected. The action was not executed and the decision is on record."
            : result.status === "executed"
              ? "Approved and executed, the result is in the ledger."
              : "Approved. The follow-on action is waiting for another approval.",
          linkToLedger: decision === "approve" && result.status === "executed",
        });
      }
    } catch (error) {
      if (currentOrganizationId.current === scope) setNotice({ tone: "error", message: friendlyError(error) });
    }
    if (currentOrganizationId.current === scope) await load();
    if (currentOrganizationId.current === scope) setBusyId(null);
  }

  const scopedList = list?.organizationId === (organizationId?.trim() ?? "") ? list.data : null;
  const approvals = scopedList?.approvals ?? [];
  const history = scopedList?.history ?? [];

  return (
    <main className="approvals-page" aria-labelledby="approvals-title">
      <header className="approvals-page-header">
        <div>
          <p className="approvals-eyebrow">Authority & review</p>
          <h1 id="approvals-title">Approvals</h1>
          <p>Actions that need human authority, money above thresholds, identity changes, destructive operations. Nothing executes until you decide.</p>
        </div>
        {scopedList && approvals.length > 0 && <span className="approval-waiting-count">{approvals.length} waiting</span>}
      </header>

      {notice && <div className={`approval-notice approval-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
        <span>{notice.message}</span>{notice.linkToLedger && <> <a href="/ledger">View in the ledger</a></>}
      </div>}

      {loadError && <div className="approval-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>Try again</button></div>}
      {loading && !scopedList ? <p className="approval-loading" role="status">Loading approvals…</p> : scopedList ? (
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
