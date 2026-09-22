# ADR 0056: Authored-document drafts live outside the ledger

Date: 2026-09-21
Status: Accepted
Deciders: Phase 4 documents work

## Context

Phase 4 adds rich text authoring (Tiptap) on top of the append-only event
ledger. Two very different kinds of writes flow through an editor:

1. **Keystroke autosave**: a debounced write every few seconds while a
   person types, plus presence heartbeats and soft-lock renewals.
2. **Meaningful transitions**: publishing a version, restoring an old
   version, deleting a document, applying a template.

The ledger exists to answer "who changed what state, under which
capability, and can we prove it". Autosave noise would flood it: thousands
of low-signal entries per document per day, each paying hashing and
governance cost, drowning the entries that actually matter. Governance on
every keystroke would also make typing feel broken.

## Decision

- **Draft workspace state is written directly to RLS-guarded tables**
  (`doc_drafts`, `doc_presence`) through thin API routes, not through
  kernel capabilities. It never enters the ledger.
- **Meaningful transitions stay governed**: `documents.createDoc`,
  `saveDocVersion` (publish), `restoreDocVersion`, `deleteDoc`,
  `createTemplate`, `deleteTemplate` remain capabilities with intents,
  risk classes, inverses where state-changing, and full audit entries.
- Both table families carry the standard `tenant_isolation` RLS policy, so
  direct writes are still org-scoped at the database layer. Draft writes
  additionally enforce ownership of the lock: a writer may only save over
  a draft they hold or one whose lock has expired.
- The published version history (`authored_doc_versions`) remains
  append-only and restore is itself a new version, so the ledger plus the
  version chain together still reconstruct every meaningful change.

Drafts are **recovery state, not history**: losing them loses at most the
unsaved tail of a typing session, never a published version.

## Storage shape

`content_json` stores the Tiptap (ProseMirror) node tree, the same shape
Yjs would flatten into, so CRDT co-editing can arrive later without a
migration. `rev` is a monotonic client counter for lost-update detection;
conflicts resolve to "last writer with the lock wins".

## Consequences

- Typing is cheap and quiet; the ledger keeps its signal-to-noise.
- The audit trail for documents intentionally has a gap the width of
  "draft edits between publishes". Accepted: drafts are not business
  state, published versions are.
- A future CRDT switch touches only the draft route and editor client.
- `doc_presence` rows are ephemeral by convention (heartbeat + sweep of
  stale rows on read), not by a deletion job; a stale row is inert.
