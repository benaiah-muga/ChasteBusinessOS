# ADR 0084: Go-owned asynchronous document parsing jobs

Status: accepted

## Context

The Go executor already implements `documents.parseDocument`, including its
OCR adapter, org-scoped document update, derived memory replacement, and action
receipt. The Go job worker did not claim this capability, so async document
parsing remained owned by the TypeScript worker even though the Vite and Go
runtime is the migration target.

## Decision

- Route `documents.parseDocument` jobs to the Go worker allowlist and apply the
  same restricted job-row policy used by other Go-owned capability jobs.
- Keep the legacy TypeScript worker from claiming this job type, so one job
  class has one active executor owner.
- Execute the parse through `Executor.ExecuteSystem` with the
  `documents.write` permission and the existing job ID receipt key.
- Preserve the existing document and memory tables, queue lease and fencing,
  retry behavior, and OCR adapter. Do not change upload enqueue semantics in
  this worker ownership change.
- Keep uploaded-file OCR provider verification as a separate runtime proof.

## Consequences

The migration updates both the Go claim allowlist and the legacy TypeScript
claim filter. Deployments that enqueue document parsing must run the Go jobs
worker for those jobs to make progress. The integration proof covers successful
asynchronous parsing of pasted text, document state, memory replacement, and
receipt creation. It does not yet prove a live OCR provider call.
