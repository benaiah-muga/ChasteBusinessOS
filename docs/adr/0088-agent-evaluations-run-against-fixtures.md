# ADR 0088: Agent evaluations run live models against fixture tool results

Status: accepted

## Context

The first workflow needs a repeatable way to judge agent behavior, not only
whether a capability succeeds. A model can choose the wrong tool, skip the
live plan, order when incoming stock already covers the gap, or claim an order
was placed when the result was a pending approval. Tests that call the
capability directly cannot catch those failures.

Running a live model against a real workspace would create approvals, orders,
and audit records during evaluation. It would also make evaluation results
depend on mutable business data.

## Decision

- Define evaluation scenarios with a prompt, a set of fixture tool results,
  expected and forbidden tool calls, and final-answer checks.
- Run the live model through the same chat provider and the same agent tool
  catalog that Workmate uses. Intercept every tool call and answer it from the
  scenario fixture. No capability executor, database transaction, approval, or
  business record is involved.
- Use DeepSeek `deepseek-flash` as the first live evaluator, configured from
  `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL`. The provider
  does not fall back to NVIDIA, so a result always names the model that ran.
- Keep a scripted provider for deterministic tests and CI. A scripted baseline
  covers every scenario and fails the normal Go suite if a fixture or check
  drifts. Live runs are opt-in with `EVALUATION_LIVE=1` locally.
- Scenarios: low-stock proposal, incoming supply that covers the gap,
  missing sales history, partial receipt follow-through, quote award, 90-plus
  receivables, and supplier lead-time risk. Five are proven live; the
  scripted baseline covers all seven.
- Expose the harness in the ERP interface as a Quality tab inside Settings.
  Runs require `iam.admin`, are same-origin, are limited to one at a time, and
  return the tool trace, checks, final answer, duration, and token usage.
- Persist output-only run evidence in `evaluation_runs`, scoped by
  organization with row level security: status, model, usage, tool trace,
  checks, final answer, actor, and timestamp. The Quality tab reads the last
  30 runs, compares the latest five with the previous five, flags a configurable
  pass-rate baseline, shows release metrics and model comparison, and opens a
  stored run's full trace. Retention keeps 50 runs per workspace; a nightly
  GitHub workflow runs the scripted baseline and the live evaluation when the
  DeepSeek secret is configured.
- Keep evaluation payloads separate from business state. A run can record a
  model's proposed purchase order, but it never creates an approval, order, or
  receipt.

## Consequences

The first quality gate now tests tool choice and honesty without risking
business state or spending authority. It measures model behavior, not the
deterministic business outcome proofs, which remain separate. Scenarios are
fixtures, so they can drift from production payloads; keeping a typed fixture
per scenario and adding live workflow proofs covers that gap. Run history is
now durable and visible in Settings, with a configurable baseline, release
metrics, model comparison, a nightly scheduled workflow, and bounded retention.
In-app scheduling, regression alerts, and comparisons across model versions
remain open work.
