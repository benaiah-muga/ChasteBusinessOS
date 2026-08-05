# Spec: Agent harness (operate the business like a human)

**Status:** Draft product/engineering spec  
**Related:** [VISION.md](../../VISION.md), [ARCHITECTURE.md](../../ARCHITECTURE.md), [ADR 0006](../adr/0006-custom-ai-orchestration.md), [ADR 0007](../adr/0007-harness-memory-and-self-dev.md), [memory-system.md](./memory-system.md), [self-development.md](./self-development.md)

## 1. Purpose

Define the **agent harness**: the controlled environment through which models operate ChasteBusinessOS the way a competent human operator would -- using available tools, respecting security boundaries, completing multi-step goals, and escalating missing capability honestly.

This is the product answer to:

> Hand the model the tools and the rules for using them; it does the easy and complex steps that are possible. When something is missing, open a Capability Gap Ticket and optionally hand work to a coding harness.

## 2. Invariants (non-negotiable)

1. **AI/manual parity** -- tools map only to registered commands/queries (and documented platform services on the same bus).
2. **No elevated AI privileges** -- acting principal's permissions always apply; RBAC, role grants, secrets, break-glass are human-gated at policy thresholds.
3. **Zod at boundaries** -- plans, tool args, UI parts, gap tickets.
4. **Explainability** -- every assisted path can record why / what / rules.
5. **Events after commit** -- notifications and side channels via outbox/worker.
6. **Frontend is an API client** -- no kernel/db in `apps/web`.

## 3. Actors

| Actor | Responsibility |
|---|---|
| **General agent** | Default conversational operator; proactive engagement; routing; clarification; multi-domain plans |
| **Domain specialists** | CRM, Accounting, Inventory, Purchasing, Manufacturing, HR, Platform/System, Knowledge, Analytics -- shared harness + specialized prompts/tool allowlists |
| **Memory side-agent** | Extract, verify relevance, consolidate (see memory spec) |
| **Customization agent** | Spec confirmation, gap tickets, coding-agent handoff, marketplace publish path |
| **Coding harness** (external) | OpenCode, Codex, Claude Code, etc. -- implements features under conventions |
| **Human principal** | Authority for high-risk actions; final arbiter of autonomy policy |

Users should **not** need to know which specialist ran. Routing is internal.

## 4. Tool surface

### 4.1 Business tools

For each installed module command/query that the principal may use:

```ts
type HarnessTool = {
  name: string;                 // e.g. "crm.customer.create"
  kind: "command" | "query";
  description: string;
  inputSchema: ZodType;         // same as bus
  permissions: string[];
  riskClass: "read" | "write" | "destructive" | "admin" | "security_sensitive";
  resourceTemplates?: …;        // for resource_link parts on success
};
```

**Generation:** derived from module registry at runtime -- never free-form SQL or private table access.

### 4.2 Platform tools (examples)

| Tool family | Examples |
|---|---|
| Capability | `core.capability.catalog.search`, `core.capability.gap.create` |
| Branch | `core.branch.list`, `core.branch.switch` (session context) |
| Memory | `memory.search`, `memory.store`, `session.search` |
| Schedule | `core.calendar.*`, `core.reminder.*`, `core.followup.*` |
| Notify | `core.notification.*` (still permissioned) |
| Customization | `core.customization.propose`, `core.customization.handoff` |

### 4.3 Explicitly out of tool surface

- Direct DB / filesystem on production SoR
- Changing another user's roles without admin permission + confirm floor
- Reading secrets plaintext into chat
- Installing untested modules without install permission

## 5. Turn lifecycle

