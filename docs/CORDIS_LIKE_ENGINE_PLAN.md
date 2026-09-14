# Cordis-like Engine for ChasteBusinessOS

Status: architecture plan on branch `cordis-like-engine`  
Date: 2026-09-09  
Decision scope: whether and how to combine DeepSeek Harness ideas/source with the existing agentic ERP

## Executive decision

Proceed.

The right target is a **Chaste Business Harness** with a DeepSeek/Cordis-inspired
composition runtime. Chaste's existing capability kernel remains the authority for
identity, tenant isolation, permissions, approvals, money, reversibility, and audit.
Cordis-style composition becomes the layer that mounts and recomposes models, tools,
skills, loops, sessions, sandboxes, schedulers, UI adapters, and ERP modules.

This gives us the best of both systems:

```text
Cordis-style composition and lifecycle
              ↓
Chaste Harness boundary: context, events, profiles, replay, sandboxes
              ↓
Chaste capability kernel: Zod, permissions, policy, approvals, inverse, ledger
              ↓
ERP domain modules: accounting, inventory, HR, CRM, and the rest
```

The ERP itself becomes the coding and operations agent, but its self-modification
is a governed delivery pipeline. Production can request, observe, approve, and
consume a release; production never edits or executes unreviewed platform code.

## Reliability verdict

As of 2026-09-10, Chaste can execute **bounded, governed multi-step tasks**:
the loop makes sequential model/tool calls, every ERP action goes through the
kernel executor, approvals are enforced, durable jobs exist, routines can run
proactively, and golden trajectories test the governance path.

We cannot yet claim reliable Hermes-level long-running or proactive execution.
The current implementation has several observable limits:

- interactive runs keep progress in process memory and stop at a fixed step cap;
- a process restart cannot resume a partially completed agent task;
- trajectory persistence is fire-and-forget and logs a failure rather than making
  the run fail or recover, so a replay can have gaps;
- the kernel has no universal action idempotency key, so a retry after an uncertain
  write can duplicate a non-idempotent effect;
- queue jobs have no visible lease/heartbeat recovery, and scheduled routines
  advance their schedule before the run completes, so a crash can skip work;
- routine runs are read-mostly and bounded, but do not yet have deterministic
  prechecks, durable continuations, or chained run context;
- compaction replaces old material with generic stubs and the loop exposes a broad
  capability set instead of progressively loading only the relevant tools;
- current evals prove governance and refusal behavior, not task completion,
  crash recovery, duplicate-effect resistance, or proactive-run quality.

The accurate product claim today is: **“Chaste executes bounded, governed agent
workflows and scheduled read-mostly routines.”** The stronger claim—**“Chaste
reliably completes resumable, replayable, multi-step business tasks and proactive
routines”**—becomes valid only after the reliability gates in this plan pass.

This also matches the useful lesson from Hermes: persistent memory, skills,
scheduled jobs, and delegation are product capabilities, while long-lived work
must be backed by durable jobs rather than process-local delegation. We will adopt
those behaviors through Chaste’s governed runtime.

## What to borrow and what to keep out of the production core

| DeepSeek/Cordis concept | Chaste treatment |
|---|---|
| Everything is a plugin | Adopt. ERP modules, agent tools, skills, models, memory, loops, schedulers, sandbox adapters, and UI surfaces expose typed composition seams. |
| Cordis context/services | Adopt behind `@chaste/harness`; services may compose, inject, mount, unmount, and publish events. A service cannot bypass the kernel executor. |
| Reversible plugin effects | Adopt. Mount/unmount and config updates must be transactional and leave a restoration path. |
| Profiles, bundles, and patch layers | Adopt for agent/runtime composition. Keep tenant configuration versioned and policy-controlled. |
| Typed events and lifecycle waterfalls | Adopt for runtime extension points; durable facts also enter the Chaste event ledger. |
| Session append log and trajectory viewer | Replace with the true replay contract below. Existing `session_events` becomes a projection of a richer run log. |
| Model/tool/skill/loop swapping | Adopt, but every ERP tool remains a governed Chaste capability. |
| Local shell/filesystem tools | Isolate in a dev sandbox. Never expose them to a production agent merely because the harness can mount them. |
| DeepSeek web UI and desktop shell | Do not transplant wholesale. Keep the Chaste ERP UI; selectively borrow trace, preset, plugin, and runtime-inspection interaction patterns. |
| DeepSeek approval and permission model | Do not use as the ERP authority. Adapt its UX to Chaste's RBAC, RLS, risk classes, approval policy, and inverse semantics. |
| Upstream package graph | Do not make it a transitive dependency of every ERP module. Vendor or wrap only the parts that pass the Chaste compatibility boundary. |

