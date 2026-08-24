# ADR 0012, Creator Mode proposals are governed artifacts, not patches

Date: 2026-08-22 · Status: accepted

## Context
Letting an agent modify the running ERP is the fastest route to an outage or
a fraud hole. But self-improvement is the product's sharpest edge.

## Decision
Creator Mode (gated by `platform.creator`) lets the agent author platform
changes only as proposals: title, motivation, unified diff, test evidence,
and an honest risk assessment. Proposals are rows in `creator_proposals`,
reviewed by humans with `platform.creator`. Approval records the decision;
the diff merges through normal version control where CI re-verifies it. The
running server is never patched by the agent.

## Consequences
- The agent's reach equals its persuasiveness, bounded by review.
- Proposal quality becomes measurable (approval rate by session/model).
- Future work: sandboxed test-runners attached to proposals so evidence is
  generated, not asserted.
