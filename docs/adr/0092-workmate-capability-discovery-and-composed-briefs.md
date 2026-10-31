# ADR 0092: Workmate capability discovery, composed briefs, and honest action confirmation

Date: 2026-10-22
Status: Accepted

## Context

The Go workmate could execute only the capabilities hand-written in
`agentToolDefinitions`, eighteen at the time. The system prompt told the model
to use skills, analytics, and document memory, but those tools were not in the
request. Its user message also ended with "No registered capability can do
this. State honestly that you cannot, and call file_ticket." The model obeyed
that sentence on almost every non-trivial request, even when the ERP had the
data and the capability.

A daily brief exposed the gap. "What needs my attention today, what changed
since yesterday, and what should I do first" produced `file_ticket` instead of
a read of signals, receivables, payables, stock, tasks, leave, support, and the
ledger. The model could not see those tools and was told in advance that the
capability did not exist.

Two additional failures mattered. Provider reasoning text could be shown as
the final answer when the model returned no content, and a provider failure
after a successful tool call could replace a real, audited action with a
generic transport error. The assistant also ignored previous turns because the
loop started from a fresh message list.

## Decision

1. **Remove the no-capability sentence from the user message.** The model
   learns what is possible from the tools and the system prompt, not from a
   pre-emptive refusal.

2. **Advertise a focused shortlist, not the whole registry.** A reviewed tool
   catalog is embedded from the manifest, and `selectChatToolSpecs` picks at
   most twelve capabilities per turn from keyword groups, always keeping
   signals, skills, document memory, and the finance overview. This keeps
   provider requests small and the choice set legible.

3. **Make the full governed catalog discoverable.** Two built-in tools,
   `capability_search` and `capability_invoke`, search every supported
   capability the signed user may use and invoke it through the same executor.
   Human-only capabilities are excluded, and discovery and invocation honor
   the module switchboard as well as permissions. Policy, approvals, inverses,
   and audit still run in the kernel, so discovery is not a bypass.

4. **Compose the daily brief on the server.** `daily_brief` gathers signals,
   financial overview, receivables, payables, low stock, open tasks, leave,
   open support, pending approvals, and state-changing ledger events in one
   deterministic read. It excludes reads from the changes section so a report
   refresh is not reported as a business change. The model phrases the result
   and recommends one next action; it does not have to orchestrate ten tools.

5. **Keep reads and changes separate.** `recent_changes` reads the append-only
   ledger but filters risk class `read`. The daily brief uses only state
   changes for "what changed since yesterday".

6. **Never show hidden reasoning.** Reasoning deltas are kept out of the final
   answer. If a turn returns only reasoning, the loop nudges once and then
   fails honestly instead of rendering chain of thought.

7. **Confirm actions when the model fails after execution.** If a tool has
   already run and the next provider request fails, the loop returns a
   deterministic confirmation that names the capability, says whether the
   result is recorded or waiting for approval, and includes the approval id.
   A real audited action is never replaced by a transport error.

8. **Load recent conversation text.** The session store exposes the last
   twelve user and assistant text events, and the loop prepends them to the
   current turn. Tool-call reconstruction remains out of scope; the workmate
   remembers what was said, not the full execution trace.

9. **Keep provider failures actionable.** Rate limit, request too large,
   missing model, credential refusal, and provider outage get distinct,
   product-language messages. An implicit fallback to an unverified model is
   disabled; a fallback is used only when `MODEL_PRIMARY_NIM` is explicitly
   configured.

## Consequences

- A user can ask for any supported governed action and the workmate can find
  it through search, even when it was not on the turn's shortlist.
- The shortlist keeps provider token use and tool-choice confusion down, but a
  search adds a model round trip. The daily brief avoids that for the most
  common recurring request.
- The full catalog is embedded at build time. A new capability is discoverable
  only after the catalog is regenerated from the manifest with
  `pnpm agents:catalog`, so generation must be part of the capability workflow.
- `capability_invoke` is intentionally general. It remains safe because the
  executor rechecks the signed user, module switchboard, permission, policy,
  approval, and inverse. Reviewers must reject any implementation that calls a
  capability directly from the chat loop.
- The conversation history is text-only. Follow-up questions that depend on
  an earlier tool result still need a new read.
- Rate limits remain a provider constraint. The UI now says what happened and
  the workmate confirms work that already completed.

## Alternatives considered

- **Expose all 338 capabilities on every turn.** Rejected: provider request
  limits and tool-choice quality both degrade. The original 81-tool experiment
  produced a 413 from the provider.
- **Add a tool for every missing capability by hand.** Rejected: it recreates
  the coverage gap on the next capability and cannot keep up with the manifest.
- **Let the model call any capability id without discovery.** Rejected: it
  would guess schemas and fail, and it hides the governed catalog from the
  user.
- **Show reasoning as a fallback answer.** Rejected: internal deliberation is
  not an answer and can contain stale or contradictory plans.
- **Fail the whole turn when the model is rate limited after a write.**
  Rejected: the write already happened and the user must know.

## References

- [Capability kernel](../../ARCHITECTURE.md)
- [Capability manifest](../migration/capabilities.json)
- [Agent tool catalog](../../apps/api/internal/capability/agent_tool_contracts.json)
- [Full capability discovery index](../../apps/api/internal/capability/capability_catalog.json)
