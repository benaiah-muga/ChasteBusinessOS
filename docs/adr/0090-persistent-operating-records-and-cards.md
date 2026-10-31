# ADR 0090: Persistent operating records and read-only Workmate cards

Status: accepted

## Context

A governed workflow needs to survive the conversation: the objective, the
detected exception, the evidence, the decision, and the verified result must
remain queryable after the turn ends. The only durable conversation card was
the purchase proposal, and it was tied to an approval payload.

A full normalized model for each record type would add three tables and three
sets of capability contracts before the operating loop could be exercised.

## Decision

- Add `operational_records` with `kind` (`objective`, `exception`,
  `decision`), a stable key unique per organization and kind, status, title,
  summary, JSON details, revision, authority reference, optional approval and
  owner, and timestamps.
- `operations.upsertRecord` updates the record with the same stable key instead
  of inserting a duplicate. The revision increments and `resolved_at` is set
  for resolved, verified, suppressed, or cancelled states.
- `operations.getRecord` and `operations.listRecords` are organization-scoped
  reads. The operations module is always enabled because it is the record layer
  for the other modules, not an optional business module.
- Type-specific content lives in `details`: completion criteria and evidence
  for objectives, severity and next step for exceptions, alternatives,
  recommendation, actions, and verified result for decisions. Normalizing these
  into dedicated columns or tables is deferred until a query needs it.
- Derive a read-only card in the record response: exception, progress,
  waiting, or result. The chat loop forwards a top-level `card` from a tool
  result as a `card` event, and Workmate renders it without treating it as an
  approval.
- One assistant turn carries at most one visible card today; a later change
  can key cards by record id if multiple records need to appear together.

## Consequences

Objectives, deduplicated exceptions, and Decision Records now survive the
conversation and can be read back by stable key or id. Workmate can show an
exception, progress, waiting state, or verified result without model prose
being the record. The generic JSON details keep the first slice small, and the
stable-key upsert makes repeated detection idempotent. The cost is weaker
type-level constraints and no dedicated page yet; both are acceptable until
the operating loop needs richer queries.
