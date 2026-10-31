# ADR 0100: Enforce the Workmate turn contract in code, not in the prompt

Status: accepted (2026-10-28)

## Context

Salesforce's account of Agentforce, as reported in ByteByteGo's deep dive,
describes the failure every prompt-driven ERP assistant eventually meets. The
first version put every rule, tool description, and piece of customer data into
one prompt. It worked up to roughly eight instructions. Beyond that the model
began skipping rules, which is unsurprising: to a model an instruction is text
in the context, not a constraint the runtime enforces.

The fix was to take the jobs out of the prompt and give each a system that
cannot be skipped: deterministic code for conditions, a data layer for identity,
a context engine for what reaches the model, and a separate agent identity for
authority. The part that matters most for Chaste is the first. Agentforce's
Agent Script compiles declared behavior into a graph the runtime executes:
code steps run before reasoning (fetch the appointments), the model reasons over
what code prepared, and code steps run after reasoning to enforce obligations.
A SQL trigger is the right analogy: the application issuing an update cannot
skip it.

Chaste's Workmate had arrived at the same place from the other direction. Its
system prompt carried nineteen rules, three of them long paragraphs about how to
report approvals and notifications. Those three described behavior the server
could simply guarantee, and they were long because the model kept getting them
wrong. Nothing in the Go runtime verified the answer against the executor's
result: a tool could return `pendingApproval: true` while the reply said the
invoice was created, and the reply is what the person reads.

## Decision

### Code guarantees are separate from prompt guidance

A new pure package, `apps/api/internal/agentturn`, holds the deterministic half
of one turn. It has no IO, so both halves are reproducible in tests.

**Before reasoning, code compiles turn facts.** The handler reads the approvals
inbox and the notification inbox through the same readers the tools use, and
renders a `<turn_facts>` block: read time, pending approval count with the
oldest few rows (capability, risk class, rationale, raiser, age, approval id),
and unread notification count with the latest title. The block is appended to
the system prompt and its digest is stored on the turn's user event so the
trajectory records what the model was told.

A failed read renders as `unknown (reason)`. It is never rendered as zero.
Claiming nothing is waiting when the inbox could not be read is the specific
failure this type exists to prevent, so the compiler treats "not checked" and
"checked, empty" as different facts.

**After reasoning, code enforces obligations.** The loop records one effect per
capability execution from the executor's verdict, not from the model's prose:
capability id, risk class, ok, pending approval, approval id, error. After the
loop, `Enforce` corrects the final answer when:

- a pending approval exists and the answer never mentions approval. The answer
  gains a notice naming the capability and approval id and stating that nothing
  has changed. A gated action is not a failure, so it never also produces the
  failure sentence.
- a material action (any risk except `read`) failed and the answer does not
  acknowledge it. The answer gains the executor's error and a statement that no
  change was confirmed.
- a dash character (U+2014 or U+2013) survived. The dash is rewritten to a comma
  or hyphen, on every streamed delta as well as the final text, so the stream
  and the stored transcript agree.

Enforcement is idempotent: a retried turn cannot stack duplicate notices, and an
answer that already says the right thing is left alone. Each correction is
recorded as a violation, logged, and counted on the stored assistant event.

**The server's final reply is authoritative in the client.** The streamed text
is a preview. The `done` event's reply replaces it, because the server may have
appended a notice after streaming and the stored transcript already holds that
text. Previously the client ignored `done.reply` whenever any text had streamed,
so a corrected answer would have been persisted but never shown.

### The prompt loses what code now guarantees

The three approval and notification rules collapse into two short ones: the
facts block is current state, and an unknown count means the read failed. The
prompt keeps guidance that genuinely requires judgment (which tool fits, when to
ask, how to phrase), because code cannot reason. It no longer asks the model to
remember what the runtime knows.

## Consequences

- Approvals and notifications cost one read each before the model runs, bounded
  at three seconds, with failures degrading to an explicit unknown. This is the
  price of a guaranteed answer instead of a hopeful one.
- The writing rule is now a guarantee, not a request. Text produced by other
  paths (notification bodies, document text) is untouched; only assistant prose
  is sanitized.
- A failed read is excluded from failure notices: a missing read is visible in
  the answer itself, and a notice on every failed lookup would train people to
  ignore notices.
- The effect record is the seam for later verification work. A future step can
  compare claimed ids and amounts against effect data, or refuse a reply that
  cites a record the turn never read, without changing the loop again.
- Identity resolution and a per-agent authority grant, the other two jobs in the
  Agentforce design, are not part of this decision. Chaste already narrows the
  agent through capability permissions, the module switchboard, and the approval
  policy. `resolve_entity` remains literal substring matching, which is a known
  gap recorded in the roadmap rather than silently assumed solved.
