# Loop Engineering, Skill Steering, and Write Reliability for the Business-Tool Agent

Date: 2026-08-18
Status: Research + verified recommendations
Scope: `packages/ai-core` (`orchestrator.ts`, `providers.ts`), `apps/api/src/nl-driver-agent.ts`,
module `*_create` commands, runtime skill store.

This document answers four questions raised after the business-tool agent layer shipped:

1. What is "loop engineering" and what should our agent loop adopt?
2. How can per-module skills steer the model toward the right tools?
3. How do we stop the agent proposing superfluous/duplicate writes (e.g. creating a
   vendor that already exists)? Can Zod help?
4. Would LangChain / LangGraph / Google ADK help tool-selection accuracy? Are our
   system prompts well tuned? (And: we do **not** currently have specialist
   subagents per module.)
5. Benchmark: does `nvidia/nemotron-3-ultra-550b-a55b` shift performance vs
   `meta/muse-glimmer-30b` enough to recommend it?

All live numbers below were produced by running `apps/api/src/nl-driver-agent.ts`
against the seeded bakery org on NVIDIA NIM.

---

## 1. Loop engineering — findings and what to adopt

Loop engineering (Simon Willison, "an LLM is tools running in a loop; the art is
designing the tools and the loop") is the discipline of making the
`while (model → tool → result)` cycle reliable. The consensus (eesel 2026-06,
OpenLegion agent-loop guide, LangChain 2025 state-of-agents report, METR
time-horizon line) reduces to a few hard rules:

**Termination is a runtime property, not a model property.** LangChain's 2025
report attributes **23% of agent failures to infinite tool-call loops** — the
largest single failure category, bigger than hallucination. The failure mode we
hit live ("tool call storm" — the model re-calling the same list tool with the
same/similar args) is one of the three canonical loop failures, and it is
*triggered by underspecified termination conditions and uninterpretable tool
results*. Our current guards (duplicate-call break, iteration cap, narrate pass,
budget fallback) already implement the two most important mechanisms:

- **Hard limits** — `BUSINESS_TOOL_MAX_ITERATIONS=10` (iteration stop).
- **Partial-result degradation** — on cap/duplicate we ask the model to answer
  from gathered data, falling back to a rendered summary ("I gathered … from the
  business bus") instead of returning nothing.

Recommendations (cheap, high value):

1. **Add budget re-injection (BudgetThinker, arXiv 2508.17196).** A one-shot
   "stop at 10 steps" instruction decays; the loop should append a running
   `[step 4/10]` reminder (or a `remaining_budget` line) to each tool-result
   round. Evidence: re-injected budget reminders substantially improve
   adherence; one-time statements decay.
2. **Log the termination cause.** Each stop should record *why*
   (natural / duplicate / cap / timeout / error) so we can tune `10` from data,
   and flag any termination-type share >5% as a prompt/tool problem. Our
   `TracedProvider`/explanation parts already carry `rulesApplied` — add a
   `loopTermination` field.
3. **Keep the tool surface lean per invocation.** The strongest single finding:
   *"a single agent with 20 tools and a vague prompt performs worse than three
   agents with 5–7 tools each"* (Codemia). We currently expose **all 143
   permission-filtered tools on every turn**; that is the main latency cost
   (~8–11 s/iteration) and a contributor to storm behavior. A routed/specialist
   surface (§4, §6) is the highest-leverage change.

---

## 2. Module skills for steering

**Current state (verified in code):** the runtime `SkillStore` (`ai_skills`
table, `InMemorySkillStore`, `PostgresSkillStore`) already exists, and
`withSkillContext` (`orchestrator.ts:433-455`) injects a `[Learned context]` /
skill block into the system prompt; the `loadSkill` agent tool
(`orchestrator.ts:2570-2582`) lets the model pull a skill on demand. **However:**

- **No skills are seeded** — `seed.ts` contains zero skill rows (verified), so
  the runtime catalog is empty in practice.
- The repo-level `skills/` (module-author, command-safety, pr-hygiene) are
  *authoring* skills for coding agents, not runtime business steering skills.
- There is **no per-module skill routing**: no mechanism picks a module's skill
  based on detected intent domain; `withSkillContext` injects a flat catalog.

**Why skills help accuracy (research):** skill engineering (2025→) is the
recognized successor to prompt engineering — a skill bundles instructions +
workflow guidance + reference data, loaded on demand. SWE-Skills-Bench
(2026-03) shows measurable task-completion gains from injecting a relevant skill
vs none. Critically for us: *skills steer tool selection without enlarging the
tool list* — the guidance says "for a PO against an existing vendor, call
`pur.po.create` with a `vendorId` you resolved from `pur.vendor.list`; never
propose `pur.vendor.create` for an existing vendor." That is exactly the
counterweight to the #4 failure below.

**Security caveat (from research):** skills are a prompt-injection surface
(ToxicSkills: 36% of studied skills malicious; Snyk 2026-04). This matters only
for third-party/unvetted skills. Org-authored, versioned skills injected from our
own `ai_skills` table are low-risk and auditable — we already have the table.

**Concrete plan:**
1. Author one skill per module (purchasing, inventory, sales, accounting,
   finance, crm, hr, platform) containing: tool-selection rules, name→id
   resolution expectations, and the "check-then-write" doctrine (§3).
2. Seed them into `ai_skills` (scoped `platform`/org) so `skillCatalogText`
   populates; keep `loadSkill` for on-demand pull.
3. Add lightweight domain routing: reuse the existing deterministic intent
   classifier (the same `planSingleSegment`/rule parsers that already fire for
   the 33 deterministic NL driver cases) to inject the *matched module's* skill
   block before the loop, rather than a flat catalog. This is the "retrieve
   top-k relevant skills" (SkillRouter) pattern.

---

## 3. Preventing superfluous/duplicate writes (#4) — can Zod help?

**The observed failure:** for "Create a purchase order PO-2026-0100 for Kampala
Flour Mills…", both models *intermittently* parked plans like
`[core.bpartner.create, pur.vendor.create, pur.po.create]` — creating entities
that already exist. This is not a prompt-only bug: it is the well-documented
**false-positive creation** failure, and the research consensus
(gist "LLM Agent Deduplication", RunGuard idempotency design, agent-marketcap
2026-04) is that *guidance alone is unreliable*; you need structural guards.
Variance data from our own benchmark confirms it is **model-agnostic**
(muse and nemotron both do it on some runs, cleanly on others).

**What Zod does and doesn't do here:** Zod validates **input shape at the
boundary** (kernel `defineCommand` — already enforced for every bus command,
so a bad field never reaches SQL). But Zod is *stateless* — it cannot know
"Kampala Flour Mills already exists." It is necessary, not sufficient.

**The reliable fix is a three-layer structural guard:**

1. **Idempotent (upsert) create semantics** — the highest-leverage, cheapest
   change (RunGuard / gist consensus: "make tools inherently idempotent; return
   success either way so the model stops retrying"). For `pur.vendor.create`,
   `core.bpartner.create`, `crm.customer.create`, `inv.product.create`,
   `core.branch.create`: before INSERT, look up by natural key
   (`name` / `sku` / `code` + org). If found → return
   `{ id, name, alreadyExists: true }` instead of erroring. The model sees a
   consistent success, proposes no duplicate, and the confirm card carries no
   failing step. (Zod *does* help here: extend each command's output schema with
   an `alreadyExists` flag so the loop/UI can annotate "already on file".)
2. **Pre-tool existence gate (SPARC-style, ALTK arXiv 2603.15473)** — before
   *executing* a `*_create` tool call in `executeBusinessAgentTool`, run a
   natural-key existence check through the read bus. If the record exists, do
   **not** execute the create; return
   `pur.vendor.create skipped — "Kampala Flour Mills" already exists as
   <id>; using existing vendor` to the model and record it as a parked no-op
   (`executedWrites`) so it never re-proposes. This is inference-time guardrail
   on top of the boundary validation — exactly the "pre-tool validation gate"
   pattern, implemented with our existing `hydrateEntityRefs` machinery
   (`orchestrator.ts:2400-2489`, which already resolves names→ids through the
   read bus and throws `ENTITY_NOT_FOUND`).
3. **Plan-deduplication at confirmation time** — when assembling the
   multi-step plan (`wireSequentialPlanInputs`), collapse steps that create an
   entity whose natural key already exists in a sibling read step, and drop
   create-steps whose target already resolved. Defense-in-depth for whatever
   the model proposes.

Zod sits *underneath* all three (schema = the natural key contract). It does
not replace them.

---

## 4. Frameworks: LangChain / LangGraph / ADK

Research consensus (riverthink, dataopslabs 2026, iotdigitaltwinplm 2026):

- **LangChain** = prototyping layer (integration, chains). Not a fit for our
  reliability bar; its own docs note it requires layering for production.
- **LangGraph** = stateful graph orchestration; the durable piece we *don't*
  have. It provides checkpointing (crash-resume), `recursion_limit` (default
  25), HITL interrupts (human approval = our parked confirm cards), and
  per-worker retry budgets. It is a production-tested runtime (Klarna 85M
  users). But it is a Python/JS graph runtime, not a tool-selection model.
- **Google ADK** = structured agents + strongly typed I/O + workflows;
  governance-oriented, deep GCP affinity.

**The decisive finding:** *none of these frameworks improve tool-selection
accuracy.* They improve loop structure, state durability, and observability.
The accuracy levers are the ones frameworks themselves document: **tool
design, context engineering, and pre-dispatch validation gates**. We already
hand-roll a bespoke loop that satisfies our non-negotiables (everything through
the command bus, audit via command bus, permission filtering, transactional
outbox) — which LangGraph/ADK would not give us out of the box and would
constrain.

**Verdict:** do not adopt a framework. **Borrow three patterns** and keep the
bespoke loop:
1. **Explicit state/checkpointing** for long chains — we already persist
   session + parked plans; extend the loop to persist its `toolHistory` so a
   crashed loop can resume rather than restart.
2. **HITL interrupts as first-class** — our parked-confirm already is this;
   keep the card as the only execution path for writes under `confirm`.
3. **Per-tool-call validation gates** (§3.2) — the SPARC/ALTK middleware idea,
   applied at our `executeBusinessAgentTool` boundary.

---

## 5. System prompt tuning — assessment

Current prompt (`orchestrator.ts:3869-3884`): a flat JSON/command catalog +
agent tools + one native-tools paragraph. Gaps vs the research:

- **No budget/step tracking** is surfaced mid-loop (see §1.1).
- **The "match the write tool by name" instruction is one static sentence** and
  does not enumerate the check-then-write doctrine per module — that belongs in
  skills (§2).
- **Tool descriptions carry only `name / description / parameters`** from the
  bus; they do not say "read-only", "will park for approval", or "resolves
  names via <list tool>". Enriching descriptions (cheap, from existing
  `tags`/`minAutonomyForAuto` metadata) is the single biggest prompt-side win
  for tool selection, per context-engineering guidance (LangChain: "context
  engineering is the #1 job").
- The prompt is one giant block; context-engineering research is unambiguous
  that *scoped, re-injected* context beats a static mega-prompt (§1.1, §2.3).

Tuning priority: (1) per-module skill injection, (2) richer tool descriptions,
(3) budget re-injection, (4) keep the JSON-vs-native split (it works).

---

## 6. Specialist subagents — reality check

**We do NOT have specialist subagents per module.** The module manifests carry a
`specialist` tag (crm:160-165, purchasing:17-22) — that is a workflow-engine
routing label, not an LLM subagent. The LLM-side primitives we have are the
generic agent tools (`loadSkill`, `wakeOnJob`, `wakeOnEvent`, `memory.search/
store`) — there is no per-module subagent, no module-scoped tool set, no
orchestrator that dispatches to a purchasing specialist vs an accounting
specialist.

Research supports building this: "keep each agent's scope narrow — 5–7 tools
per specialist beats 20 tools in one vague prompt" (Codemia); AOrchestra
(arXiv 2602.03786) shows a dynamic orchestrator writing per-subtask specs beats
static roles by ~16%. Two pragmatic routes:

- **Route-by-domain (recommended v1):** reuse the deterministic intent
  classifier to pick the module; inject only that module's tools + skill into
  the loop. No new orchestration code, just tool-surface scoping — directly
  attacks latency and storm behavior (§1.3).
- **True subagents (v2):** a supervisor loop that spawns a bounded worker with a
  module-scoped `ToolRegistry.listForActor(module)` surface and collects a
  structured result. Requires the supervisor/worker contract + audit wiring;
  heavier, defer until v1 routing proves insufficient.

---

## 7. Model benchmark: muse-glimmer-30b vs nemotron-3-ultra-550b-a55b

### Setup
- Same harness: `nl-driver-agent.ts` (4 cases: 2 read, 2 write) against the
  seeded bakery org on NVIDIA NIM.
- muse-glimmer-30b: default provider path (30 s timeout).
- nemotron-3-ultra-550b-a55b: needs `chat_template_kwargs` for tool calls —
  the hosted NIM endpoint returns **HTTP 500 on tool requests without**
  `{"enable_thinking": true, "force_nonempty_content": true}` (probed live),
  and needs a longer completion timeout. Added both to
  `packages/ai-core/src/providers.ts` (nemotron-only kwargs; timeout now
  `CHASTE_AI_TIMEOUT_MS`, default 30 s).

### Results (PASS/WARN/FAIL, exit code counts only hard FAILs)

| Run | muse-glimmer-30b | nemotron-3-ultra-550b-a55b |
|---|---|---|
| 1 | 2 PASS / 2 WARN (a2, a4) | 2 PASS / 2 WARN (a2, a4) |
| 2 | 4 PASS | 3 PASS (a1 FAIL — read stall) |
| 3 | 3 PASS (a3 FAIL) | — |
| 4 | 4 PASS | — |

Best-case: **4/4 for both.** Neither model is decisively more accurate on this
benchmark; both are stochastic on write-tool selection, and **both
intermittently propose the superfluous `pur.vendor.create`/`core.bpartner.create`
#4 failure** (nemotron once parked a clean single `pur.po.create` with a real
vendor id in an isolated smoke test, muse has done the same — i.e. the
systemic fix in §3 is required regardless of model).

### Performance / ops
- **muse-glimmer-30b**: ~8–11 s per tool-loop iteration, ~10–90 s per request;
  ~29.6 B dense; no special request params.
- **nemotron-3-ultra-550b-a55b**: ~50–90 s per request in our harness; 55 B
  active / 550 B total MoE; up to 1M ctx; needs `chat_template_kwargs` +
  longer timeout; independent tool-use eval (CrucibleMark 2026-06) flags
  `tool_call_valid=No` format compliance issues in MCP pipelines and slow
  runtimes (167 s total).

### Recommendation for user-facing model tiers
- **Default (recommended): `meta/muse-glimmer-30b`** — adequate accuracy at
  materially better latency/cost for the interactive confirm-driven UX.
- **"Capable / deep-analysis" tier: `nvidia/nemotron-3-ultra-550b-a55b`** —
  open-weight 1M-context option for long-horizon, analysis-heavy requests
  (research/reporting over many docs), accepting slower confirm-card latency.
  Config: `CHASTE_AI_MODEL=nvidia/nemotron-3-ultra-550b-a55b` +
  `CHASTE_AI_TIMEOUT_MS=240000`.
- Do **not** recommend a model tier as the fix for #4 — the benchmark shows the
  write-redundancy problem is model-agnostic; fix it structurally (§3).

---

## 8. Recommended work order (highest leverage first)

1. **Idempotent creates** (upsert by natural key + `alreadyExists` in output
   schema) for vendor/bpartner/customer/product/branch — kills #4 at the root.
2. **Pre-tool existence gate** in `executeBusinessAgentTool` (skip + report
   "already exists", mark as executed no-op).
3. **Per-module skill seeding + domain routing** (reuse deterministic intent
   classifier → inject module skill + module-scoped tool set).
4. **Budget re-injection + termination-cause logging** in `runBusinessToolLoop`.
5. **Richer tool descriptions** (read-only / parks-for-approval / resolves-via).
6. v2: supervisor + module-scoped worker subagents only if routing (3) proves
   insufficient.