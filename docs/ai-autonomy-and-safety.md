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
- Analytics answers must be tied to verifiable queries — no fabricated figures.

## Specialist agents

Specialists (CRM, Accounting, …) only narrow tools and prompts. Safety still
applies at the orchestrator and command bus.
