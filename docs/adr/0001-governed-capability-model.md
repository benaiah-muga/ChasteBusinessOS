# ADR 0001 — Governed capability model

Date: 2026-08-21 · Status: accepted

## Context
An agentic ERP where humans and AI share every action needs an atomic,
self-describing unit of work that both can invoke identically.

## Decision
Every action is a **Capability**: typed zod input/output, natural-language
`intent` (embedded for agent retrieval), risk class (`read|write|money|
identity|destructive|secret`), permission reference, optional approval
policy, and a declared inverse for state changes. Capabilities register in
a kernel registry; nothing executes outside it.

## Consequences
- The agent's tool list *is* the product surface — no drift.
- New modules must speak this contract; conformance is validated at boot.
- Intent strings double as living documentation.
