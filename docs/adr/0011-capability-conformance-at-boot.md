# ADR 0011, Capability conformance validated at boot

Date: 2026-08-22 · Status: accepted

## Context
DeepSeek Harness's plugin audit found broken installs and silent
non-activations in an AI-authored ecosystem. As modules multiply (and get
authored by agents in Creator Mode), registry gaps must surface at boot,
not at first user action.

## Decision
`assertWellFormedCapability` runs on every registration (errors throw);
`registry.validateAll()` runs when the app builds its registry, inverse
targets missing ⇒ fatal boot failure; missing inverses/short intents ⇒
logged warnings (tracked debt). Same checks run in CI via kernel tests.

## Consequences
- Ecosystem health is observable from server start logs.
- Warning budget is visible; warnings are expected to trend to zero per module.
