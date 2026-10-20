import type { ChatCard, ChatCardKind } from "../api/chat";
import "./WorkmateRecordCard.css";

export const CARD_KIND_LABEL: Record<ChatCardKind, string> = {
  exception: "Exception",
  progress: "Progress",
  waiting: "Waiting",
  result: "Result",
};

/** Evidence is a record, not a data table: keep the visible text bounded. */
export const EVIDENCE_MAX_CHARS = 600;
const TRUNCATION_MARK = "\u2026";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function scalarText(value: string | number | boolean | null): string {
  if (value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Flat records read best as key/value lines; nested JSON stays JSON. */
function flatRecordText(record: Record<string, unknown>): string | null {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!isScalar(value)) return null;
    lines.push(`${key}: ${scalarText(value)}`);
  }
  return lines.join("\n");
}

function evidenceSource(evidence: unknown): string {
  if (typeof evidence === "string") return evidence;
  if (isRecord(evidence)) {
    const flat = flatRecordText(evidence);
    if (flat !== null) return flat;
  }
  try {
    return JSON.stringify(evidence, null, 2) ?? String(evidence);
  } catch {
    return String(evidence);
  }
}

export function formatEvidence(evidence: unknown): string {
  const source = evidenceSource(evidence);
  if (source.length <= EVIDENCE_MAX_CHARS) return source;
  return `${source.slice(0, EVIDENCE_MAX_CHARS - 1)}${TRUNCATION_MARK}`;
}

/**
 * Read-only view of a structured tool result. Deliberately has no actions:
 * approvals stay with the proposal card, this only records what happened.
 */
export function WorkmateRecordCard({ card }: { card: ChatCard }) {
  const kindLabel = CARD_KIND_LABEL[card.kind];
  const evidence = card.evidence === undefined || card.evidence === null ? "" : formatEvidence(card.evidence);
  return (
    <section
      className={`workmate-record-card workmate-record-card-${card.kind}`}
      aria-label={`${kindLabel} record: ${card.title}`}
    >
      <header className="workmate-record-card-head">
        <p className="workmate-record-card-kind">{kindLabel}</p>
        <h3 className="workmate-record-card-title">{card.title}</h3>
      </header>
      <dl className="workmate-record-card-meta">
        <div>
          <dt>Status</dt>
          <dd>{card.status}</dd>
        </div>
        {card.severity && (
          <div>
            <dt>Severity</dt>
            <dd>{card.severity}</dd>
          </div>
        )}
      </dl>
      {card.summary && <p className="workmate-record-card-summary">{card.summary}</p>}
      {card.next && (
        <p className="workmate-record-card-next">
          <span className="workmate-record-card-next-label">Next</span>
          {card.next}
        </p>
      )}
      {evidence && (
        <pre className="workmate-record-card-evidence" aria-label={`Evidence for ${card.title}`}>
          {evidence}
        </pre>
      )}
    </section>
  );
}