## Target architecture

### 1. Composition runtime

Add a `@chaste/harness` package, initially an adapter rather than a replacement
for `@chaste/kernel`. Its responsibilities are:

- load a versioned runtime profile from ordered bundles and patches;
- mount services with declared dependencies and lifecycle cleanup;
- expose typed service keys rather than concrete implementation imports;
- publish live runtime events and route durable facts to the event ledger;
- compose per-session modes and capabilities;
- expose runtime inspection without exposing secrets;
- support profile validation, deterministic dumps, and safe reload in dev only.

The first adapter should be able to mount the current Chaste registry, model
adapter, session store, memory, job queue, approval service, and ERP modules. It
must fail closed if a capability graph is incomplete, an inverse is missing where
required, a schema cannot serialize, or a plugin requests an authority outside its
profile.

### 2. Capability bridge

The bridge is the non-negotiable seam:

```text
agent/plugin tool request
  → tool schema validation
  → Chaste capability resolution
  → actor/org/tenant scope
  → permission and policy evaluation
  → approval or execution
  → inverse/effect record
  → durable event + projection
```

Cordis plugin composition may decide which capability is visible or which adapter
implements it. It may not call a module's database function directly from an agent
loop. Human clicks, scheduled runs, and agent calls continue to share one executor.

### 3. Profiles and environments

Ship explicit profiles rather than scattering `if (NODE_ENV)` checks:

- `erp-prod`: customer operations; no source writes, no arbitrary process launch,
  no plugin installation, no code execution, no runtime registry mutation;
- `erp-dev`: same ERP modules and schema, plus sandboxed code/build/test tools and
  feature-gap intake;
- `erp-review`: isolated candidate image plus synthetic/replayed data for review;
- `erp-worker`: durable jobs, evaluation, notifications, and promotion orchestration
  under a least-privilege service identity.

The images and migrations should be identical where possible. Behaviour is
selected by a signed, versioned profile and environment policy. Environment
variables may select the profile at boot, but must not silently grant authority.

### 4. Plugins and ERP modules

Every plugin/module declares:

- stable id and version;
- provided services, capabilities, events, and UI surfaces;
- required services and module dependencies;
- data migrations and rollback/forward-compatibility policy;
- risk classes, permissions, approval policies, and inverses;
- configuration schema and secret references;
- compatibility range for the Chaste Harness contract.

The existing signed marketplace manifest is a starting point, but platform code,
tenant plugins, and user-authored skills must be separate trust tiers. A signed
package proves publisher identity and integrity; it does not make arbitrary code
safe to run.

## True replay contract

The current session page replays ordered `session_events`, which is valuable for
transparency but is not yet deterministic replay. A true replay implementation
must distinguish three operations:

1. **Audit playback** — render exactly what happened from recorded events. No model
   or tool is called.
2. **Deterministic replay** — re-run the same harness against recorded model
   responses, tool observations, clocks, random seeds, configuration, policy, and
   capability graph. External effects are simulated or rejected.
3. **Fork/run** — start from a recorded checkpoint, change the user request,
   policy, model, or profile, and create a new child run with explicit lineage.

Every run and event needs, at minimum:

- run/session id, parent run id, branch id, event id, monotonic sequence;
- event type, schema version, actor, tenant/org, causation id, correlation id;
- harness profile id/version and composition digest;
- capability registry digest and policy/config revision;
- model/provider reference and request/response snapshots, with secret/PII
  redaction or encryption policy;
- exact tool name, validated input, result/error, approval decision, and effect id;
- external observations (database snapshot/version, HTTP fixture, file snapshot,
  clock, random seed) or an explicit `nonReplayable` reason;
- input/output hashes and hash-chain links;
- status transitions, cancellation, retry, timeout, and partial-failure events.

Replay must refuse to claim determinism if a required observation is missing. A
replayed write runs in a transaction or a simulator and produces a diff; it cannot
post money, send messages, install code, or mutate production. Financial replay
must prove the same balanced postings and the same reversal/inverse behaviour.

The existing trajectory table can remain as a read-optimized projection, but the
canonical run log should be append-only and immutable. Compaction may create a
derived checkpoint; it must never delete the source events needed for audit or
replay.

