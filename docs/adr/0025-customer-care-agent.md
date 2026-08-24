# ADR 0025: Customer care agent — draft-only autonomy with customer-bound tools

Date: 2026-08-24
Status: Accepted

## Context

Support inquiries arrive as free text from the least trusted party in the
system: the customer. An AI that answers them touches three risk classes at
once — prompt injection via direct instruction (OWASP LLM01), cross-customer
data exposure (the IDOR question recast for agents), and unauthorized state
change (refunds, payments). The platform's standing rules already cover
governed execution and audit; what was missing was a design for *answering
customers* where every tool is safe to point at hostile input.

## Decisions

### 1. Draft-only autonomy

The care agent never talks to the customer. It produces a draft that a human
reviews and releases through `support.postMessage`, recorded with `agent`
provenance plus the releasing user. Human confirmation breaks any injected
instruction chain at the point of real-world effect — the mitigation OWASP
and industry guidance rate as most reliable. When the answer needs authority
(money changes, exceptions), staff escalate via
`support.escalateConversation`; escalation is itself an audited capability,
not a side channel.

### 2. Customer binding at the type level

A conversation binds to exactly one in-org customer at creation. The order
status tool takes no model-controlled input: the orchestrator wraps it per
turn (`bindConversationCapability`) so its input schema is empty and the
conversation id is closed over server-side. A hijacked model cannot pivot
the lookup onto another customer because there is no argument to poison.
This generalizes the scoped-tool pattern: **anything whose subject is fixed
by the session should have zero degrees of freedom in its input schema.**

### 3. Least privilege made structural

The drafting loop runs against a sub-registry containing exactly two read
capabilities (`support.lookupOrderStatus`, `support.searchKnowledge`) under
an actor holding exactly `support.read`. Injected calls to money or identity
capabilities fail twice: unknown tool inside the loop, missing permission in
the governed executor anywhere else. No policy tuning can widen this; the
surface is defined by construction, not configuration.

### 4. Untrusted content framing

Customer messages are control-character-stripped, length-capped, labeled by
speaker, and wrapped in `<untrusted_customer_transcript>` delimiters inside
the goal text; the kernel appends its standing rule that retrieved content
is data, never instructions. Layered with draft-only release, one layer may
fail without harm.

### 5. Provenance honesty

`senderType` is derived from actor type: humans record `customer`/`staff`,
agents always record `agent` even when asked to impersonate the customer.
Released drafts are `agent`-sent with the releasing user attached. The
thread is therefore a faithful record of who authored and who approved
every word.

### 6. Bounded cost and honest failure

Drafting is rate-limited per user+conversation, capped at 4 loop steps,
with retrieval degrading to text search rather than failing. When records
or knowledge do not hold the answer, the system prompt requires saying so
and recommending escalation — matching the house rule that the agent files
down, never improvises.

## Consequences

- Staff get grounded, cited drafts with zero write exposure; every send,
  escalation, and resolution is ledger-audited like any capability.
- The bound-tool pattern is available to future agent surfaces (portal
  widgets, email triage) where the operator is untrusted.
- Support conversations add two tenant-scoped tables (migration 0016, RLS
  included) and a `support.read`/`support.write` permission pair usable in
  roles like any other.
