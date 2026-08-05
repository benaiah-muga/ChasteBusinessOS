# AI Autonomy and Safety

## Levels

| Level | Side effects | Typical use |
|---|---|---|
| `recommend` | None without explicit user action in UI | Advisory orgs |
| `confirm` | Only after user confirms prepared command | **Default** |
| `guarded_auto` | Auto within allowlist + limits | Trusted ops |
| `full_autonomous` | Broad auto-run | Explicit opt-in only |

## Full autonomous warning

While we invest in reliability and auditability, **AI can still make mistakes**.
In full autonomous mode, the organization is responsible for outcomes. The product
must show a clear warning at enablement time and keep a complete audit trail.

## Invariants

- Autonomy never elevates permissions above the acting principal.
- Dangerous commands can force a higher gate than the org default.
- Every AI run stores an explanation: intent, tools considered, policy applied, result.
- Analytics answers must be tied to verifiable queries -- no fabricated figures.

## Specialist agents

Specialists (CRM, Accounting, …) only narrow tools and prompts. Safety still
applies at the orchestrator and command bus.

## Harness boundaries

The AI layer is a **harness** for operating and (optionally) extending the
product. See [VISION.md](../VISION.md) and [ADR 0007](./adr/0007-harness-memory-and-self-dev.md).

Additional rules:

- **Security-sensitive** actions (role elevation, secret access, break-glass)
  force a human confirm floor; never full autonomous by default.
- **Missing capability** must become a Capability Gap Ticket (or honest refusal),
  not a fabricated tool call.
- **Self-development** (coding-agent handoff) may only write allowed surfaces,
  must pass lint/typecheck/test gates, and still installs modules through the
  same permissioned install path as humans.
- **Memory** may inform the model; it must not replace SoR reads/writes for
  balances, stock, or legal records.
