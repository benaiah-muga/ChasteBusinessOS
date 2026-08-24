# 0016, Org memory retrieval as a governed capability

Date: 2026-08-22 · Status: Accepted · Related: ADR 0008 (pgvector org memory), ADR 0013 (document ingestion)

## Context

Document ingestion (0013) writes parsed text into `memories` as `doc_chunk`
rows with embeddings, but nothing could read them back. The agent's only
actions are registered capabilities, so "what does our discount policy say?"
produced an honest shrug and a support ticket despite the data sitting in the
database. Retrieval existed as storage without a reader.

## Decision

Retrieval is itself a governed capability, not a side channel:

- **`documents.searchMemory`** (read class, `documents.read` permission):
  embeds the query (`input_type: "query"`) and returns top-k memory rows by
  pgvector cosine distance. Registered like any capability, so the chat harness
  exposes it to the agent automatically and it is subject to RBAC and the event
  ledger like every other action.
- **Graceful degradation**: if embeddings or the model key are unavailable,
  search falls back to case-insensitive content matching; if that finds
  nothing it returns empty results. Memory search never hard-fails a
  conversation.
- The console system prompt instructs the agent to search memory *before*
  claiming ignorance, then fall back to `file_ticket`.

## Alternatives considered

- *RAG behind the scenes* (auto-inject top-k chunks into every prompt): hides
  provenance, spends quota on trivial questions, and bypasses governance,
  rejected; explicit tool calls keep retrieval auditable in the session replay.
- *Separate unauthenticated search endpoint*: would let UIs bypass RBAC on
  tenant knowledge, rejected.

## Consequences

- Session replays now show when answers were grounded in which document.
- Embedding calls consume model-provider quota per parse/query; bounded by
  chunk cap (8k chars) and best-effort failure semantics from 0013.
- Future memory kinds (SOPs, decisions) become retrievable with zero new
  plumbing.
