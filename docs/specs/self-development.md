# Spec: Self-development & Capability Gap pipeline

**Status:** Draft product/engineering spec  
**Related:** [ADR 0007](../adr/0007-harness-memory-and-self-dev.md), [agent-harness.md](./agent-harness.md), [module-development.md](../module-development.md), [VISION.md](../../VISION.md)

## 1. Problem

Agencies and custom ERP shops bill for configuration and code that SMBs can increasingly express in plain language. ChasteBusinessOS must:

1. Cover **common comprehensive ERP features** out of the box (modules + config).
2. When something is missing, **not pretend** it exists.
3. Turn confirmed needs into **general capabilities** implemented as modules/extensions.
4. Avoid dumping every tenant feature into the shared monorepo (bloat for everyone else).
5. On **local installs**, optionally use detected **coding agents** to implement private or contribution-bound features.
6. On **cloud**, recommend shared marketplace vs private extension vs platform roadmap.

Self-development is inspired by jcode-class systems: significant infrastructure to edit, build, and test source -- applied here to **module/extension surfaces** under Chaste conventions, not unrestricted production mutation.

## 2. Principles

| Principle | Meaning |
|---|---|
| Config before code | Custom fields, workflows, report specs, autonomy policy first |
| Generalize | Tickets propose stable capability ids, not "Acme-only column" |
| Modules not monolith | New behavior ships as installable packages |
| Same bus after ship | Generated features still expose commands/queries |
| Human authority | User confirms specs; security-sensitive areas stay gated |
| Frontier models for greenfield | Advise strong models for new feature customizations |
| Remember how | Store customization lessons in semantic memory |

**Advised models for new feature customizations (non-exhaustive, evolves):** GPT-class frontier, Claude Opus-class, Kimi/Qwen frontier tiers as available. Cheap local models remain for support/classify, not primary codegen.

## 3. End-to-end pipeline

```
User NL: "We need customer-specific multi-currency price lists"
        │
        ▼
Operations agent tries capability catalog
        │
        ├─ available → implement via commands/config
        └─ absent/partial
                │
                ▼
        Customization agent drafts:
          - capability id
          - acceptance criteria
          - module boundary
          - non-goals
                │
                ▼
        User confirms / edits spec  (UiParts: form + plan)
                │
                ▼
        CapabilityGapTicket (status: confirmed)
                │
                ▼
        Placement recommender
          local_extension | marketplace_shared | platform_roadmap | private_cloud
                │
                ▼
        Coding handoff
          - Local: detect agent → worktree task
          - Cloud: secure build workers / maintainer queue
                │
                ▼
        Implement following AGENTS.md, skills/module-author, command-safety
                │
                ▼
        build → typecheck → test → package
                │
                ▼
        Install / marketplace publish (permissions)
                │
                ▼
        Ticket → resolved; memory kind=customization written
        Operations agent can now use new commands
```

## 4. Capability Gap Ticket

```ts
type CapabilityGapTicket = {
  id: string;
  organizationId: string;
  status:
    | "draft"
    | "confirmed"
    | "queued"
    | "in_progress"
    | "in_review"
    | "resolved"
    | "wont_fix"
    | "duplicate";
  proposedCapabilityId: string;
  title: string;
  abstractRequirement: string;
  acceptanceCriteria: string[];
  exampleScenarios: string[];
  suggestedModuleId: string;
  nonGoals: string[];
  deploymentTarget:
    | "undecided"
    | "local_extension"
    | "marketplace_shared"
    | "private_cloud"
    | "platform_roadmap";
  codingAgent?: string;          // "opencode" | "codex" | "claude-code" | …
  artifactRef?: string;          // package path, PR, marketplace listing id
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
```

Commands (illustrative):

- `core.capability.gap.create`
- `core.capability.gap.update`
- `core.capability.gap.list`
- `core.capability.gap.confirm`
- `core.customization.handoff`
- `core.customization.cancel`

Permissions: `core.capability.gap.*` distinct from install/publish.

## 5. Placement recommender

| Signal | Prefer |
|---|---|
| Common SMB need, no sensitive IP | `marketplace_shared` or `platform_roadmap` |
| Org-specific process, local self-host | `local_extension` |
| Org-specific on cloud tenant | `private_cloud` (isolated package, not core) |
| Touches kernel authz/payments core | `platform_roadmap` + human maintainers |
| Already exists partially as config | Stay config; close as duplicate/wont_fix with explanation |

Cloud agent **recommends**; user/org policy chooses. Never silently publish shared marketplace from a single tenant without review policy.

## 6. Local coding-agent detection

On self-hosted instances with `CHASTE_SELF_DEV_ENABLED=true`:

1. Probe for known agents on `PATH` / config (OpenCode, Codex CLI, Claude Code, etc.).
2. Present available agents to customization agent / settings UI.
3. Handoff payload includes:
   - Confirmed ticket JSON
   - Repo root / extension workspace path
   - Pointers to `AGENTS.md`, `skills/module-author`, `skills/command-safety`
   - Allowed write roots (e.g. `modules/`, `extensions/`, never `.env` secrets)
   - Required checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (scoped when possible)
4. Run in **worktree or sandbox**; record logs and diff summary on the ticket.
5. Human or policy gate before `module.install` / enable.

If no coding agent is present: ticket remains for human developers; UI explains how to install a supported agent.

## 7. Secure surfaces (what may be edited)

| Allowed | Forbidden by default |
|---|---|
| New module under `modules/<id>` or `extensions/<org>/<id>` | Kernel authz core without maintainer review |
| Module commands/queries/schemas | Writing production secrets |
| Marketplace listing metadata | Disabling audit |
| Report specs, UI manifests | Broad `rm -rf`, force-push to protected branches |
| Tests and fixtures (no real secrets) | Cross-tenant data access |

Cloud workers use stronger isolation (ephemeral VMs/containers, no customer SoR write from codegen).

## 8. Marketplace / registry loop

1. Package meets module manifest contract.
2. `core.marketplace.publish` (or contribution PR to public registry).
3. Other orgs install via marketplace -- **optional**, not forced.
4. Versioning + permissions + region filters as existing marketplace design.

Local-only extensions can stay private (never published).

## 9. Customization agent behavior

- Speaks product language, not framework jargon, to the user.
- Produces acceptance criteria the user can edit.
- Refuses security-sensitive scope or escalates to human maintainers.
- After ship: demonstrates the new capability via ops tools; writes memory lesson.
- Does not claim "done" without green checks + install success.

## 10. Relation to "everything in main"

**Rejected as default:** merging every customization into mainline.

**Accepted:**

- Shared, high-value capabilities graduate to official modules / platform roadmap.
- Long tail stays extensions or marketplace packages.
- Mapping templates and config remain data, not code.

## 11. Phasing

| Phase | Deliverable |
|---|---|
| S0 | Capability catalog + gap tickets (no codegen) |
| S1 | Placement recommendation + user confirm UX |
| S2 | Local agent detection + handoff file/prompt pack |
| S3 | Worktree runner + test gate + install hook |
| S4 | Marketplace publish from resolved ticket |
| S5 | Cloud private extension builders |
| S6 | Auto memory lesson + eval harness for gap honesty |

## 12. Success metrics

- % of missing-feature evals that ticket instead of hallucinate
- Time from confirmed ticket → installable module (local pilot)
- % of customizations that remain outside core
- Zero privilege-escalation incidents via self-dev path
- Reuse rate of customization memories on similar tickets

## 13. Non-goals

- Fully unsupervised production deploys on day one
- Replacing professional services for regulated certifications
- Allowing the model to bypass RBAC "to finish the feature faster"
