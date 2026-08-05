# OpenWorker → ChasteBusinessOS Benchmark & Learnings Report

**Author:** Research pass for ChasteBusinessOS
**Date:** 2026-08-01
**Sources:** https://openworker.com · https://github.com/andrewyng/openworker (MIT, 11.6k★, ~115 commits, beta) · internal repo (`ARCHITECTURE.md`, `VISION.md`, `docs/product-architecture-next.md`, `docs/ai-autonomy-and-safety.md`, `packages/ai-core/src/*`, `packages/ai-core/src/memory.ts`)

> Context: OpenWorker (Andrew Ng's open beta) is a **personal desktop AI coworker** — local-first, single-user, file/Slack/calendar-centric. ChasteBusinessOS is a **multi-tenant business OS** — server-first, multi-branch, ERP-grade audit. They are **not the same product**, so the value here is **patterns and primitives OpenWorker already shipped that map onto ChasteBusinessOS's stated roadmap** — not feature parity per se.

---

## 1. One-line comparison

| Axis | OpenWorker | ChasteBusinessOS |
|---|---|---|
| Surface | Single-user desktop (Tauri + Python sidecar) | Multi-tenant web (Next.js + Fastify) |
| Locus of trust | Local machine (local secret store) | Server + Postgres + outbox |
| Mutations | Model → tools (files, shell, connectors) | Model → command bus (RBAC + audit) |
| Memory | Local JSON memory store + compaction | Postgres (planned pgvector graph) |
| Integrations | 25+ connectors + MCP per-tool control | Module-command tool wrappers (no MCP client today) |
| Scheduling | Standalone automations + self-wake | Worker-backed reminders (spec, not built) |
| Maturity | Beta, usable | Early alpha, foundation only |

---

## 2. What OpenWorker got right that we should adopt directly

### 2.1 Risk-class taxonomy (not a "writes vs reads" boolean)
`coworker/risk.py` classifies each tool call into one of four **RiskClass** values:

```
READ        → no side effects, always allowed
WRITE_LOCAL → mutates workspace (path-scoped + mode-gated)
EXEC        → runs shell commands (mode-gated)
EXTERNAL    → side effects leave the machine  ← the unattended-inbox hook
```

A tool's *effective* risk = user override ?? declared base classification ?? aisuite metadata (`requires_approval` ⇒ EXTERNAL) ?? READ. OpenWorker deliberately moved away from hardcoded `WRITE_TOOLS` name-lists to this single `classify()` entry point — risk is now **a declared property**, inspected once.

**Where we stand today:** Our `ai-autonomy-and-safety.md` lists four autonomy *levels* (recommend/confirm/guarded_auto/full_autonomous) and says "dangerous commands can force a higher gate" — but there is **no risk-class taxonomy** in `@chaste/ai-core`. Every command is gated only by its module-declared `permissions[]` strings, which conflate *what the command does* (side-effect class) with *who may call it* (RBAC). Those are orthogonal axes.

**Recommendation:** Add a `riskClass` field to `defineCommand()` (or derive it from the command's `permissions` metadata) so the orchestrator can drive autonomy gates from **a single classification** instead of bespoke per-command rules. The four-class taxonomy fits our world almost unchanged:
- `READ` ↔ queries
- `WRITE_LOCAL` ↔ in-tenant writes that touch only org data
- `EXEC` ↔ side effects that escape the org boundary (email send, webhook dispatch, file export)
- `EXTERNAL` ↔ anything reaching a third-party system the org doesn't own (Slack, payment gateway, bank)

This is small, reviewable, and immediately unlocks the unattended-inbox pattern below.

### 2.2 The Inbox as the canonical human-attention queue
`coworker/inbox.py` is, in my view, the single most valuable primitive OpenWorker shipped. It collapses **approvals, questions, notifications, directory grants, and plan proposals** into one store of record with a bulletproof state machine:

- **One kind enum + one state machine**: `kind ∈ {approval, question, notification, directory, plan}`, `state ∈ {pending → resolved}` — resolved **once**, idempotent, **first-responder-wins**.
- **Durable resume:** every item carries `tool_call_id`; a restart re-raises the exact same prompt and dedupes by `(session_id, tool_call_id)`. The agent waits via an `asyncio.Event` until any surface answers.
- **Visibility split:** `INLINE` (attended composer parks it server-side and redelivers on reconnect) vs `INBOX` (unattended session joins a cross-session queue). Same record, only visibility differs.
- **Approval outcomes:** `allow → ONCE`, `always → ALWAYS_TOOL`, anything else → `DENY`. "Always" is itself scoped by the **task-rule** in §2.4 below.

**Where we stand today:** ChasteBusinessOS's `orchestrator.ts` has `PendingConfirmation`/`PendingPlanStep` types and stores them in `chat_sessions.pending` (one pending blob per session). There is no first-class queue, no idempotent resume, no "answer from any surface." A user who disconnects after a plan is proposed but before confirming loses the suspended context.

**Recommendation:** Lift the Inbox pattern almost verbatim into a new `apps/api/src/inbox/` (or `packages/kernel/src/inbox.ts`) backed by a `pending_approvals` table instead of JSON in a session row. Concretely:
1. Add tables `pending_approvals(id, session_id, kind, title, body, tool_call_id, state, resolution, visibility, data, created_at, resolved_at)`.
2. Replace `session.pending` writes with `inbox.add_*` calls; the orchestrator `await inbox.wait(item_id)` instead of returning `pending` blobs.
3. This single change unblocks: multi-device approval, mobile push of approvals, an "approvals inbox" UI surface, and resumable sessions after refresh/restart.

This is the highest-leverage single feature we can copy. It directly satisfies the VISION ("checks in before important actions") and the AGENTS.md "human authority" invariant, while fixing a real UX hole we have today.

### 2.3 Unattended mode — "where the human is reached," not "what the agent may do"
`coworker/unattended.py` is a **per-session boolean toggle**, ~40 lines. It deliberately **does not change the autonomy ceiling** — the permission mode does that. When unattended is on, anything that would have prompted inline is rerouted to the Inbox and the agent suspends until answered. "Turning it on is a one-tap confirm" (enforced at the API/GUI layer).

This is the cleanest separation of two concerns most agent systems conflate:
- **Autonomy policy** = what actions the agent may take without asking.
- **Attention routing** = *when* it asks, *who* it asks, and *where* the answer comes from.

**Where we stand today:** Our autonomy spec only models the first axis ("recommend → confirm → guarded_auto → full_autonomous"). There's no concept of "the user went home and the agent should keep working but park approvals somewhere." A scheduled follow-up that fires at 2am has no defined surface for its confirmations.

**Recommendation:** Add `session.unattended: boolean` (one column). When set, the orchestrator routes every `needs_user=true` decision to the Inbox (visibility=`inbox`) instead of returning a `pending` payload to an HTTP response that no one is reading. This is a tiny change once the Inbox exists and it unlocks the entire "proactive follow-up while away" loop the VISION aspires to.

### 2.4 Standing/task-scoped approval rules (the "Allow every time" UX)
`coworker/permissions.py` introduces `task_rules: dict[tool_name → set[allowed_targets]]`. The mechanic:

1. A tool call eligible for a standing rule is one that's `EXTERNAL` risk **and** declares a `target` argument (e.g. the Slack channel name).
2. When the user approves an `EXTERNAL` call with "always," the engine records `{tool: {target}}` against the owning task.
3. Future eligible calls matching that exact target are auto-allowed — with the triggering **rule string** (`"send_message → #checkout-alerts"`) recorded in audit, so the in-app card can show "allowed by standing rule."

Two non-obvious brilliancies:
- **Target, not tool, is the binding.** "Allow `send_message` always" would be terrifying; "Allow `send_message` to `#checkout-alerts` always" is sound.
- **The matching happens at evaluation time, not approval time.** A run that started unattended can have a rule minted mid-run, and it applies to the very next call.

**Where we stand today:** We have no equivalent. Our `confirm` autonomy level forces a re-confirm on every invocation of a permissioned command, even in obvious repeat-pattern cases ("send the weekly digest to Slack every Friday"). That friction makes `full_autonomous` the only escape hatch — which is dangerous and exactly the wrong shape.

**Recommendation:** Add an `approvalScope: "once" | "always(target)"` outcome to the Inbox + a `task_rules`-like map keyed by `(command_id → allowed external target)`. This converts "confirm" from a workflow-tax into an auditing exercise while preserving the safety floor.

### 2.5 Self-wake (suspend/resume for free)
`coworker/selfwake.py` gives an agent four tools — `sleep_for`, `sleep_until`, `wake_on(job_id)`, `wake_on_event(event_key)` — that let it suspend itself and be resumed later by the scheduler tick. The session sleeps at ~zero idle cost; the runtime re-invokes it when a wake is due.

**Where we stand today:** VISION explicitly calls for "proactive follow-ups re-enter the harness" and Architect.md says "reminders / NL follow-up re-enter the harness as proactive turns." But that mechanism is unspecified. Our existing `apps/worker` job processor doesn't model re-entry into a chat session; it can fire a notification but the agent loop itself doesn't suspend/wait.

**Recommendation:** Model scheduled AI turns as **durable wake records** (table: `ai_wakes(id, session_id, kind, fire_at, job_id, event_key, state)`). The worker tick consumes `due()` rows and re-invokes `handleChatTurn` with a synthetic proactive user message. This is the spec already ("Follow-Up → harness re-entry") — OpenWorker just gives us a 200-line reference implementation.

### 2.6 Auto-compaction with mechanical state extraction
`coworker/compaction.py` (~330 lines) is the most rigorous context compaction I've seen in an open-source agent. Worth reading in full, but the load-bearing ideas:

- **Outbound vs canonical history.** The persisted transcript is **never modified**; only what is *sent to the model* is compacted. So `CompactionState` is essentially `[boundary_index, summary_text, working_state, user_messages]` and the outbound view is `[system] + [compacted block as a user message] + [verbatim tail from boundary:]`.
- **Mechanical extraction carries zero hallucination risk.** Before the LLM summary, `extract_working_state()` walks tool-call records and produces a deterministic block: files written, recent shell commands (with exit codes), artifacts produced, tools used. This means even if the summarizer fabricates, the model still sees *ground-truth* working state.
- **User messages are preserved verbatim, mechanically.** `extract_user_messages()` clips pasted bulk and caps to newest 40, but never lets the LLM decide whether to include them. Intent audit trail stays clean.
- **The summarizer prompt is a fixed 8-section contract** (primary intent / decisions / artifacts / errors / **all user messages** / pending / current work / next step), with explicit rules like "Do NOT carry full file contents as truth."
- **Repeated compaction chains correctly.** The previous summary heads the new span as `[previous compaction summary — fold its still-relevant content into the new summary]`.
- **A no-LLM `trim_state()` fallback** advances the boundary past ~10% of messages with an honest note, never silently dropping state.
- **Overflow markers are signature-detected** (`is_context_overflow` scans provider error text for `"context_length_exceeded"` etc.) and routed *back into* compaction policy.

**Where we stand today:** `ai-intelligence-plan.md` says "pass conversation history to the LLM on every call" with **no compaction strategy at all**. `MemoryStore` is a 50-line in-memory port with substring search. For long sessions we will eventually blast past context windows and lose silently. The jcode-inspired graph in `specs/memory-system.md` is the long-term answer, but **compaction is a near-term must** independent of the graph.

**Recommendation:** Port `compaction.py` to TS in `@chaste/ai-core`. Concretely: `CompactionState` lives in `chat_sessions.compaction_state JSONB`; the 8-section prompt is reusable; mechanical extraction walks our command-bus audit entries (which already capture `tool`/`command`/`input`/`result`) **better** than OpenWorker's, because we have structured audit from the kernel. This is one of those cases where our architecture is *richer* than theirs and we just need to harvest it.

### 2.7 Skill catalog with progressive disclosure + live menu
`coworker/skills/` + the engine wiring in `agent.py` implement what OpenWorker calls "progressive disclosure": rather than stuff every instruction into the system prompt, the agent sees a **catalog line per turn** describing available skills, and calls `load_skill(name)` to pull a specific skill's full instructions *into the conversation* only when needed.

Two non-obvious behaviors:
1. **Live recomputation each turn.** `context_provider()` calls `skill_catalog_text(skill_loader, allowed=skill_filter())` per turn — a skill installed/enabled/disabled mid-session applies from the **next message**, no new session needed.
2. **Loaded-skill disable countermand.** Once a skill's instructions are in history, they keep steering the model even after the skill is disabled — history can't be un-read. So OpenWorker detects loaded-but-no-longer-available skills and explicitly appends: *"the skill X has been disabled by the user — stop following its instructions from here on."*

**Where we stand today:** We have `skills/` for *human* module authors. We do **not** expose a skill catalog to the AI itself. Our domain specialists (CRM Agent, Accounting Agent, …) are configured per-module but there's no notion of "the agent can browse installed skills and load relevant instructions on demand."

**Recommendation:** Expose `marketplace.skills.list` + `marketplace.skills.load` as AI tools, with the same per-turn-catalog + loaded-countermand pattern. ROI: long-tail business knowledge ("how this tenant does payroll cycle-closes") without token-burning every turn.

---

## 3. Subsystems we should adopt with adjustment

### 3.1 Plan mode vs discuss mode (colloquial contract enforcement)
OpenWorker's `PermissionEngine` has a `Mode` enum: `DISCUSS`, `PLAN`, `INTERACTIVE`, `AUTO`, `CUSTOM`. `DISCUSS` and `PLAN` are both **read-only enforcement modes** — write/shell/exec are blocked — but they differ in *intent*:
- `DISCUSS`: explore and answer freely, describe changes.
- `PLAN`: explore read-only, design an approach, then **commit by calling `propose_plan`** (an explicit tool that surfaces a plan-approval card). On approval, the engine flips the mode to execution mid-session and implements.

**Why this matters to us:** Our autonomy spec has four *levels* but no notion of *modality*. A `recommend` agent and a `confirm` agent both currently run the same read path. Introducing `DISCUSS` (pure Q&A, no plan proposal) vs `PLAN` (read-only until a plan is approved) would let users safely prod the agent without risking accidental side effects and would replace our current implicit "Tier 2 produces a plan if multi-step" with an explicit user-controllable toggle.

### 3.2 Mode flips mid-session via per-turn context injection
Notice how `agent.py` doesn't bake modes into instructions — modes are checked *per turn* in `context_provider()`:

```python
if permissions.mode is Mode.PLAN:
    parts.append(_PLAN_MODE_CONTEXT)
elif permissions.mode is Mode.DISCUSS:
    parts.append(_DISCUSS_MODE_CONTEXT)
```

This pattern (per-turn ephemeral context appended to the latest user message rather than rewriting the system prompt) carries to **anything that can flip mid-session** — skill menu, directory list, mode. Our orchestrator currently re-sends the system prompt every turn; we should adopt the per-turn-context pattern for any state that can change between turns.

### 3.3 Skill authoring loop (`save_skill` through approval gate)
`agent.py` exposes a `save_skill` tool whose effect (installing a finished skill as a reusable asset) **routes through the standard approval card** — "the review-before-save rule holds without any bespoke plumbing." A skill created from a session must originate from that session's roots (no spying on neighbors).

**Where we stand today:** We have no equivalent. Our self-development pipeline spec produces *module* packages and capability-gap tickets, but we don't have a path for the agent itself to capture "this is how I solved this kind of problem — save it as a reusable procedure." That's a missing rung between one-off work and shipped modules.

**Recommendation:** Let the agent call `agent.procedure.save(name, instructions, files)` — content is reviewed via the Inbox approval card and stored as an org-scoped skill. This is the customization-memory primitive VISION §5.2 promises ("store **how** the hard customization was done in semantic memory") — but realized as an inspectable/reviewable object, not a silent embedding.

### 3.4 Narration guidance as a context feature
The `_NARRATION_GUIDANCE` block in `agent.py` is appended to every persona's instructions: *"before each batch of tool calls, write ONE short plain sentence saying what you're doing and why. Don't narrate trivial single-call follow-ups, don't repeat the previous line, and never let narration replace your final answer."* The UI interleaves these status lines with humanized tool rows inside a collapsed turn.

**Where we stand today:** Our plans DO show step descriptions, but during execution each command emits only a result row. There's no "Checking what merged since yesterday's digest" live-status feel — which is the single biggest UX upgrade between chat agents that *feel* alive and ones that feel like ATMs.

**Recommendation:** Cheap, high-impact. Add a `progress` UiPart (`{ type: "progress", text: string }`) and require the orchestrator to emit one before each non-trivial command batch. ChatWidget renders as a transient muted line that collapses once the step result lands.

---

## 4. Features OpenWorker has that we have **not** planned

These are the genuine gaps — things worth adding to the roadmap:

### 4.1 Multi-root workspaces + per-root writable flag
`PermissionEngine.roots` is a **mutable shared list** of `{path, writable}` entries, *kept by reference* so add/remove at runtime takes effect on the next permission check without rebuilding the engine. A "knowledge" persona can request another folder mid-task (`request_directory_tool`); an "orphan coworker" can have its scratch folder plus arbitrarily added folders; deletes are seen live.

**Why we'd care:** VISION §9 plans multi-branch data scoping, but **branch scoping is read-side filtering, not write-surface scoping**. OpenWorker's per-root `writable` flag is the right primitive if we ever want to say "this AI run may write to the Nairobi branch's files but not Mombasa's" — which is exactly the multi-tenant scenario VISION implies but doesn't specify.

### 4.2 Channel subscriptions + Slack mention router
`mentions.py` + `subscriptions.py` (channel subscriptions + Slack mention router):
- `@OpenWorker` tagged in a channel with no subscribed session → router spawns a session that **owns that thread** and replies into it.
- The store (`MentionSessionStore`) is keyed by `thread_target` (`"slack:C0123:1700….000100"`) — byte-identical to what `send_message` and the standing-grant target use, so **one string serves lookup, delivery, and permission**.
- Deleting the session clears its thread mappings (same contract as subscriptions).
- The store is **durable across server restarts** — `get_engine` re-derives `permissions.task_rules` from it on every rebuild, so the pre-approved in-thread reply survives restarts.

**Why we'd care:** Our entire comms spec (`scheduling-and-comms.md`) assumes email/in-app/chat-in-product. There is **no plan** for the agent to *receive* inbound Slack/Telegram/WhatsApp mentions and thread replies — i.e. multi-channel **inbound** messaging. For SMBs that already live in Slack/WhatsApp, that's where they will expect to operate the business. Channel ownership maps cleanly onto our org/branch model:
- Org `→` Slack workspace binding
- Branch `→` Slack channel binding
- Approval Inbox item visibility `→` thread reply in the originating channel
The OpenWorker mention store maps 1:1 to a `channel_session_bindings(target, session_id, channel_id)` table.

### 4.3 Compaction with Files + Artifacts tracking
Beyond the compaction section above, OpenWorker mechanically produces an **artifacts list** — `_ARTIFACT_HINTS = ("artifact", "publish", "deploy")` matches tool calls that produce durable output. The compacted block says "Artifacts produced" with their location.

**Why we'd care:** VISION mentions "deliverables" but we don't ship artifacts as objects. After AI prepays payroll or generates a quotation, the **artifact** (the PDF, the journal entry, the invoice) should be a first-class tracked object with a deep link — and resource-link UI parts already planned in `product-architecture-next.md §4`. OpenWorker's mechanical extraction idea generalizes: when compacting an old conversation, list *every artifact the AI produced* so the user can find them again later.

### 4.4 Per-turn token-aware compaction trigger
`trigger_tokens(context_window, threshold_pct=0.8, cap_tokens=250_000) = min(threshold_pct × window, cap)` — the cap exists because *"quality and latency degrade well before the nominal limit"* on 1M-context models. A 1M model hits 0.8 × 1M = 800K threshold but caps at 250K; that's the *right* tradeoff and we'd hit it later but should set the policy now.

### 4.5 Workspace trust store
`WorkspaceTrustStore.is_trusted(ws)` sets `workspace_trusted=True`, which cascades into `load_config(ws, workspace_trusted=...)` — trusted workspaces can auto-allow more, untrusted ones are stricter. The "no-self-grant" rule means persona loading **never** writes to the override store — only the human can grant trust.

**Why we'd care:** Our self-development spec assumes the *human* approves a coding-agent handoff, but **trust granularity** isn't modeled. For self-hosters running local coding agents on their own machine, "trust this workspace" is a one-time gesture that should auto-allow (with audit) — we should support an analogous `org.workspace_trust` for "this org/workspace was approved for self-dev" rather than re-confirming each time.

### 4.6 The `NONE_PROVIDER` deterministic planner as a *class*
We already have a `NoneProvider` (per `ai-core/src/providers.ts`) using `CHASTE_AI_PROVIDER=none` for rule-based planning. OpenWorker's `PLAN` mode institutionalizes a similar idea: a read-only mode where the agent explores and designs. The lesson is to **treat the deterministic planner as a first-class mode**, not a fallback—users who can't or won't use an LLM should still get coherent multi-turn behavior, and our architecture already half-supports this.

---

## 5. Where ChasteBusinessOS is already better — defend these choices

For every place we're catching up, there are places OpenWorker took shortcuts we should *not*:

### 5.1 Command-bus vs. raw tool calls
OpenWorker's agent calls tools that write files / run shell / call Slack directly. There's no "single mutation surface," no mandatory audit. Their `audit.py` is opt-in. We **must not** give that up — the kernel command bus with Zod + RBAC + audit + outbox is the foundation every other safe thing depends on. The cost is that some "tool calls" are heavier; the benefit is that a wrong tool call can be replayed, audited, and revoked through one channel.

### 5.2 Transactional outbox vs. dual-write side effects
OpenWorker dual-writes (tool call + audit record). Our transactional outbox is the *right* way for any business-critical side effect — anything OpenWorker's Slack send_tool does would, in our world, need to publish an outbox event the worker drains *after commit*. We're ahead here.

### 5.3 Permission-grade module system
OpenWorker has no equivalent to our module marketplace, manifests, installable packages, capability catalogs. Modules can be installed/uninstalled by humans or AI; permissions are declared per command. OpenWorker's tool registry is flat. This is the structural moat for "business operating system": the **modular installable domain** is ours.

### 5.4 Multi-branch + multi-tenant row-level scoping
OpenWorker is single-user single-workspace. Our branch model + `branchId` on documents + `activeBranchId` in session context is something OpenWorker cannot have without re-architecting. We should keep investing here — it's the SMB-differentiator they lack.

### 5.5 Generative validated UI parts (`@chaste/ui-schema`)
OpenWorker's GUI renders free-form artifacts (HTML/Markdown/PDF). Our structured **Zod-validated** chat UI parts (`plan`, `clarify`, `suggestions`, planned `resource_link` + `gap_ticket`) keep the model from inventing UI. The forbidden patterns in AGENTS.md ("model never invents paths") and the resource-link template-fill mechanism in §4 of `product-architecture-next.md` are *more principled* than what OpenWorker ships. Don't trade this away for a "prettier HTML artifact" feature.

### 5.6 Honest gap → ticket loop
OpenWorker has no equivalent to the Capability Gap Ticket / self-development pipeline. When its tools can't do something, it just fails the call. Our "honest gap → ticket → optional coding-agent handoff → marketplace/extension" loop is structurally more mature for the SMB ERP space and is the *only* path that scales against the long tail of business needs without core bloat.

---

## 6. Concrete recommendations, prioritized

Ordered by leverage × fit:

| # | Action | Source | Effort | Why |
|---|---|---|---|---|
| R1 | **Add `RiskClass` taxonomy** to `defineCommand()` and use it in the orchestrator's gate decisions | `coworker/risk.py` (~50 LOC) | S | Unlocks R2, R3, R4 |
| R2 | **Replace `session.pending` JSON with a first-class Inbox table** (`pending_approvals`) with idempotent resume + `INLINE`/`INBOX` visibility | `coworker/inbox.py` (~250 LOC) | M | Fixes the resumability/refresh hole; foundation for mobile + Slack approvals |
| R3 | **Add `session.unattended` boolean** that flips Inbox visibility from `INLINE` to `INBOX` | `coworker/unattended.py` (~40 LOC) | XS | Unlocks scheduled follow-ups while away |
| R4 | **Standing approval rules** keyed by `(command_id, external target)` with "always(target)" outcome | `coworker/permissions.py` `task_rules` | M | Lets `confirm` stop feeling like a tax; preserves audit |
| R5 | **Self-wake / durable wake records** so scheduled AI turns re-enter the harness | `coworker/selfwake.py` (~200 LOC) | M | Already in our spec; OpenWorker gives a reference impl |
| R6 | **Port compaction** (outbound vs canonical + mechanical state extraction + 8-section summarizer prompt + overflow marker detection + no-LLM `trim_state` fallback) | `coworker/compaction.py` (~330 LOC) | M | Defends every long session from silent context-loss; reuses our existing audit trail better than theirs |
| R7 | **Skill catalog exposed to AI** with per-turn live menu + loaded-skill disable countermand + `save_skill` via Inbox approval | `coworker/agent.py` `skill_loader`/`context_provider` | M | Captures customization procedures as inspectable artifacts |
| R8 | **Live narration `progress` UiPart** before non-trivial command batches + collapsible status lines | `_NARRATION_GUIDANCE` in agent.py | S | Biggest perceived "alive" feel for lowest cost |
| R9 | **`DISCUSS`/`PLAN` modes** as read-only enforcement with `propose_plan` as the exit door | `coworker/permissions.py` `Mode` enum | S | Gives users a safe Q&A surface distinct from the action one |
| R10 | **Inbound channel ownership** (Slack/WhatsApp mention → session → reply-in-thread + standing task rule per thread) | `coworker/mentions.py` + `subscriptions.py` | L | Fills a real roadmap blank; maps 1:1 onto org/branch model |
| R11 | **Mechanical artifacts tracking** in compaction (list every produced artifact deep-linkable) | `coworker/compaction.py` `_ARTIFACT_HINTS` | S | No invented numbers; survives compaction |

---

## 7. Architectural translation table

For implementation, the matching structural pieces:

| OpenWorker | ChasteBusinessOS equivalent | Adjustment |
|---|---|---|
| `coworker/agent.py` `build_engine()` | `packages/ai-core/src/orchestrator.ts` `handleChatTurn` | Our build accepts `deps` (provider, command/query registries); add `inbox`, `wakeStore`, `skillFilter` to `OrchestratorDeps` |
| `coworker/permissions.py` `PermissionEngine` | Today: per-command `permissions[]` strings + `AppContext.permissions: Set<string>` | Add a `RiskClass` resolver + an Autonomy gate that consults RiskClass, not just permissions — see R1 |
| `coworker/inbox.py` `InboxStore` + `inbox_approver` | Today: `chat_sessions.pending JSONB` | Move to dedicated table; see R2 |
| `coworker/unattended.py` | n/a | New `chat_sessions.unattended BOOLEAN NOT NULL DEFAULT false`; see R3 |
| `coworker/selfwake.py` `WakeStore` + `selfwake_tools` | n/a | New `ai_wakes` table + AI tool `agent.sleep_until`/`agent.wake_on`; worker tick consumes `due()` |
| `coworker/compaction.py` `apply_to_outbound` | Today: pass `session.messages` straight to provider | Add `chat_sessions.compaction_state JSONB`; orchestrator runs `applyToOutbound(session.messages, state)` before each LLM call |
| `coworker/skills/` + `save_skill` | Today: `skills/` only for human module authors | New `ai_skills` table + `agent.skill.save` tool routed through Inbox approval |
| `coworker/mentions.py` `MentionSessionStore` | n/a | New `channel_session_bindings` table once we add a Slack/Telegram connector |
| `coworker/risk.py` `classify()` | Today: nothing | Add `riskClass` to `defineCommand`; new `resolveRiskClass(commandName)` lookup |

---

## 8. What I'd push back on / not copy

- **Local-first as a goal.** OpenWorker's local secret store is wonderful for personal trust, terrible for an SMB where the owner needs the system to keep running when the owner's laptop is closed. Stay server-first; add per-org secrets vault.
- **Dual-write audit.** OpenWorker writes audit records as a side effect. We must not — the transactional outbox is correct and OpenWorker is wrong here.
- **Flat tool registry.** Their `ToolRegistry` is a flat namespace. Our command-bus organization is what lets us cap permissions per command. Keep ours.
- **No multi-tenant data isolated.** OpenWorker has no `organizationId` anywhere. Don't take a single table from them without thinking about how it carries `organizationId` and `branchId` — the Inbox, wake, mentions extensions should each have both columns from day one.

---

## 9. Closing

OpenWorker's two-line elevator pitch is "AI that gets your everyday tasks done" — a *personal* coworker. Ours is "a trustworthy harness for operating and evolving a real business." They have shipped a remarkable amount of the agent-loop machinery (Inbox, risk, compaction, self-wake, skills, mentions) **with code we can read and port**, because the surface area of "an agent loop that gets things done safely" is largely language- and topology-agnostic. The differences show up in the data layer (multi-tenant, multi-branch, command-bus, outbox) — and on *those* dimensions, our architecture is the stronger one.

The single highest-leverage move from this report is **R2: the Inbox as a first-class system**, because it (a) is a small lift from a clean reference implementation, (b) fixes a real UX hole we have today, and (c) is the prerequisite for unattended mode, scheduled follow-ups, mobile approvals, and inbound channel messaging — i.e. it unlocks the entire proactive side of the VISION in one stroke. Pair it with **R1 (RiskClass)** and **R5 (self-wake)** and you've replaced our current "Tier 1/2/3 passive orchestrator" with a real agent runtime.

*OpenWorker source is MIT-licensed; derivative code should be attributed and (where the design is distinctive, e.g. the 8-section compaction prompt) should keep a code comment pointing at the upstream spec for credit and future sync.*
