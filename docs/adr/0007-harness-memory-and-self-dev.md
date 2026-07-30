# ADR 0007: Agent harness memory graph and self-development pipeline

## Status

Accepted — 2026-07-30 (spec / product decision; implementation phased)

## Context

ChasteBusinessOS positions AI as a **harness** for operating a business with the same
command bus, permissions, and audit as humans (see [ADR 0006](./0006-custom-ai-orchestration.md),
[VISION.md](../../VISION.md)).

Product pressure requires three capabilities that the early memory and gap-ticket
sketches do not fully cover:

1. **Human-like memory** without forcing the model to call memory tools every turn
   (token cost, missed recalls). Inspiration: jcode-style harnesses that embed
   turns, retrieve by cosine similarity against a memory graph, optionally verify
   with a memory side-agent, extract memories on triggers, and consolidate ambiently.
2. **Honest capability gaps** that become **Capability Gap Tickets**, then optional
   implementation by coding harnesses (OpenCode, Codex, Claude Code, …) or cloud
   build, shipping to marketplace/registry rather than bloating the shared core
   with every tenant feature.
3. **Self-development infrastructure** so local installs can detect coding agents
   and safely edit/build/test extension surfaces; cloud can recommend shared vs
   private placement.

Constraints that must not break:

- AI/manual parity and no elevated AI privileges
- Permanent business facts only via commands / SoR
- No arbitrary per-tenant code dumped into production without gates
- Custom orchestration remains owned in `@chaste/ai-core` (not a general agent framework core)

## Decision

### Memory

Implement a **layered memory system** in `@chaste/ai-core` + `packages/db`:

| Layer | Behavior |
|---|---|
| Turn embeddings | Every chat turn (and selected system events) is embedded |
| Memory graph | Nodes (facts, decisions, lessons, customization how-tos) + optional edges; vectors in pgvector |
| Passive recall | Each turn: cosine top-k → optional memory side-agent filter → inject into prompt under token budget |
| Active tools | `memory.search`, `memory.store`, `session.search` for explicit agent use |
| Extraction | Side-agent on triggers (K turns, drift, session end, plan complete, gap closed) |
| Ambient consolidation | Worker job: merge, stale, conflict flags |
| SoR boundary | Business truth still written only through commands |

Session history remains the short-term transcript; semantic graph is long-term and cross-session.

### Capability gaps

Expand the catalog + ticket model already sketched in product architecture:

- Runtime ground truth = installed commands/queries + config keys
- Gap → org-visible ticket with **generalized** capability id
- Eval: refuse + ticket instead of hallucinated command

### Self-development

Provide a **Customization Agent** path (profile in ai-core, not free-form root access):

1. User confirms ticket / spec.
2. **Local:** detect coding agents on host; hand off repo-aware task with AGENTS.md, skills, module-author conventions; run in sandbox/worktree; build + test; produce module/extension package.
3. **Cloud:** recommend marketplace shared module vs private org extension vs roadmap wait; frontier models advised for greenfield feature code.
4. Enable only after tests pass and install permissions allow.
5. Write **customization lesson** memories for future reuse.

**Do not** merge every customization into mainline platform by default. Prefer installable modules and marketplace listings.

### Scheduling & communications

Treat calendar, reminders, NL follow-up, notifications (including client sound/ring), and email as **platform services** on the same command/outbox path -- not ad-hoc agent side channels.

## Consequences

### Positive

- Agents recall relevant org knowledge without constant tool calls
- Customization scales without core bloat
- Local self-hosters get a real path to private features
- Cloud economics stay coherent (shared vs private)
- Still one mutation surface and one security model

### Negative / trade-offs

- Embedding + consolidation cost (CPU, storage, embedding provider)
- Self-dev is high risk; needs strong sandbox, review, and policy
- Memory side-agent adds latency unless made async/optional
- Coding-agent detection is environment-specific

### Non-goals

- Letting the model rewrite kernel authz or skip RBAC
- Auto-pushing untested code to production
- Requiring Mastra or another full agent framework for memory
- Storing secrets or PII-rich raw dumps in embeddings without policy

## Alternatives considered

1. **Tool-only memory** -- reject; high token use, easy to forget.
2. **All customizations into monorepo main** -- reject; bloat and irrelevant surface for most tenants.
3. **Framework memory (e.g. Mastra)** -- rejected for core orchestration in ADR 0006; we own the product path.
4. **No self-dev; tickets only for human devs** -- acceptable MVP subset, but vision requires local coding-agent path.

## References

- [docs/specs/agent-harness.md](../specs/agent-harness.md)
- [docs/specs/memory-system.md](../specs/memory-system.md)
- [docs/specs/self-development.md](../specs/self-development.md)
- [docs/specs/scheduling-and-comms.md](../specs/scheduling-and-comms.md)
- [docs/product-architecture-next.md](../product-architecture-next.md)