## Reliability foundation: the smallest hardening set

This is the minimum needed before claiming dependable multi-step or proactive
operation. It deliberately uses the existing Postgres queue, capability kernel,
session events, and policy system rather than introducing a new workflow platform.

### Durable task state and resume

Introduce a durable `agent_runs`/task-state record linked to the session. Persist
after every model step and governed action:

- run status: `queued`, `running`, `waiting_user`, `waiting_approval`, `retrying`,
  `paused`, `completed`, `blocked`, or `failed`;
- current step, max steps/time budget, next action, checkpoint id, and last error;
- task contract/acceptance predicate and the profile/toolset digest used;
- parent/child lineage for forks or delegated work.

On worker or server restart, a run resumes from its last committed checkpoint or
is reported as blocked. A final assistant message alone is never treated as proof
of completion; an acceptance predicate or deterministic verifier must pass.

### Idempotent effects and recoverable jobs

Give every governed action attempt a key such as `(runId, step, toolCallId)` and
make the executor record/replay the prior result for a repeated key. Database
effects and the effect record must commit together where possible. External sends
use an outbox/idempotency key and report `unknown` when delivery cannot be proven.

Add a short lease, heartbeat, bounded retry with backoff, and stale-claim recovery
to jobs. A job must not remain permanently `processing` after a worker crash.
Routine scheduling should create a unique scheduled-run record before enqueueing,
advance schedule state according to an explicit missed-run policy, and distinguish
`not_started`, `running`, `succeeded`, `failed`, and `skipped`.

### Efficient context engineering

Adopt a stable, layered context contract:

```text
stable system/profile/policy prefix
  → organization invariants and memory digest
  → task contract and durable checkpoint
  → selected skills and capability schemas
  → recent observations and unresolved approvals
  → current user request / current step
```

The stable prefix must not be rebuilt unnecessarily during a run, preserving
provider prompt-cache opportunities. Tool schemas should be loaded by task/module
profile or a capability-discovery step, not every capability in the organization.
Older context should compact into a structured checkpoint containing decisions,
facts with evidence, completed actions, pending actions, refusals, and invariants;
generic “earlier output compacted” stubs are only a fallback.

Every run records context-layer sizes, selected tools, compactions, input/output
tokens, and cached-input tokens. This makes context efficiency measurable without
guessing from prompt length.

### Proactive execution that earns trust

Before waking the model, a routine may run a deterministic precheck over signals,
timestamps, or new records. If nothing changed, it records a successful silent
tick without spending model tokens. If the precheck says to wake the model, its
output becomes bounded, labelled context—not an instruction source.

Proactive runs get the same durable run state, leases, retries, idempotency, and
acceptance checks as interactive runs. They default to read/draft behavior, emit a
visible notification on failure, suppress only successful no-action results, and
can optionally continue from the previous successful brief through explicit,
tenant-scoped context links.

### Reliability evaluation

Extend the existing golden trajectory suite with a small scenario matrix:

- a 5–10 step cross-module task with a deterministic acceptance predicate;
- model/provider timeout at every step boundary, followed by resume;
- worker crash after capability execution but before job acknowledgement;
- duplicate delivery of the same tool call and external outbox event;
- compaction while approvals and unresolved actions are present;
- prompt injection in a document, memory, signal, and tool result;
- proactive no-change, changed-signal, failed-run, retry, and missed-schedule cases;
- context-size and cached-input measurements for the same task at different history
  lengths.

Report completion, blocked, refusal, duplicate-effect, recovery, replay, and
context-cache results separately. Do not reduce reliability to one aggregate score.

## Self-configuration and self-evolution

Self-evolution is a controlled promotion ladder, not one permission called
`selfEvolve`:

```text
observe gap
  → clarify desired behaviour
  → classify: answer | config | skill/workflow | tenant plugin | platform code
  → generate behavioural contract + fixture
  → build in isolated dev workspace
  → run tests, replay, security, and policy checks
  → create signed proposal/artifact
  → human review and approval
  → CI/release candidate
  → review environment/canary
  → promote
  → monitor and rollback via inverse/release rollback
```

Default autonomy should stop at the lowest rung that solves the problem:

- **Configuration:** agent may propose org settings/workflows; sensitive changes
  remain policy-gated.
- **Skills/workflows:** agent may author a versioned, sandboxed declarative skill;
  activation is reviewed and scoped.