```
1. Load session + activeBranchId + org autonomy policy
2. Passive memory recall (embed turn context → graph cosine → optional side-agent)
3. General agent: classify intent
     - ops (execute with existing tools)
     - clarify
     - multi-step plan
     - proactive follow-up continuation
     - capability gap / customization
4. Route to specialist profile if single-domain confidence high
5. Build plan (rules first where possible; LLM for hard NL)
6. Autonomy gate per step (risk class may raise floor)
7. Execute via command/query bus
8. Emit UiParts: text, plan, confirm, resource_link, suggestions, gap_ticket
9. Persist turn; schedule extraction if trigger fires
10. Enqueue proactive follow-ups / reminders if plan requires
```

## 6. Proactive general agent

The general agent is **not** only reactive.

| Trigger | Behavior |
|---|---|
| Ambiguous request | Ask 1–2 focused clarifying questions |
| Long-running plan | Status updates at step boundaries |
| Reminder / calendar fire | Re-enter harness as system turn; notify user |
| Policy requires human | Surface confirm UI; do not silently wait forever without ping |
| Detected risk | Warn (e.g. bulk delete, payroll post) |
| Partial capability | Explain what was done + remainder + optional gap ticket |

Proactivity is rate-limited and preference-aware (`user_preferences.notifications`, quiet hours).

## 7. Specialists

```ts
type SpecialistProfile = {
  id: string;                   // "crm"
  label: string;
  systemAddendum: string;       // domain knowledge, conventions
  toolAllowlist?: string[];     // prefix or names; default = module tools
  preferredIntents: string[];
};
```

- Specialists **share** general harness rules (parity, autonomy, memory injection format).
- They add domain knowledge (e.g. invoice lifecycle, stock move semantics).
- Multi-domain work stays with general agent or sequential specialist handoffs recorded in the plan.

## 8. Capability path

```
Intent → map to capability id(s)
  available → tools
  partial  → tools + explanation + optional ticket for remainder
  absent   → honest refusal of execution + CapabilityGapTicket draft
               → user confirm → ticket persisted
               → optional Customization Agent pipeline
```

Ticket fields (minimum):

| Field | Purpose |
|---|---|
| `proposedCapabilityId` | Stable, general (`crm.price_list.multi_currency`) |
| `abstractRequirement` | SMB-facing description |
| `exampleScenarios` | Anonymized |
| `suggestedModuleId` | Boundary |
| `nonGoals` | What must stay config |
| `orgId`, `requestedBy`, `status` | Lifecycle |
| `deploymentTarget` | `local_extension` \| `marketplace_shared` \| `platform_roadmap` \| `undecided` |

## 9. Branch context

- Session carries `activeBranchId`.
- Tools that are branch-scoped receive branch from context unless input overrides with permission.
- NL: "switch to Mombasa branch" → `core.branch.switch` after list/validate access.
- UI lists **all branches** the user can access; HQ roles may see all org branches.

## 10. Safety classes

| riskClass | Default floor |
|---|---|
| `read` | May run under guarded_auto if policy allows |
| `write` | Org autonomy |
| `destructive` | At least `confirm` |
| `admin` | At least `confirm`; often human-only for delete user |
| `security_sensitive` | Human confirm minimum; never full_auto for role elevation |

## 11. Observability & evals

- Langfuse (optional) for LLM spans; always store explanation records.
- Eval suites:
  - parity (same command human vs AI)
  - no hallucinated commands
  - gap ticket instead of fake tool
  - branch isolation
  - memory relevance (side-agent on/off ablations)
  - proactive rate limits

## 12. Phased delivery

| Phase | Scope |
|---|---|
| H0 | Current orchestrator + specialists metadata + confirm (exists) |
| H1 | Capability catalog query + gap ticket command + UI part |
| H2 | Passive embedding recall + explicit memory tools |
| H3 | Proactive worker re-entry (reminders/follow-ups) |
| H4 | Customization agent + local coding-agent detection |
| H5 | Memory side-agent verify + ambient consolidation |
| H6 | Marketplace publish from closed tickets |

## 13. Non-goals

- Free-form agent root shell on production hosts as the default path
- Separate write APIs for AI
- User-managed "prompt only" specialists that bypass the bus
