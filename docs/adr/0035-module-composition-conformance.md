# ADR 0035, Module composition conformance

Date: 2026-08-31 · Status: accepted

## Context

The product principle: each module is useful alone; modules become
exponentially more useful combined; the AI is the connective tissue. The
kernel already gated capability execution per org (`ModuleGate`), but two
gaps remained: nothing *tested* that subsets actually work, and enabled
capabilities had no way to degrade a cross-module effect when the sibling
module is disabled.

## Decision

Four enforceable rules:

1. **No hard sibling imports.** Modules communicate through capabilities or
   sanctioned seams only (the shared stock writer, the posting service,
   signal producers via injection). eslint `no-restricted-imports` enforces
   the boundary per module group; exceptions are explicit and ADR-recorded
   (ADR 0020 for HR/POS/purchasing, ADR 0033 adds inventory for valuation
   postings).
2. **Graceful degradation.** The executor surfaces the module gate to
   capabilities via `ctx.services.moduleGate`. An enabled capability asks
   whether its sibling is enabled and skips that effect only — POS sale
   with Inventory off posts the money and writes no stock legs. Unknown or
   missing gate behaves as enabled, so standalone module usage is unchanged.
3. **Subset matrix in CI.** The web server suite boots the full registry
   under representative module subsets and proves: disabled modules are
   refused wholesale (before validation), enabled modules keep working, and
   degraded flows leave the audit chain intact.
4. **AI as tissue, not bypass.** Cross-module composition (reorder plans,
   briefs, reviews) reads signals and datasets and proposes governed
   capabilities; it never writes across modules outside the registry.

Policy specificity (same milestone): when several org policy rules match a
capability, the most specific pattern wins; ties resolve to the stricter
autonomy cap. The onboarding blanket `* → write` becomes a fallback that
specific rules can tighten — ambiguity can never loosen a gate.

## Consequences

- Orgs can enable any module subset and remain correct by construction, not
  by hope.
- Capability authors own their degradation branches; the kernel owns the
  plumbing.
- The door stays open for capability-level dependency declarations later;
  nothing here forecloses it.
