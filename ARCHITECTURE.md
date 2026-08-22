# ChasteBusinessOS — Architecture Blueprint

> An agentic ERP where every human action can also be done by an AI agent — safely,
> auditably, and under human authority. The business owner describes their business in
> plain language; the system configures and operates as much as possible on their behalf.

---

## 1. Core Thesis

DeepSeek popularized **Agent = Model + Harness**. We extend it to business software:

```
ERP = Domain Model + Business Harness
```

- The **Domain Model** is deterministic double-entry accounting, inventory math,
  payroll rules — code that must never hallucinate.
- The **Business Harness** is everything that lets an AI (or human) act inside the
  domain model safely: capabilities, permissions, approvals, effect-tracking, audit,
  memory, and the loop.

The model proposes; **the harness disposes**. An LLM never writes a journal entry —
it calls a capability whose execution goes through validation, permission checks,
policy thresholds, and an append-only audit trail. This is why enterprises can trust it.

### Lessons adopted from DeepSeek Harness / Cordis

| Their idea | Our adaptation |
|---|---|
| "Everything is a plugin" (Cordis kernel) | Every ERP feature surface — tools, workflows, UI panels, report types — registers as a **Capability** in a typed registry. No hardcoded agent logic in modules. |
| **Temporal composability** — revertible effects | Every state-changing action carries a declared **inverse** (compensating action). Postings reverse via reversal entries; nothing is ever mutated destructively without an undo path. |
| **Spatial composability** — reactive coeffects | Capabilities declare dependencies (`requires`, `provides`, `invalidates`). Changing a customer's credit terms invalidates dependent open quotes reactively. |
| Append-only session log / Trajectory view | One **Event Ledger**: append-only, replayable, forkable record of everything the agent saw, decided, and did. Doubles as the enterprise audit log. |
| Running modes (Standard / PTC / Minimal / Creative) | **Assist**, **Autopilot** (policy-bounded autonomy), **Creator** (self-development, gated), each mode just re-composes capabilities. |
| KV-cache-friendly context engineering | Stable system prefix → org profile → module docs → task suffix. Cache hit rate is a first-class metric. |
| Honest about gaps | Missing capability ⇒ auto-filed **Ticket + build path**, never a hallucinated command. |

---

## 2. The Capability Kernel

The heart of the system. A `Capability` is the atomic unit — one thing an agent or
human can do:

```ts
interface Capability<I, O> {
  id: string                      // "accounting.postJournalEntry"
  title: string                   // human + LLM readable
  intent: string                  // natural-language description (embedded → vector)
  input: Schema<I>                // zod
  output: Schema<O>
  risk: RiskClass                 // read | write | money | identity | destructive | secret
  requiresPermission: PermissionRef
  approval?: Policy               // when human sign-off is forced
  inverse?: CapabilityId          // temporal composability: how to undo
  execute(ctx: ActionContext, input: I): Promise<Result<O>>
}
```

Every action — by human UI click or agent tool-call — funnels through the same
`Capability.execute`. There is exactly **one** execution path, so there is exactly one
place to enforce security, one place to audit, and the AI can do *everything* the human
can because they share the same contract.

### Governance pipeline (per action)

```
intent → resolve capability → validate input → check actor permissions
      → policy evaluation (risk class × amount thresholds × role)
      → [auto | require approval] → execute → record in Event Ledger
      → publish domain events → (reactions: projections, notifications, embeddings)
```

Risk classes and defaults (org-configurable):

- `read` — autonomous
- `write` — autonomous below policy thresholds
- `money` — approval required above configurable amount (e.g. > $500)
- `identity` — role assignment, permission grants → **always** human-approved
- `destructive` — deletion, period closing → always approved, always reversible-first
- `secret` — credential handling → never visible to models, only references

Approvals are themselves first-class workflow objects: proposed action rendered as
human-readable diff, approve/reject with comment, expiry, delegated authority.

---

## 3. The Agent Loop

ReAct-style single-agent loop with subagent fan-out for heavy work:

1. Assemble context (cache-ordered): identity+policy prefix → org profile → active
   module docs → retrieved memories → task.
2. Model selects capability calls (typed, schema-constrained).
3. Harness executes through governance pipeline.
4. Observations appended to trajectory; loop until done or blocked.
5. Blocked ≠ hallucinated: unknown capability ⇒ ticket creation + honest reply.

Three tiers of memory (context-rot aware):
- **Working** — current trajectory window
- **Session** — summarized mid-term state, persisted per conversation
- **Org memory** — pgvector-backed semantic store: business description, SOPs,
  preferences, past decisions ("we always give returning customers 2% discount")

Embeddings: NVIDIA NIM `nvidia/nv-embedqa-e5-v5` (free tier). Retrieval = vector
similarity + pg_trgm keyword fallback, tenant-scoped with row-level filtering.

---

## 4. Creator Mode (self-development)

Users with `platform.creator` permission switch modes; the agent then builds features
*for the platform itself*, but strictly inside a sandboxed workspace:

- Works on a git branch in a dev container; runs tests/linters itself.
- Produces a **Change Proposal**: diff + generated test evidence + risk assessment.
- Human merges; deployment is CI-gated. The agent never touches production runtime.
- New capabilities authored this way register through the same kernel contracts —
  the platform eats its own dog food.

This mirrors dsh's Creative Mode but adds the enterprise missing piece: proposals are
governed artifacts, not live patches.

---

## 5. Coding-Agent Federation

Chaste detects installed coding agents (`opencode`, `codex`, `claude`, `kilocode`,
`aider`, …) by scanning PATH + known config dirs, and exposes them as delegatable
capabilities ("dispatch this implementation task to opencode"). Providers configured
via API key (NVIDIA today; any OpenAI-compatible endpoint tomorrow) sit beside these.
One abstraction: **ModelRef** = { provider: nim | openai-compat | local-cli }.

Model routing (all via NVIDIA NIM unless overridden):
| Role | Model |
|---|---|
| Primary agent | `moonshotai/kimi-k2.6` (agentic, tool-use strong) |
| Fast loop / drafts | `meta/muse-glimmer-30b` |
| Heavy reasoning fallback | `nvidia/nemotron-3-ultra-550b-a55b` |
| Embeddings | `nvidia/nv-embedqa-e5-v5` |
| Guardrails | `nvidia/llama-3.1-nemoguard-8b-content-safety` |

---

## 6. Technology Decisions

| Layer | Choice | Why |
|---|---|---|
| Repo | Turborepo + pnpm workspaces | parallel builds, shared versioning, clean package boundaries |
| Language | TypeScript (strict) end-to-end | one type system from DB to UI; agents generate typed code |
| Web | Next.js 15 (App Router, RSC) | server components for dense ERP grids; streaming agent UIs |
| API | tRPC v11 + server actions | end-to-end types without REST ceremony |
| DB | PostgreSQL 16 + Drizzle ORM | relational integrity is non-negotiable for accounting; SQL-native migrations |
| Vectors | pgvector | no extra infra; joins with transactional data; HNSW indexes |
| Auth | better-auth (multi-org) | TS-first, org/team plugins, passkeys ready |
| UI | Tailwind v4 + shadcn/ui + TanStack Query/Table | speed, accessibility, ERP-grade data grids |
| Validation | Zod 4 | shared schemas across kernel/UI/LLM function-calling |
| State machine | XState for long-running workflows (approvals, payroll runs) | inspectable, resumable processes |
| Jobs | pg-boss (Postgres-backed queues) | no Redis dependency initially; transactions + queue consistency |
| Observability | OpenTelemetry traces + structured pino logs; trajectory ledger in DB | trace every agent decision to its source data |
| Testing | Vitest (unit) + Playwright (e2e); property-based tests for ledger invariants | double-entry balance is a property, not a test case |

Monorepo layout:

```
apps/
  web/            Next.js app (ERP console + agent chat + approvals inbox)
packages/
  kernel/         capability registry, governance pipeline, event ledger, agent loop
  db/             drizzle schema + migrations (all modules)
  ai/             provider adapters (NIM, openai-compat), model router, embeddings
  auth/           better-auth config, org/RBAC
  erp-core/       pure domain logic: posting rules, tax, inventory math (no IO)
  ui/             shared component library
modules/          ERP modules (each exports capabilities + UI + schema slices)
  accounting/ finance/ hr/ manufacturing/ pos/ purchasing/ crm/
tooling/          eslint, tsconfig presets
```

Domain rule: `erp-core` is pure functions; `modules/*` may touch DB via `db`;
only `kernel` executes capabilities; only humans approve `identity/destructive`.

---

## 7. Data & Integrity Principles

1. **Append-only financial truth.** Journal entries post immutably; corrections are
   reversal entries. No UPDATE on posted documents, enforced by triggers + grants.
2. **Multi-tenant by row.** Every table carries `org_id`; RLS policies as defense-in-depth.
3. **Money as integer minor units.** Currency-aware, never floats.
4. **Ledger invariants as DB constraints.** A posting that unbalances its entry cannot
   be written at all — the agent literally cannot corrupt books if it wanted to.
5. **Event Ledger is sacred.** Hash-chained entries (pgcrypto) so audits detect tampering.

## 8. UX Principles

- **Conversation is a first-class UI**, not a sidebar bolt-on: ask anything, see the
  receipts (every answer links to its evidence rows).
- Progressive disclosure: beginners see a friendly home ("Describe your business"),
  power users get keyboard-driven tables. Same underlying capabilities.
- Approvals feel like reviewing a PR: clear before/after, one-key approve/reject.
- The assistant is proactive but polite: surfaces anomalies ("3 unpaid invoices >30d")
  and offers actions, never acts beyond policy silently.

## 9. Non-Goals (v1)

- Multi-currency consolidation, statutory localization packs (design hooks now).
- Offline/desktop app (Tauri later).
- Training/fine-tuning models (prompt/context/harness engineering first).
