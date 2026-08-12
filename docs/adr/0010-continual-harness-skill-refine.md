# ADR 0010: Continual-Harness skill refinement (`refineSkill`)

## Status

Accepted — 2026-08-08 (prototype implemented in `@chaste/ai-core`)

## Context

VISION §5.2 and ADR 0007 define customization-memory: an agent should be able to
store "how the hard customization was done" as an inspectable, reviewable object
rather than a silent embedding. Today that surface is the **skill catalog**
(`packages/ai-core/src/skills.ts`): org-scoped procedures the agent loads on
demand (`loadSkill`) and authors through an approval-gated `saveSkill`.

Prime Intellect's Prime Agent (MIT-licensed, 2026-08) popularized the
**Continual Harness** abstraction: treat the harness's own state — prompts,
sub-agents, skills, memory — as CRUDable data the agent refines *online* from its
own trajectory via `/refine`, applying the *smallest relevant, evidence-backed
edit*, with recorded snapshots for rollback and an immutable base (the base
system prompt). We evaluated borrowing the full RLM/IPython-REPL execution model
and rejected it (see Alternatives), but the refine loop maps cleanly onto our
skill catalog and satisfies the product invariant that AI acts only through
reviewable, human-approvable channels.

## Decision

Add a Continual-Harness-style **skill refinement** surface alongside `saveSkill`:

- **New agent tool `refineSkill({name, summary?, instructions?, trigger, note?})`**
  that proposes a *minimal* edit to an existing skill. `trigger` is the required
  evidence: the trajectory/audit snippet that motivated the edit.
- **Smallest-edit rule** — `buildSkillRefinement` (skills.ts) proposes only the
  fields that actually differ from the current skill; a no-op or an unknown skill
  is rejected instead of creating an approval card.
- **No state change before approval** — unlike `saveSkill` (which writes a
  disabled draft), `refineSkill` parks the proposal entirely in the Inbox `data`
  blob (`{ skillRefine: { name, before, after, trigger, note } }`). The live skill
  is untouched until a human resolves. This is stricter than Prime Agent's
  `/refine` (which self-applies) and preserves the immutable base: here the base
  is the approval gate rather than an un-editable system prompt.
- **Evidence + rollback snapshot** — on allow/always the orchestrator applies
  only the proposed fields and appends a `SkillRefinement` entry
  (`{ id, trigger, before, after, note, createdAt }`) to `skill.refinements`,
  persisted in a new `ai_skills.refinements` jsonb column. Any applied edit is
  revertible by ID from its stored `before` snapshot.
- **Revert path (shipped)** — agent tool `revertSkillRefinement({name,
  refinementId, note?})` reapplies the target entry's `before` snapshot as a new
  chained entry (`reversalRefinementId` → the entry being undone), through the
  same approval card. A revert is itself reversible (double-revert = forward
  edit again). Unknown skills / refinement ids and no-op reverts are rejected up
  front, with no state change before approval.
- **Audit coverage (shipped)** — applied refinements and reverts write an audit
  entry (`ai_skill.refine` / `ai_skill.revert`, `resourceType=ai_skill`,
  `resourceId=skill name`, carrying `refinementId`/`reversalId`, trigger and
  before/after). `success=false` with `errorCode=skill_not_found` is recorded
  when an approved edit cannot be applied.
- **Input guards (shipped)** — empty/whitespace skill name or missing `trigger`
  evidence are rejected instead of creating an approval card.
- **Same approval contract** — resolves through the same Inbox card as every
  other external action; deny leaves the skill untouched. No self-grant path.
- **Surfaced approvals** — a turn that parks a skill approval returns
  `inboxItemId` (previously only the `clarify` path surfaced it), so callers can
  link to the review card.

Lives in `packages/ai-core` (tools + approval-resolution branch), `packages/db`
(schema/migration), `packages/runtime` (Postgres persistence). UI surfaces the
catalog via API as before; no new API routes were introduced.

## Consequences

### Positive

- Skills become self-refining: the agent can propose evidence-backed lessons from
  its own runs instead of only one-shot authored procedures — the VISION §5.2
  primitive, operationalized.
- Every refinement is inspectable (trigger + before/after), reversible by ID, and
  gated by the human approval queue — no privilege elevation, no silent edits.
- Reuses the proven saveSkill approval plumbing; small, reviewable diff.

### Negative / trade-offs

- Refinements only edit `summary`/`instructions` today; title/files/memory are
  out of scope until validated.
- Skill writes still go through orchestrator → `store.upsert` directly (the
  pre-existing `saveSkill` pattern), not the kernel command bus. Gated and
  audited by the Inbox resolution, but full AI/manual parity would require moving
  both `saveSkill` and `refineSkill` behind commands.
- `trigger` is model-supplied prose; it is recorded as evidence, not verified
  against the audit trail (a verifier is future work).
- Approval density: a chatty agent could generate many refine proposals; bounded
  by the existing `AGENT_TOOL_MAX_ITERATIONS` loop and human review.

### Non-goals

- The RLM/IPython-REPL execution model (raw shell as the model's only tool).
- Un-attended self-modification; the agent never self-approves a refinement.
- Edits to the platform base prompt or to kernel/authz state.

## Alternatives considered

1. **Prime Agent's RLM execution model (persistent Python REPL as the model's
   only tool)** — reject. Wins on token efficiency but violates AI/manual parity
   and the "all execution through the command/query bus, audited" invariants
   (AGENTS.md, ADR 0003). We adopt the *state* abstraction (minimal, evidence-
   backed, reversible harness edits), never the raw-shell back-channel.
2. **Let `refineSkill` self-apply like `/refine`** — reject. Would bypass the
   approval gate; against no-elevated-AI-privileges.
3. **Rewrite skills via `saveSkill` (agent overwrites the whole record)** —
   reject. Not minimal; no evidence/rollback record; invites drift.
4. **Do nothing (authored skills only)** — acceptable MVP, but loses the
   self-improvement loop the vision calls for.

## References

- [skills.ts](../../packages/ai-core/src/skills.ts) — types, `buildSkillRefinement`, `refineSkill` tool
- [orchestrator.ts](../../packages/ai-core/src/orchestrator.ts) — agent-tool loop + approval-resolution branch
- [schema.ts](../../packages/db/src/schema.ts), [migrate.ts](../../packages/db/src/migrate.ts) — `ai_skills.refinements`
- [postgres-skill-store.ts](../../packages/runtime/src/postgres-skill-store.ts) — persistence
- Prime Agent / Continual Harness (Prime Intellect, 2026-08; MIT)
- [ADR 0003](./0003-command-layer-and-ai-parity.md), [ADR 0006](./0006-custom-ai-orchestration.md), [ADR 0007](./0007-harness-memory-and-self-dev.md)
