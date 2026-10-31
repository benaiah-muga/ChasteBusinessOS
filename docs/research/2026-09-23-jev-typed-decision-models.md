# Research: Jev and typed-decision ("System One") models in Chaste BusinessOS

Date: 2026-09-23. Status: research note, no decision taken. An ADR should follow if
we adopt any of the recommendations below.

## TL;DR

Jev (TypeSafe AI) is the flagship of a one-week-old model category: small,
non-generative models that take a state plus typed questions and return typed
decisions (a yes/no probability, a distribution over K choices, an ordinal
score) in a single forward pass, with calibrated confidence and no text output.
The pattern is genuinely useful for one class of problem this project has:
fast, low-stakes, high-volume judgments that today either go through a full LLM
turn or do not happen at all.

Verdict for this repo: **worth piloting in three places, not worth it in most
others.**

| Fit | Integration point | Decision type |
| --- | --- | --- |
| Yes, pilot | Capability pre-filter/ranking before the agent loop | choice over modules + multi-label over capability ids |
| Yes, pilot | Approval inbox triage (rank first, auto-approve last) | noul gate + score |
| Yes, pilot | Policy-engine guardrail gate, fail-closed to approvals | noul |
| Maybe later | One-shot intent dispatch in chat | choice |
| Enabler | Embed the capability intents (promised by conformance, never built) | infrastructure |
| Not now | Ledger event tagging, model routing | no labeled data yet |
| Never | Domain math, postings, anything in erp-core | must stay pure functions |

Non-negotiable design rule if we adopt: integrate against the open
`/v1/systemone` wire protocol behind our own interface, so the hosted Jev is
swappable with a self-hosted Laya/kev later. Confidence outputs are treated as
ranking scores and rescaled on our own labeled data; every automated decision
is confidence-gated and fails closed into the existing approval flow.

## 1. What Jev is

Product facts, all from TypeSafe's docs ([docs.typesafe.ai](https://docs.typesafe.ai)):

- Endpoint `POST /v1/systemone`, request is `{ model, state, questions }`,
  response is typed answers per question id. Current model `jev-1.13.0`
  (aliases `jev-latest`, `jev-preview`).
- Exactly three primitives: **noul** (P(yes) in 0..1), **choice** (1-255
  options, returns `choice`, `probabilities`, `confidence`), **score** (2-10
  ordered levels, probability-weighted mean). Multi-label is composed as
  several independent noul flags, not a fourth primitive.
- All questions in one call are evaluated independently and in parallel
  against the shared state; adding questions barely changes latency
  ("speculative fan-out": one cookbook measured 12.2x cheaper and 10x faster
  than sequential calls).
- Price: $42 per billion input tokens ($0.042/Mtok), output tokens free. 64k
  context per request (32k for state plus the longest question). Text only.
- Training: RLCD (reinforcement learning with proper-scoring-rule rewards) on
  100% synthetic data. Not fine-tuned per customer. Cloud API only: no
  on-prem or weights offering; also distributed via Vercel AI Gateway and
  OpenRouter.
