# ADR 0007, One execution path: the capability kernel

Date: 2026-08-21 · Status: accepted

## Context
"Every human action can also be done by the agent" is only safe if both
share identical plumbing. Parallel paths (UI writes + agent tools) drift
and bypass governance.

## Decision
Every state change, human click or LLM tool call, funnels through
`KernelExecutor.execute`: validate → authorize → policy gate → execute →
audit. UI "actions" are API routes that call the executor with a human
actor context. There is no second way to write domain state.

## Consequences
- Security review surface is one file.
- Agent parity is automatic: if a human can do it, a permitted agent can.
- All UI mutations cost one extra indirection (accepted).
