# ADR 0039: The understanding layer

Date: 2026-09-01
Status: Accepted (M12)

## Decision

- **explainChange is pure arithmetic** (erp-core/explainchange.ts): the
  metric delta across a dimension decomposes per key and the contributions
  sum to the delta EXACTLY — property-tested. The capability adds drill:
  sample invoice ids behind the biggest movers. The model narrates the
  decomposition; it never computes one.
- **askYourBusiness composes gated reads** (extractors, signals) and every
  section cites its rows; it ends in one proposed governed action taken
  from the signal feed's suggestedAction. The weekly/monthly review is a
  scheduled template through the existing routine system.
- **Helpdesk depth stays lite**: ticket fields on the conversation row
  (number, priority, category, SLA dueAt), canned responses and KB
  articles as two small tables, rules-first category drafts (never
  auto-applied), red SLA-breach signals.
- **Documents gain the business layer**: folder path, refType/refId links
  to the records they evidence, and expiry metadata that raises signals.
  Version history is append-only — the document row is always the latest.
