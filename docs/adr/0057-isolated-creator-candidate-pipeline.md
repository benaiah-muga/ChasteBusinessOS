# ADR 0057: Creator candidates are verified in disposable worktrees

## Status

Accepted

## Decision

Creator turns may render a sanitized capability-gap contract into candidate
artifacts in a detached, disposable Git worktree. The verifier checks the
artifact contents, computes an exact SHA-256 digest, records independent test
evidence and a rollback action, and leaves the proposal `in_review`; it never
promotes or edits the running application.

## Security boundary

A Git worktree is an artifact-isolation and rollback mechanism, not a hostile
code sandbox. The candidate verifier does not execute generated code or use
production credentials. A future deployment runner still needs a hardened
container/VM boundary, egress controls, resource limits, and supply-chain
checks before untrusted candidate code is built or tested.