- **Tenant plugin:** signed package, isolated permissions, migration plan, tenant
  enablement, and rollback.
- **Platform code:** branch/worktree, tests, security review, human merge, CI,
  staged release; never a production filesystem write.

## Production-to-development feature pipeline

### Recommended trust boundary

Do not give the development agent a production database credential or a broad API
key. Use an outbound-only, authenticated exchange:

```text
Production ERP
  └─ creates FeatureGap + sanitized replay fixture + desired-behaviour contract
      └─ signed outbox/event → queue or artifact store
          └─ dev worker polls with its own scoped service identity
              └─ isolated Docker worktree/build/test/replay
                  └─ ChangeProposal + evidence + candidate image/artifact
                      └─ human/security/CI gates
                          └─ signed promotion → production deploy system
```

The dev worker may read only the feature-gap envelope and approved synthetic or
redacted fixtures. If a production observation is necessary, production creates a
new narrowly scoped, expiring export capability and records it in the ledger.
The worker cannot query arbitrary production tables, invoke money/identity actions,
or write back to the production database.

The queue should be durable and idempotent. A gap envelope needs tenant scope,
originating session/run, classification, desired behaviour, reproducible fixture,
data-sensitivity classification, priority, and expiry. The result needs the
proposal id, source/revision, image digest, test/replay evidence, security
findings, reviewer decisions, rollout plan, and rollback plan.

### Progress visibility

Model feature implementation as a first-class `evolution_run` with append-only
status events. The UI should show:

`requested → triaged → specified → fixture-ready → building → testing → replaying → review → approved → candidate → staged → promoted → monitored → rolled-back`

Users see the current state, evidence links, blockers, next actor, and last update.
The agent's detailed trajectory remains available, but progress must not depend on
reading raw model reasoning. A failed or abandoned run stays visible with an honest
reason and can be retried or forked.

## Behavioural contracts for agent-built changes

To make existing features reproducible “as though built by the harness”, every
new or migrated capability should have a structured behavioural contract:

- desired behaviour in user language;
- actor, tenant, and preconditions;
- input/output schemas and example calls;
- capabilities used and forbidden bypasses;
- policy/approval expectations;
- domain invariants and inverse/reversal rules;
- emitted durable events and projections;
- negative cases and refusal language;
- deterministic fixture and replay expectation;
- UI/progress observables;
- compatibility, migration, and rollback notes.

This is the canonical input to the coding agent, tests, review, and replay. A
prompt alone is not a specification. Existing modules should be migrated
incrementally, beginning with the trust spine and one representative cross-module
flow rather than rewriting all ERP modules.

## Depth tree and delivery phases

### Phase 0 — decision and upstream inventory

- Freeze the upstream commit(s) under consideration.
- Produce a source inventory: Cordis, loader, bundles, sessions, loop, sandbox,
  replay fixtures, presets, workflows, UI, desktop, native components.
- Decide whether to vendor Cordis source, consume a package, or reimplement the
  small compatibility surface.

Exit gate: the upstream inventory and adoption boundary are approved.

### Phase 1 — composability boundary

Deliver `@chaste/harness` with profile, bundle, service, dependency, lifecycle,
event, and config patch contracts. Mount one existing ERP module and one model
adapter. Prove unload/reload leaves no stale registrations. No production UI
rewrite yet.

Exit gate: composition tests pass and all capability calls still traverse the
existing kernel governance path.

### Phase 1.5 — reliable multi-step and proactive execution

Add durable run checkpoints, resume/restart semantics, action idempotency,
queue leases and stale-claim recovery, routine scheduled-run records, explicit
retry/missed-run policies, deterministic proactive prechecks, structured context
checkpoints, lazy task toolsets, and the reliability scenario matrix.

Exit gate: a multi-step task resumes after injected failure without repeating a
committed effect; a scheduled run neither disappears nor duplicates; context
compaction preserves pending actions and invariants; and the same task reports
measured completion/recovery/cache behavior across repeated runs.

### Phase 2 — canonical run log and true replay

Add immutable run/event schema, hashes, lineage, checkpoints, observations,
replayability classification, audit playback, deterministic replay fixtures, and
forks. Prove the accounting invoice/payment flow can be replayed without calling a
live model or posting a second payment.

Exit gate: replay has a failing test for missing observations and a passing
round-trip proof for a governed ERP flow.

### Phase 3 — behaviour specs and evolution records

