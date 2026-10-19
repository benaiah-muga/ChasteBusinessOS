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
- Keep a scripted provider for deterministic tests and CI. Live runs are
  opt-in with `EVALUATION_LIVE=1` locally and never run in the normal suite.
- First scenarios: low-stock proposal, incoming supply that covers the gap,
  and missing sales history. The first two are already proven live.
- Expose the harness in the ERP interface as a Quality tab inside Settings.
  Runs require `iam.admin`, are same-origin, are limited to one at a time, and
  return the tool trace, checks, final answer, duration, and token usage.
- Do not persist evaluation runs yet. The first surface is a deliberate
  in-memory, admin-run check; history and scheduled evaluations come later.

## Consequences

The first quality gate now tests tool choice and honesty without risking
business state or spending authority. It measures model behavior, not the
deterministic business outcome proofs, which remain separate. Scenarios are
fixtures, so they can drift from production payloads; keeping a typed fixture
per scenario and adding live workflow proofs covers that gap. Evaluation
history, regression baselines, and scheduled runs remain open work.
