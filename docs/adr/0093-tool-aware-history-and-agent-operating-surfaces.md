# ADR 0093: Tool-aware history, operating surfaces, and a high-throughput default provider

Date: 2026-10-22
Status: Accepted

## Context

The workmate could answer a first turn with tool results, then forget those
results on the next turn. `RecentMessages` loaded only user and assistant text,
tool events had no stable call id, and the stored tool_result event omitted the
result payload. Follow-ups such as "use that customer id" therefore either
re-read the world or failed.

Several surfaces a person can see had no agent equivalent. Approvals and the
ledger had been added, but notifications and saved customer views were still
only in the web app. Writes that need a customer, vendor, item, employee, or
project id also forced the model to list whole collections and guess.

The default Groq free tier repeatedly rate-limited multi-step runs. A run could
execute a write and then fail before explaining it. The deployment already had
a DeepSeek key and the codebase already used DeepSeek for evaluations, but the
chat provider mapping did not include it.

The Sessions page listed sessions without a way to search or filter them.

## Decision

1. **Persist a replayable tool transcript.** Every `tool_call` event stores the
   provider call id, step, index, name, and arguments. Every `tool_result`
   stores the call id and a bounded result payload. Tool calls and results are
   written synchronously under a per-handler mutex so sequence order matches
   execution order.

2. **Reconstruct history from the transcript.** `RecentMessages` loads up to
   sixty recent events and rebuilds user, assistant, assistant tool-call, and
   tool-result messages. Orphan calls without a result and calls without ids
   are dropped. History starts at a user message and is capped at twenty-four
   messages. The same untrusted-data rule applies to stored tool results.

3. **Expose notifications and saved views.** `notifications_inbox` reads the
   signed-in person's feed with an unread count. `crm.listCustomerViews` is the
   saved-view read and is selected for saved-view language. The daily brief
   includes notifications alongside approvals, signals, and changes.

4. **Resolve entities before writes.** `resolve_entity` searches customers,
   vendors, items, employees, and projects by name, email, SKU, or code under
   the matching read permission and returns canonical ids. The prompt tells the
   model to use it before a write that needs an id and to ask only when multiple
   matches are genuinely ambiguous.

5. **Use DeepSeek as the default chat provider.** The backend now maps
   `deepseek` to `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL`, and the settings UI
   offers DeepSeek. `.env.example` defaults to `deepseek-chat` with a 128k
   context window. DeepSeek supports streaming tool calls and prompt caching,
   which removes the observed multi-step rate limit on the development tier.

6. **Make context, saved queries, and tool surfaces discoverable in the UI.**
   The Sessions page gains title/id/model search and an assist, creator, and
   failed filter, and the replay exposes the stored tool result payload.
   Workmate gains `/notifications` and `/views` commands.

## Consequences

- A follow-up can reuse a prior tool result without another read. The history
  is bounded, so very large results are truncated in the transcript while the
  live turn still sees the full result.
- Stored tool results increase session event size. The cap is 8 KiB per result
  and the recent window is forty source events.
- Historical tool calls are sent to the provider even when that tool is not in
  the current shortlist. DeepSeek accepts this; a future provider that rejects
  it needs a text-summary fallback.
- Notifications are read-only. Marking them read stays a human action until a
  governed notification capability is exposed.
- Saved views are CRM-only today. The same contract should be extended to
  Accounting, Purchasing, Inventory, and Support later.
- DeepSeek is a deployment configuration, not a hard dependency. The provider
  abstraction remains model-agnostic and the fallback stays opt-in.
- Entity lookup is a read and is still scoped by RLS and permission.

## Alternatives considered

- **Replay only text summaries of tool results.** Rejected: it loses ids and
  structure, which are the exact things follow-ups need.
- **Store the full tool result indefinitely.** Rejected: session events would
  grow without bound and leak more payload into replay surfaces.
- **Let the model use saved views through capability search only.** Rejected:
  saved-view questions are common enough to select directly.
- **Keep Groq and add retries.** Rejected: retries do not create throughput,
  and a run that already wrote must not wait on a free-tier window.
- **Add a generic SQL lookup tool.** Rejected: entity-specific permissions and
  table shapes are clearer and safer.

## References

- [Capability discovery and composed briefs](0092-workmate-capability-discovery-and-composed-briefs.md)
- [DeepSeek API docs](https://api-docs.deepseek.com/)
- [Session history store](../../apps/api/internal/httpapi/chat_session.go)
- [Chat loop](../../apps/api/internal/httpapi/chat_loop.go)
- [Sessions page](../../apps/web-vite/src/components/SessionsPage.tsx)
