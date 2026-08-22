# ADR 0013: Document ingestion — deterministic coding, model-assisted extraction

Date: 2026-08-22 · Status: accepted

## Context

M3's last gap: ingest business documents (vendor bills, receipts) so the
agent can read them. OCR was specified as nemotron-parse; auto-coding had no
design. Two failure modes to avoid:

1. **Hallucinated accounting.** An LLM picking expense codes directly would be
   unauditable and wrong in ways only a trial balance notices.
2. **Key-gated core flows.** Everything that must work (ingest → parse →
   suggest → bill) cannot require NVIDIA_API_KEY, or CI, offline demos, and
   air-gapped deployments break.

## Decision

- **Storage:** documents live in Postgres (`documents` table), bytes ≤ 5MB
  base64. No object storage yet — receipts are small and tenant-scoped
  queries are trivial; revisit when PDFs get large.
- **Parsing** (`documents.parseDocument`): uploads go through nemotron-parse
  (`packages/ai/src/documents.ts`) into markdown; pasted text is normalized
  as-is. Parsed text is indexed as `doc_chunk` org memory (best-effort,
  same posture as onboarding embeddings). Failure is honest: status
  `failed`, error stored, capability throws.
- **Coding suggestions** (`documents.suggestCoding`): line items come from
  the caller or from an LLM extraction pass over parsed text (strict JSON
  contract). Account codes are assigned by a **pure deterministic matcher**
  (`erp-core/coding.ts`): token overlap between the line description and
  account names, synonym-expanded, tie-broken by ascending code, falling
  back to Operating Expenses (6000). The LLM never picks account codes.
- **Governance:** ingestion is `write`; deletion is `destructive` (always
  gated); suggestions are derived state with no inverse — re-running is the
  undo. Nothing posts to the ledger from this module; bills are created via
  the existing `purchasing.createBill`, so money gating is unchanged.

## Consequences

- The whole chain is provable offline (`pnpm demo:m3`), and CI runs it
  without secrets.
- Suggestion quality scales with the chart of accounts' vocabulary, not
  with model whims; mis-codings are visible (match score ×0 = fallback) and
  human-correctable at bill entry.
- Model-extracted lines are validated (integer thousandths/minor units)
  before they touch domain code; malformed output fails loudly instead of
  posting garbage.