- Latency: marketed "about 100 ms"; independent measurements put hosted calls
  at 236-280 ms p50 including network (AbdelStark/jev-benchmarks,
  nibzard/decision-model-benchmark, cited in the Laya README; Cua on
  [HN](https://news.ycombinator.com/item?id=49767564)). Plan around ~250 ms.

Architecture is unpublished. The best public reconstruction is Archer Hume's
black-box probing essay ([Jev's Architecture Unmasked](https://archerhume.com/posts/jevs-architecture-unmasked)):
a causal transformer with a shared state encoding, isolated per-question
branches (questions cannot read each other, which is why adding questions does
not cause context rot), and direct probability readouts instead of generation.

## 2. The open ecosystem (all September 2026)

| | Jev | Open-Jev | Laya | kev |
| --- | --- | --- | --- | --- |
| Access | hosted, closed | open LoRA + scalar head | open checkpoints | open LoRA + pointer head |
| Backbone | unknown (MoE suspected) | Qwen3.5 2B/9B, 27B v1.1 | ModernBERT 421M / mmBERT 322M | Qwen3.5 0.8B/4B/9B |
| Latency | ~250 ms p50 measured | self-hosted | 33 ms/q on T4, 7.2 batched; ~7-13 ms MLX | 118 ms on L4 |
| Calibration | best published (Brier 0.211, 3.7% confident-wrong) | ECE 0.0077 in-dist / 0.037 OOD | ECE 0.081 after temp-fit | ECE 0.042 after temp-fit |
| Generalization | strongest (wins above ~50 options) | careful held-out suite | weak zero-shot; needs fine-tune | -3.5 pts vs Jev on new sources |
| License | proprietary | Apache-2.0 / CC0 data | Apache-2.0 | Apache-2.0 |

Key links: [Laya](https://github.com/NandhaKishorM/laya) (wire-compatible
`/v1/systemone` server, 100+ languages with a per-request router),
[kev](https://github.com/jaredpalmer/kev) (train-your-own, best-in-class
honest eval methodology),
[Open-Jev](https://huggingface.co/ZefanCai/Open-Jev-9B),
[awesome-jev](https://github.com/yibie/awesome-jev) (400+ entries across
routing, guardrails, agent decisions, finance; the list itself warns that
same-day bulk submissions are unproven).

Community-measured benchmark caveats: Laya beats Jev on aggregate typed
accuracy (0.766 vs 0.727) but collapses on high-cardinality choice (Banking77
0.425 vs Jev 0.870, a token-budget artifact); Jev wins soft accuracy,
calibration and automation share at a 5% error budget (0.70 vs kev's
0.45-0.57). The [openjev-heldout suite](https://huggingface.co/datasets/s1lv3rj1nx/openjev-heldout)
exists because in-distribution numbers mislead.

## 3. Honest framing (what the skeptics established)

These points change how we would deploy, not whether the category is real:

1. **"Deterministic" is the wrong word.** Outputs are probability
   distributions; the decision is an external threshold or argmax. Same is
   true of every neural net. The honest claim: single-pass, typed schema,
   trained calibration.
2. **Calibration is distribution-relative and contested.** Alex Molas's
   [Jev can't be calibrated](https://www.alexmolas.com/2026/09/23/jev-cant-be-calibrated.html):
   the same API output cannot be calibrated for two orgs with different base
   rates; an X experiment got p=0.92 for heads on a stated-fair coin; noul and
   choice calibrate differently per Distill Labs. TypeSafe's own
   [jaggedness doc](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
   concedes literal instruction reading, no counting, no date arithmetic,
   long-context degradation. Consequence: treat outputs as ranking scores,
   fit a Platt rescale on our own labels, never ship a vendor threshold.
3. **It is 2019 intent classification plus a universal zero-shot wrapper.**
   Pre-GPT practitioners recognized it immediately and warn about the accuracy
   ceiling ([HN](https://news.ycombinator.com/item?id=49787404)). The genuine
   delta is the no-data regime: zero-shot across arbitrary schemas with
   trained calibration. SetFit/DeBERTa stay stronger per-task once we have
   hundreds of labels.
4. **No moat.** Six open clones in two days; frontier tool calling already
   uses output tokens as implicit micro-classifiers
   ([Arcturus Labs](https://arcturus-labs.com/blog/2026/09/21/will-openai-eat-jevs-lunch/)).
   AnyJev turns any LLM into a decision model with no training. The wire
   protocol is the only stable thing, which is exactly why we should bind to
   it, not to TypeSafe.
5. **Scoped specialists beat the general decision model**: CUA-S1, 706k
   parameters, beat hosted Jev 99.7% vs 83.6% on its own form task.
6. **Known failure modes to test**: option-order sensitivity (kev ships a
   `/permute` probe), confident wrong answers out-of-language (Laya scores
   0.000 on Khmer at 0.952 confidence), prompt-injection weakness (Laya 0.698,
   n=116), score-primitive compression against existing rubrics (HN user
   reports), long-context decay (kev 0.92 short docs to 0.75-0.79 long).

## 4. Why this repo is unusually good ground for it

The typed-decision category needs three inputs to be safe: a closed decision
vocabulary, labeled outcome data, and a fail-closed escalation path. This
project already has all three:

- **Closed vocabulary**: 256 capabilities across 20 modules, each with a
  validated `module.action` id, an intent sentence protected by conformance
  (`assertWellFormedCapability`, packages/kernel/src/conformance.ts:20-67),
  a risk class, and Zod schemas. The decision space is enumerated by
  construction.
- **Labeled outcome data, already accumulating**: every action lands in the
  hash-chained ledger (`capability.executed` / `capability.failed`, with
  capabilityId, actor, sessionId) and every human governance decision lands in
  the `approvals` table (capabilityId, riskClass, payload, decidedByUserId).
  That is a routing training set and an approval-triage training set nobody
  has to label by hand.
- **Fail-closed escalation already exists**: `PolicyDecision` /
  `PolicyEngine.evaluate` (packages/kernel/src/policy.ts:3-11) and the
  approval flow (executor.ts:140-163) mean a low-confidence model answer has
  somewhere honest to go: the approval queue, exactly as designed.

Also notable: the conformance message says capability intents are "embedded
for agent retrieval", but no code embeds them. `registry.search` is
keyword-overlap only (registry.ts:94-107, with a comment admitting the
embeddings layer is not built), and `runAgentLoop` ships every permitted
capability to the model as a tool with no pre-filter (loop.ts:139-162). At 256
capabilities that is already heavy; it grows with every module.

## 5. Recommended pilots, in order

### Pilot A (enabler, no model): embed the capability intents

Embed every registered capability's `intent` into pgvector (1024-dim, same
`embed()` from packages/ai/src/providers.ts:289) at registry build, and add a
real semantic `registry.search`. This makes the existing conformance promise
true, benefits the agent today (smaller tool lists, better retrieval), and is
the substrate pilots B and C measure against. Pure existing-infra work.
Evaluate with scripts/agent-pilot-eval.ts: does a retrieved shortlist contain
the capability the demo run actually executed?

### Pilot B: agent-loop capability pre-filter (choice + multi-label)

Before constructing `tools` in loop.ts:139-162, ask one typed-decision call:
a choice over modules (20 options, well inside the K<=255 envelope) plus noul
flags over candidate capabilities, using the session goal as state. Ship the
shortlist to the LLM; keep a deterministic escape hatch ("none of these" below
threshold ships the full list, never a guess). Data: ledger events joined with
session trajectories. Cost today is near zero either way (256 tool specs are
not yet a latency problem), so the pilot's real output is the eval harness and
the accuracy number we will need as the registry grows. Shadow mode first:
log the decision, ship the full list, compare.

### Pilot C: approval triage (noul + score, ranked not auto)

Score incoming `ApprovalRequest`s in `DbApprovalFlow.submit`
(apps/web/src/server/kernel.ts:371-385) and rank the /api/approvals inbox;
auto-approve nothing initially. The approvals table gives human
approve/reject outcomes as labels. When the measured confident-wrong rate on
our own data justifies it, consider auto-approving only the safest band
(mirror of jev-oncall's page-at-0.80 / human-band / drop-at-0.20 pattern, but
starting from "human decides everything, model orders the queue"). The
maker-checker policy (requiresApprovalFor) must remain the authority; the
model only reorders and annotates.

### Later candidates

- **Policy-engine guardrail gate** (noul, fail-closed): a decorator on
  `PolicyEngine.evaluate` that can force `requiresApproval` on suspicious
  inputs. Blocked on pilot-grade injection red-team results; the research
  found prompt-injection resistance weak (Laya 0.698), and this is the highest
  blast-radius seam in the repo.
- **One-shot intent dispatch** in the chat route: map a short request to a
  capability and skip the agent loop for common cases. Attractive economically
  (elvex categorized 2,000 expense reports in 20 seconds for five cents), but
  it quietly changes the product's "every action goes through the governed
  pipeline" property only if arg extraction is skipped; needs its own design.
- **Ledger tagging** for audit search: fine idea, no urgency, no eval set.

### Where it is not worth it

- Anything in packages/erp-core: domain math stays pure functions; property
  tests, not probabilities.
- Posted financial documents: immutable by design; no model decides them.
- Multi-step planning, ambiguous-intent clarification, anything needing
  generated text: that is the LLM's job (System 2 in the category's own
  vocabulary). TypeSafe's own docs scope Jev to atomic, few-second gut-check
  questions and tell you to compose factors in code, which matches the kernel
  philosophy exactly.
- Model routing: we have no data linking turn difficulty to model choice.

## 6. Adoption rules (draft for the future ADR)

1. Bind to the `/v1/systemone` wire protocol behind a small internal client;
   hosted Jev and self-hosted Laya/kev are interchangeable behind it. Never
   call TypeSafe directly from domain code.
2. Confidence is a score, not a probability, until rescaled on our labeled
   data (Platt/isotonic per primitive); thresholds are ours, set on
   coverage-vs-error curves, revisited monthly.
3. Every automated decision is confidence-gated; below threshold flows to the
   existing approval flow. Low confidence never guesses (the jevonian pattern:
   log it in the ledger, do not act on it).
4. Decisions that gate state changes are recorded in the ledger entry (model,
   question ids, probabilities, threshold) so the audit chain explains why an
   action was allowed or queued.
5. Eval before promote: permuted-choice probes, our own injection red-team
   set, and a frozen test split drawn from ledger/approval outcomes; kev's
   CI-locked eval suites are the methodological model.

## Sources

Primary: [TypeSafe docs](https://docs.typesafe.ai/introduction),
[API](https://docs.typesafe.ai/api), [models and pricing](https://docs.typesafe.ai/models),
[jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[intent-routing pattern](https://docs.typesafe.ai/patterns/intent-routing),
[Laya](https://github.com/NandhaKishorM/laya),
[kev](https://github.com/jaredpalmer/kev),
[Open-Jev](https://huggingface.co/ZefanCai/Open-Jev-9B) and its
[dataset](https://huggingface.co/datasets/ZefanCai/Open-Jev),
[openjev-heldout](https://huggingface.co/datasets/s1lv3rj1nx/openjev-heldout),
[healthcare-router](https://huggingface.co/datasets/s1lv3rj1nx/openjev-healthcare-router),
[awesome-jev](https://github.com/yibie/awesome-jev).

Critique and analysis: [Jev can't be calibrated (Molas)](https://www.alexmolas.com/2026/09/23/jev-cant-be-calibrated.html),
[Will OpenAI eat Jev's lunch (Arcturus Labs)](https://arcturus-labs.com/blog/2026/09/21/will-openai-eat-jevs-lunch/),
[Jev's Architecture Unmasked (Hume)](https://archerhume.com/posts/jevs-architecture-unmasked),
[Latent Space clone roundup](https://www.latent.space/p/ainews-here-are-6-clones-of-jev-in),
[HN on CUA-S1](https://news.ycombinator.com/item?id=49767564),
[HN on the calibration debate](https://news.ycombinator.com/item?id=49816899),
[independent metadata probe (Zenodo)](https://doi.org/10.5281/zenodo.22901853).