Add versioned behavioural contracts, `feature_gaps`, `evolution_runs`, status
events, desired-state/config proposals, and a UI read model. Convert one existing
capability gap into a visible ticket and a replay fixture.

Exit gate: a user can see progress and an agent can honestly stop at a missing
capability without improvising.

### Phase 4 — isolated development pipeline

Add the dev worker, queue/outbox exchange, Docker worktree, synthetic fixture
builder, test/replay runner, artifact digest, proposal evidence, and promotion
handoff. Add explicit production-deny policy tests.

Exit gate: a production-originated gap can become a reviewed candidate without a
production credential and without modifying production code or data.

### Phase 5 — safe self-configuration and plugin evolution

Start with declarative workflows and skills, then tenant plugins, then platform
code. Add trust tiers, signed manifests, scoped permissions, migration gates,
canary/rollback, and per-tenant enablement. Avoid arbitrary code execution in the
default org environment.

Exit gate: each rung has distinct permissions, evidence, approval, and rollback;
there is no path from ordinary user input directly to a production code write.

### Phase 6 — UI integration and operational hardening

Keep the Chaste shell and ERP navigation. Add runtime composition inspection,
profile/preset display, replay/fork controls, evolution progress, proposal diff and
evidence views, and audit/export surfaces. Perform threat modeling, tenancy tests,
load tests, backup/restore replay tests, and a penetration review.

Exit gate: full verification gate plus end-to-end tests for the user → agent →
capability → approval → event → replay → proposal → promotion story.

## Initial depth-tree ownership

| Leaf | Contract | Primary ownership | Needs |
|---|---|---|---|
| A | Upstream technical inventory and compatibility boundary | `docs/`, integration manifests | none |
| B | Harness composition boundary and Cordis adapter | `packages/harness/`, `packages/kernel/` contracts | A |
| C0 | Durable task state, recovery, idempotent effects, proactive prechecks, and layered context | `packages/db/`, `packages/kernel/`, jobs/routines, eval tests | B |
| C | Canonical run log, hashes, observations, audit/deterministic/fork replay | `packages/db/`, `packages/kernel/`, replay tests | C0 |
| D | Behavioural contract schema and migration fixtures | `packages/kernel/` or `packages/specs/`, `docs/` | B |
| E | Feature-gap/evolution pipeline and dev-worker exchange | `modules/creator/`, jobs, new worker/service | C, D |
| F | Sandbox, artifact, CI, promotion and rollback | worker/deployment tooling, security docs | A, C, E |
| G | Chaste UI: runtime inspection, replay/fork, progress, proposals | `apps/web/src/` | C, E |
| I | Integration, threat model, demos, regression suite | repo-wide | B–G |

No leaf should be dispatched until its exact interface, ownership, and gate file
are written. The first implementation wave should be A, followed sequentially by
B and C0; C/E/F/G should not start against an unproven recovery/context contract.

## Explicit non-goals for the first implementation

- Do not replace all existing ERP modules or migrate all UI surfaces at once.
- Do not expose a production shell, filesystem, network, or package manager to an
  agent.
- Do not let an agent merge code, promote a release, grant identity permissions,
  post money, close a period, or alter audit history without the existing gates.
- Do not call a transcript viewer “true replay”.
- Do not give dev a standing production API key or direct production database
  access.
- Do not promise arbitrary customer code execution merely because plugins are
  composable.

## First proof slice

The first end-to-end proof should be deliberately small but hard to fake:

1. A user asks for a missing capability in the ERP.
2. The agent files a gap with a desired-behaviour contract.
3. Production emits a sanitized fixture and no production credential is shared.
4. The dev worker builds a proposal in an isolated Docker worktree.
5. The worker runs deterministic replay of a known accounting flow and proves no
   second money effect occurs.
6. The UI shows every evolution status and evidence artifact.
7. A human rejects once and approves once; both decisions are replayable and
   audited.
8. A signed candidate is promoted only through the deployment boundary, then a
   rollback proof restores the prior version.

That slice validates the core thesis before adding broad self-evolution power.


## Enterprise planning extension (2026-09-10)

Read [Enterprise Evolution Plan](ENTERPRISE_EVOLUTION_PLAN.md) alongside this proposal. It extends the backend, autonomy, UX/UI, onboarding, developer experience, security, performance and continuous self-development scope with source findings and acceptance gates. Its delivery programme supersedes the ordering above: transaction integrity and durable recovery precede general harness composition. The original proposal text is preserved; this extension does not claim those features are implemented.
