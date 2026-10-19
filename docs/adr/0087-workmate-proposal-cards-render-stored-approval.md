# ADR 0087: Workmate proposal cards render the stored approval payload

Status: accepted

## Context

When an agent prepares a purchase order, the model can describe the vendor,
lines, quantities, and total in its reply. That prose is useful, but it is not
the thing a human is authorizing. The approval row stores the exact parsed
input and its hash. If a card rendered the model's version instead, a renamed
line, a changed quantity, or a different vendor could be approved under a
misleading summary.

The chat stream also carries only tool names today. A pending approval would
otherwise appear as a generic tool chip, and the user would have to leave the
conversation for the approvals inbox.

## Decision

- Stream a `tool_result` frame for executor calls with the capability name,
  success flag, pending-approval flag, approval ID, and approval rationale. Do
  not stream the full tool payload or model-generated proposal text.
- Render a proposal card in the conversation when the frame carries a pending
  approval. The card fetches the stored approval by ID and renders the parsed
  `purchasing.createPurchaseOrder` payload: vendor, memo, promised date, lines,
  quantities, unit prices, line totals, and commitment total.
- Treat vendor name and base currency as presentation data. Fetch them from the
  purchasing workspace, but fall back to the stored vendor ID and USD if that
  read is unavailable, so a read failure cannot hide the approval itself.
- Decide with `submitApprovalDecision` using the approval ID and the active
  organization. An approval that is not `pending` shows its status and offers
  no buttons.
- Keep the card inside the existing chat surfaces. No second approval inbox, no
  generated interface, and no client-side execution path.

## Consequences

A model cannot authorize or misdescribe a commitment: the human sees and
approves the stored payload. The card needs the approvals read permission and
the purchasing read permission for presentation, with a safe fallback when the
latter is missing. Approval versioning and stale-proposal supersession remain
open; this decision only makes the exact stored payload visible and decidable.
