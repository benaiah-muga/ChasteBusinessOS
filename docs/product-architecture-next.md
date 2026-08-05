# Product Architecture: Module Worlds, Harness, Gaps, Memory & Intelligence

**Status:** Draft roadmap (post–Mastra scrap, custom AI core)  
**Audience:** Product, architecture, module authors  
**Related:** [VISION.md](../VISION.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [ADR 0006](./adr/0006-custom-ai-orchestration.md), [ADR 0007](./adr/0007-harness-memory-and-self-dev.md)

**Detailed specs:**

| Spec | Path |
|------|------|
| Agent harness | [specs/agent-harness.md](./specs/agent-harness.md) |
| Semantic memory (jcode-inspired) | [specs/memory-system.md](./specs/memory-system.md) |
| Self-development / gap → code | [specs/self-development.md](./specs/self-development.md) |
| Schedule, notify, email | [specs/scheduling-and-comms.md](./specs/scheduling-and-comms.md) |
| Platform module (branches, RBAC, …) | [specs/modules/platform.md](./specs/modules/platform.md) |

This document turns the next product vision into **platform capabilities** that stay general (not client hardcodes), AI-native, and aligned with ERP best practice.

---

## 1. North star (refined)

ChasteBusinessOS should feel like:

1. **A harness for operating a business** — the model uses the same tools a human would (commands/queries), except it cannot bypass security-sensitive RBAC and privileges.  
2. **An app store of business domains** — install CRM, Accounting, Inventory, … comprehensive common ERP features first.  
3. **A dedicated “world” per module** — own navigation, depth via tabs/sections, shared global chrome only where it helps.  
4. **AI as co-operator and customizer** — day-to-day ops with what exists; when something is missing, **Capability Gap Tickets** and an optional **self-dev / coding-agent** pipeline to marketplace or private extension.  
5. **Proactive general agent + domain specialists** — not only reactive; engages for clarifications, updates, follow-ups; specialists share general rules with domain knowledge (users need not know which ran).  
6. **Human-like memory** — jcode-inspired embeddings, passive cosine recall, memory side-agent, extraction, ambient consolidation, explicit tools, session RAG.  
7. **Time and attention** — scheduling, calendar, NL follow-up, notification sound/ring, email — on the same bus/outbox.  
8. **Multi-branch org model** — list all branches, switch active branch, scope data and AI context.  
9. **Onboarding by data** — AI-assisted ingestion from messy Excel, files, DBs, or live external sources.  
10. **Reports as composition** — NL → validated report graphs from a **component catalog**.  
11. **Robust identity/RBAC** — invites, sessions, branch-scoped access; AI never elevates itself.  
12. **Local + cloud paths** — local installs detect coding agents for private customizations; cloud recommends shared marketplace vs private extension vs roadmap. Frontier models advised for greenfield feature code.

We deliberately learn from decades of ERP UX (Odoo apps, NetSuite subsidiaries, SAP company codes, Dynamics business units) and from agent harnesses that iterate on themselves (jcode-class memory and self-dev), while staying **API-first, command-bus pure, and AI-native**.

### 1.1 Why a harness (not a chatbot)

```
Business goal (NL)
      │
      ▼
┌─────────────────────────────────────────┐
│  Harness: memory · specialists · policy │
│  tools = installed commands/queries     │
└──────────────────┬──────────────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
   Do with existing     Capability gap
   modules/config       ticket → customize
         │                   │
         ▼                   ▼
   Command bus          Coding agent / registry
   + audit              (local or cloud)
```

**Remove agency dependency for ordinary customization:** the business speaks plain language; the platform executes what is available and builds what is missing through a controlled pipeline -- not silent hallucination and not core bloat.

---

## 2. What exists today (honest baseline)

| Area | Today | Gap |
|------|--------|-----|
| Modules | Installable packages + marketplace; flat web nav | No “module world” shell; nav is global list |
| Module UI | Workspaces (e.g. CRM) with **tabs** already | Not nested under module-owned sidebar; shallow depth |
| AI harness | Custom orchestrator → command bus; plans, confirms, suggestions | No full proactive loop; weak specialist handoffs; no resource deep-links |
| Memory | Session transcript + simple memory port | No turn embeddings, passive cosine graph, side-agent, consolidation |
| Capability gaps | Documented intent only | No catalog runtime, gap tickets, customization agent |
| Self-dev | Skills for human module authors | No coding-agent detect/handoff, sandbox build, marketplace from ticket |
| Tenancy | `organizationId` on data | No first-class **branch / location / company unit** + switcher |
| Users | Users, roles, permissions, RBAC overview UI | No invites, SSO, sessions, branch-scoped access, SCIM |
| Schedule/comms | Notification prefs stubs in settings | No calendar, reminders, NL follow-up, ring, email adapter |
| Data import | None as platform | No ingestion pipeline |
| Reporting | Ad-hoc charts in workspaces | No report builder / NL composition layer |
| Local AI | `Modelfile` → Qwen 3.5 0.8B; Ollama-compatible provider | Not productized as “local support” tier vs frontier customize tier |

**Invariant preserved:** web talks HTTP only; AI never bypasses commands; Zod at boundaries; no elevated AI privileges.

---

## 3. Module App Interface (“enter the world”)

### 3.1 UX model

```
┌─────────────────────────────────────────────────────────────┐
│ Global top bar: org · branch switcher · user · AI · search  │
├──────────────┬──────────────────────────────────────────────┤
│ App launcher │  When NOT in a module: home / launcher grid  │
│ (installed)  │                                              │
│              │  When IN a module (e.g. CRM):                │
│  [CRM] ◀───  │  ┌────────────┬───────────────────────────┐  │
│  Accounting  │  │ Module     │ Page content              │  │
│  Inventory   │  │ sidebar    │ (list · form · kanban)    │  │
│  …           │  │ - Overview │ + secondary Tabs for depth│  │
│              │  │ - Customers│   e.g. Details | Activity │  │
│              │  │ - Pipeline │         | Documents       │  │
│              │  │ - Settings │                           │  │
│              │  └────────────┴───────────────────────────┘  │
└──────────────┴──────────────────────────────────────────────┘
```

Inspiration: Odoo app switcher + modern product shells (Linear/Notion depth via tabs), not a single mega-sidebar of every screen in the ERP.

### 3.2 Platform contracts (not hardcode pages)

**Backend** — each module may publish a **UI manifest** (JSON via query, e.g. `core.module.ui_manifest`):

```ts
type ModuleUiManifest = {
  moduleId: string;
  label: string;
  icon?: string;
  homeHref: string;           // e.g. /apps/crm
  nav: Array<{
    id: string;
    label: string;
    href: string;             // /apps/crm/customers
    permission?: string;
    children?: …;             // optional nested
  }>;
  /** Optional default tabs for entity detail layouts */
  entityLayouts?: Record<string, { tabs: Array<{ id: string; label: string }> }>;
};
```

**Frontend**

- Route prefix: `/apps/[moduleId]/...` (module shell).
- `ModuleShell` reads manifest for that module → **module sidebar**.
- Global launcher (grid of installed modules) + thin global bar.
- Existing workspaces migrate under this shell; tabs remain the **depth** pattern (already used in CRM).

**Discovery:** installed modules from `core.modules.list` + optional `ui_manifest` query. Web never imports module packages.

### 3.3 Phased delivery

| Phase | Deliverable |
|-------|-------------|
| M1 | `/apps/[moduleId]` shell + launcher; migrate CRM as pilot |
| M2 | Manifest-driven nav from API; permission-filter sidebar items |
| M3 | Entity detail layouts (tabs from manifest); deep-link targets for AI |
| M4 | Module settings, favorites, recent records in module chrome |

---

## 4. AI → “Open what I just did” (resource links)

### 4.1 Problem

After `crm.customer.create`, the user only gets text/suggestions. They should get a **button to open the customer**.

### 4.2 Solution: `resource_link` UI part

Extend `@chaste/ui-schema`:

```ts
resource_link: {
  type: "resource_link";
  label: string;              // "View Acme Ltd"
  moduleId: string;           // "crm"
  resourceType: string;       // "customer"
  resourceId: string;
  href: string;               // canonical path /apps/crm/customers/:id
  secondary?: boolean;
}
```

**How links are produced (no free-form URLs from the model):**

1. Commands declare **resource metadata** on success:

```ts
// handler return + optional helpers.meta
{
  result: customer,
  resources: [{
    type: "customer",
    id: customer.id,
    label: customer.name,
    moduleId: "crm",
    pathTemplate: "/apps/crm/customers/{id}",
  }],
}
```

2. Orchestrator maps `resources[]` → validated `resource_link` parts (template fill only).  
3. ChatWidget renders primary buttons; click uses Next.js router (same origin).

**Also attach** to multi-step plan completion: one link per created resource, grouped.

### 4.3 Why this stays safe

- Model never invents paths; only fills IDs into **server-known templates**.  
- Permission check: hide link if user cannot `*.read` that resource.  
- Audit already has `resourceType` / `resourceId` — align naming.

---

## 5. Capability gaps → tickets → self-dev / marketplace (not client forks)

Full pipeline: [specs/self-development.md](./specs/self-development.md) · harness: [specs/agent-harness.md](./specs/agent-harness.md)

### 5.1 Principle

When operations/customization AI cannot fulfill a request:

> **Never** hallucinate a command or silently invent side effects.  
> **Never** dump one-off client code into the shared core by default.  
> **Always** map to the **capability catalog**; if absent, emit a **Capability Gap Ticket**, then optionally a **controlled coding harness** path (local agent or cloud build) that ships an **installable module/extension** to marketplace/registry or private extension space.

Two cooperating modes:

| Mode | Job |
|------|-----|
| **Operations agent** | Run the business with installed tools, memory, schedule, notify |
| **Customization agent** | Confirm specs, open tickets, hand off to coding agents, remember how |

### 5.2 Capability catalog

Machine-readable registry (versioned in repo + runtime query):

```ts
type Capability = {
  id: string;                    // "crm.pipeline.stages.custom"
  moduleId: string;
  title: string;
  description: string;
  status: "available" | "partial" | "planned" | "absent";
  commands?: string[];           // if available
  configKeys?: string[];         // org-level config that unlocks behavior
  smbStandard?: boolean;         // industry-common for SMBs
};
```

Sources of truth:

1. Module manifests (`capabilities: [...]`) — expanded over time.  
2. `docs/specs/modules/<module>.md` — human specs (see §8).  
3. Runtime: installed commands/queries = ground truth for “available”.

### 5.3 Gap detection flow

```
User / ops AI request
    → map intent to capability id(s)  (rules + LLM classify against catalog)
    → if available: execute via commands / config / workflows
    → if partial: do what is possible + explain remainder
    → if absent/planned:
         1. Tell user honestly (“not available yet”)
         2. Draft CapabilityGapTicket (generalized -- not client codename)
         3. User confirms acceptance criteria
         4. Placement: local_extension | marketplace_shared | private_cloud | platform_roadmap
         5. Optional: coding handoff (see §5.6)
```

Ticket fields force **generalization**: stable capability id, abstract SMB requirement, anonymized scenarios, module boundary, non-goals (config vs code).

### 5.4 Developer / marketplace loop

| Artifact | Owner |
|----------|--------|
| `capability_gap_tickets` table | Platform |
| Query/export | `core.capability.gap.list` |
| Module author skill | Catalog gaps → modules with **commands + config** |
| Marketplace / registry | Installable packages; not forced into core |
| Customization memories | Semantic memory `kind: customization` after resolve |
| Eval harness | Refuse + ticket instead of hallucinated command |

**Anti-pattern:** “Add field X only for Client Y in their DB.”  
**Pattern:** “Custom fields framework” or “CRM stage config” as **general** capability -- or a **private extension package** if truly org-specific.

### 5.5 Configuration vs code

| Need | Prefer |
|------|--------|
| Extra attributes on customer | Custom fields / metadata schema (general) |
| Approval thresholds | Org policy + autonomy / workflow config |
| Industry document layout | Report template + print format (general) |
| Entirely new domain process | New module or module extension package |
| One-off org workflow IP | Private extension (local or cloud), not core merge |

### 5.6 Self-development (local + cloud)

**Why not every feature in main?** Core would bloat for tenants who never need those features. Ship **comprehensive common ERP** modules; long-tail and private needs stay extensions/marketplace.

| Deployment | Behavior |
|------------|----------|
| **Local self-host** | `CHASTE_SELF_DEV_ENABLED`: detect coding agents (OpenCode, Codex, Claude Code, …). Customization agent hands off worktree-scoped task with AGENTS.md + skills; build/test; install extension. Advise **frontier models** for new feature codegen. |
| **Cloud hosted** | Recommender chooses shared marketplace vs private org extension vs platform roadmap; secure builders; review policy before shared publish. |

**Secure surfaces only:** `modules/*`, `extensions/*`, tests, manifests -- not kernel authz bypass, not secrets, not untested production pushes.

Infrastructure goal (jcode-inspired): significant platform support to **edit, build, and test** extension source so the product can iterate on itself without agency babysitting every field change.

---

## 5A. Semantic memory system (jcode-inspired)

Full spec: [specs/memory-system.md](./specs/memory-system.md) · ADR: [0007](./adr/0007-harness-memory-and-self-dev.md)

### 5A.1 Design

| Mechanism | Role |
|-----------|------|
| Embed each turn | Vectors for session RAG + extraction seeds |
| Memory graph + cosine | Passive top-k related nodes every turn |
| Memory side-agent | Optional verify relevance; extra retrieval before inject |
| Extraction side-agent | On K turns, drift, session end, plan complete, gap closed |
| Explicit tools | `memory.search`, `memory.store`, `session.search` |
| Ambient consolidation | Worker: merge, stale, conflicts |
| Customization lessons | How hard features were implemented -- reuse later |

**Result:** human-like recall **without** forcing the main agent to call memory tools every turn (avoids token burn and missed recalls). Permanent balances/stock still live only in SoR via commands.

### 5A.2 Prompt injection shape (budgeted)

```
[Retrieved memories -- verified]
- (procedure) We post AR weekly on Fridays…
- (customization) multi_currency price lists live in inventory extension v0.3…
[Session recent turns]
[User message]
```

### 5A.3 Phasing (memory)

M0 session transcript (exists) → M1 turn embeddings + session.search → M2 passive graph inject → M3 explicit tools → M4 extraction → M5 consolidation → M6 customization lessons.

---

## 5B. Scheduling, calendar, reminders, notifications, email

Full spec: [specs/scheduling-and-comms.md](./specs/scheduling-and-comms.md)

| Capability | Notes |
|------------|--------|
| Calendar events | Org/user/branch-scoped; NL → structured times with confirm |
| Reminders | Fire via worker; in-app and/or email |
| NL follow-up | Durable job re-enters harness with goal text (proactive agent) |
| Notification bell | Inbox + optional **sound/ring** per client prefs / quiet hours |
| Email | Provider adapter; templates for invite, reminder, digest, gaps |

Efficiency: digests, dedupe windows, cheap parse for dates, outbox for all delivery. Settings already sketch `notificationDigest` / nested notification prefs -- extend rather than replace.

---

## 6. Intelligent data ingestion & mapping (greenfield clients)

### 6.1 Goal

After ERP install, onboard **complex legacy data** with high accuracy:

- Semi-structured Excel (titles, blank rows, multi-header).  
- CSVs, exports from other ERPs.  
- Snapshots from client DBs.  
- Optional **live** external DB / API connectors (read path first).

### 6.2 Architecture: Ingestion as a platform module

```
Sources                    Pipeline                         Target
────────                   ────────                         ──────
File upload  ─┐
Excel/CSV    ─┼─▶  ingest.job  ─▶ profile ─▶ map ─▶ validate ─▶ commit
External DB  ─┤         │            │        │        │         │
API export   ─┘         ▼            ▼        ▼        ▼         ▼
                   raw store    structure   mapping  dry-run   commands
                   (blob+meta)  model       draft    report    (SoR)
```

**Hard rule:** final write only through **existing module commands** (or bulk variants of those commands). No direct SQL into CRM tables from the importer.

### 6.3 Pipeline stages

| Stage | Deterministic | AI-assisted |
|-------|---------------|-------------|
| **Acquire** | Upload, connector pull, checksum | — |
| **Profile** | MIME, sheet list, row counts, dtype heuristics | “header band” detection (e.g. first N rows decorative) |
| **Structure** | Candidate header row, column types, PK guesses | Multi-row header merge; sparse title cells; multi-table sheets |
| **Map** | Exact name match to target fields | Semantic map to `crm.customer.*` etc. with confidence |
| **Clean** | Trim, date parse, currency, nulls | Entity resolution (“Acme” ≈ “Acme Ltd”) |
| **Validate** | Zod against command inputs; FK checks | Suggest fixes for invalid rows |
| **Commit** | Batch commands + outbox; idempotent job ids | — |
| **Reconcile** | Counts, sample diffs, rollback job | Explain mismatches |

### 6.4 Semi-structured Excel (your example)

Concrete algorithm (hybrid — **do not rely on LLM alone for structure**):

1. Read sheet as grid (values + optional styles).  
2. **Skip leading noise:** rows with low “data density” (mostly empty / single merged title) for first *K* rows (K configurable, default scan 20).  
3. Score each row as **header candidate** (non-empty string cells, uniqueness, similarity to known field synonyms).  
4. Optionally use a **small local model** (Qwen 0.8B) only to *confirm* “rows 1–4 are title; row 5 is header” with the scored candidates as context — never free-form structure invention without scores.  
5. For next *M* data rows, infer column types; if inconsistent, widen header search or split tables.  
6. Produce **StructureModel** JSON (human-editable in UI before map).

### 6.5 Connectors

| Kind | Approach | Security |
|------|----------|----------|
| Files | Presigned upload → object store / local volume | Virus scan, size limits, org isolation |
| External DB | Read-only credentials; connector runs in worker | Secrets in vault; allowlist schemas; no write-back by default |
| Live sync | CDC/cron jobs later | Same command commit path; watermarking |

**Product sequence:** Files → DB snapshot import → live read connectors → bidirectional only with explicit design.

### 6.6 Mapping memory (platform learning, not client hardcode)

- Successful maps stored as **anonymized mapping templates** (source column signatures → target fields).  
- Reuse across tenants when signature matches (opt-in).  
- Improves SMB onboarding without per-client code.

### 6.7 UX

Wizard: Source → Profile preview → Confirm structure → Map fields (AI draft) → Dry-run errors → Commit → Report + resource links to samples.

AI chat: “Import this customer list” → attaches job; same pipeline.

---

## 7. Custom reporting & visualizations (NL + components)

### 7.1 Principle

AI does **not** invent arbitrary React. It **composes** from a **Report Component Catalog** (same philosophy as ui-schema chat parts).

```ts
type ReportSpec = {
  id: string;
  title: string;
  audience: StakeholderRole[];   // owner, accountant, ops, board, …
  layout: "executive" | "ops_detail" | "audit" | …;
  sections: Array<
    | { type: "kpi_row"; items: KpiSpec[] }
    | { type: "chart"; chartType: "bar"|"line"|"donut"|"area"; query: QueryRef; … }
    | { type: "table"; query: QueryRef; columns: … }
    | { type: "text"; markdown: string }  // narrative, cited
    | { type: "filter_bar"; dimensions: … }
  >;
  dataFreshness?: string;
};
```

- **QueryRef** = registered query name + params (permission-checked).  
- Renderer in web uses existing Chart/Kpi primitives.  
- Save as org report definition; schedule later via worker.

### 7.2 Stakeholder-aware generation

System prompt / rules include:

- Who is asking (role from RBAC).  
- Who the report is *for* (user-stated or default by role).  
- Layout templates: board = few KPIs + trend; accountant = tables + reconciliation cues; ops = exceptions.

### 7.3 Recommended reports pack

Per module, ship **seed report specs** (SMB standards): AR aging, stockout risk, pipeline funnel, payroll summary — AI can “recommend” from pack + customize.

### 7.4 Integrity

No invented numbers: every metric traces to a query; explanation part lists query ids. Aligns with vision “no black-box analytics.”

---

## 8. Module capability specifications (SMB industry baseline)

### 8.1 Deliverable shape

For each module, maintain:

```
docs/specs/modules/
  crm.md
  accounting.md
  inventory.md
  purchasing.md
  hr.md
  manufacturing.md
  platform.md          # users, branches, rbac, ingestion, reports
```

Each spec includes:

1. **Actors** (roles).  
2. **Entities** + lifecycle.  
3. **Commands/queries** (target catalog — status: done / next / later).  
4. **UI nav + key screens** (feeds ModuleUiManifest).  
5. **SMB-standard features** checklist (benchmarked vs common practice: Odoo, QuickBooks+extensions, Zoho, ERPNext).  
6. **AI intents** (“create customer”, “age receivables”).  
7. **Reports pack**.  
8. **Ingestion targets** (which entities import first).  
9. **Non-goals**.

### 8.2 Initial SMB priority (recommended order)

| Priority | Module | Depth focus first |
|----------|--------|-------------------|
| P0 | Platform | Branches, users, RBAC, ingestion framework, report engine skeleton |
| P0 | CRM | Customers, contacts, pipeline/stages, activities |
| P0 | Accounting | CoA, journals, invoices, payments, basic tax |
| P1 | Inventory | Products, warehouses (branch-aware), stock moves, adjustments |
| P1 | Purchasing | Vendors, POs, receipts → stock |
| P1 | HR | Employees, departments, leave (payroll later) |
| P2 | Manufacturing | BOM, simple MO (only if SMB segment needs it) |
| P2 | Reporting hub | Cross-module dashboards |

**Rule:** ship **thin but real** end-to-end flows (quote→order→invoice→payment) before deep features in one silo.

---

## 9. Multi-branch support

Module detail: [specs/modules/platform.md](./specs/modules/platform.md)

### 9.1 Model (learn from ERP, stay simple for SMBs)

```
Organization (tenant)
  └── Branch[]          # legal/ops units: "Nairobi", "Mombasa"
        optional: parentBranchId for hierarchy later
  └── Warehouse / Location may bind to branch
  └── UserBranchAccess  # which branches a user may act in
  └── Document.branchId # invoices, stock moves, employees, …
```

**Session context:** `activeBranchId` (nullable = “all allowed” for HQ roles).

**UX requirements (explicit):**

- User can **see all branches** they are allowed to access (list + switcher).  
- User can **switch active branch** from global chrome and via natural language.  
- Lists, creates, and AI context default to active branch unless cross-branch is requested and permitted.

**Commands:** most handlers take branch from context (or explicit input with permission).  
**AI:** “Open a second branch in Nairobi” → plan: create branch, seed warehouse, clone price list policy, assign managers — multi-step workflow already envisioned in evals.

### 9.2 Phasing

1. Schema + platform commands (`core.branch.*`).  
2. Branch switcher + full accessible list in global chrome.  
3. Scope lists/queries by branch.  
4. Inventory warehouses linked to branch.  
5. Accounting dimensions / cost centers (deeper).

Avoid premature multi-company consolidation; design branch IDs so multi-company can layer later.

---

## 10. Robust user management

### 10.1 Target capabilities (platform)

| Capability | Notes |
|------------|--------|
| Invite / activate / deactivate | Email invite tokens; no forever shared tokens in prod |
| Password / SSO hooks | Local password hash first; OIDC later |
| Session management | Revoke, device list, idle timeout |
| Roles & permissions | Already started — expand catalog per module |
| Branch-scoped roles | Role assignment optional `branchIds[]` |
| Audit of admin actions | Already via command bus |
| Service accounts | For connectors / API (permission-limited) |
| Break-glass | Documented emergency admin with full audit |

### 10.2 AI constraints

AI user-admin actions: high autonomy threshold (`confirm` minimum); never auto-delete users in guarded modes without policy.

---

## 11. Local AI support — Qwen 3.5 0.8B

### 11.1 Role split (best tool for the job)

| Workload | Model tier | Examples |
|----------|------------|----------|
| **Local support** | Qwen 3.5 0.8B (Ollama) | Intent classify, clarify copy, header-row assist, UI string help, offline FAQ |
| **Planning / mapping** | Stronger cloud or larger local (7B–32B) | Multi-step plans, semantic column map, report composition |
| **Embeddings** | Small embed model | Memory, mapping template similarity |

Config already supports OpenAI-compatible + Ollama-style providers. Productize:

```
CHASTE_AI_SUPPORT_PROVIDER=ollama
CHASTE_AI_SUPPORT_MODEL=qwen3.5:0.8b   # from Modelfile
CHASTE_AI_PLAN_PROVIDER=…              # heavier
```

Orchestrator routes: **cheap local first** for classification; escalate when confidence low or task is multi-domain.

### 11.2 Why 0.8B is right for “support”

- Runs on modest hardware (SMB self-host).  
- Fast latency for chat chrome.  
- Must **not** be sole brain for irreversible financial posts — autonomy + stronger planner remain.

---

## 12. Learning from ERP incumbents (without copying debt)

| Lesson | Incumbent pattern | Our approach |
|--------|-------------------|--------------|
| App modularity | Odoo apps | Modules + marketplace + **module worlds** |
| Single ORM/data | Monolith DB | Modular schemas, **command** boundary, no cross-module private joins |
| Company/branch | Multi-company | Start **branch**, design for company later |
| Import tools | Data import wizards | AI-assisted **ingestion module** + command commit |
| Studio/customization | Custom fields, views | Capability catalog + config; gap tickets not forks |
| Reporting | QWeb / SSRS / BI | **ReportSpec** composition + queries |
| Security | Record rules | Permissions + branch scope + audit |

**Stay ahead:** AI/manual parity, explainability, generative UI parts, capability-gap loop, hybrid local models — areas classic ERPs bolt on poorly.

**Tech choices (current best fit):** TypeScript, Fastify, Next.js, PostgreSQL, Drizzle, Zod, custom ai-core, Vitest — keep; add object storage for ingest files, optional DuckDB/arrow later for heavy profile jobs if needed.

---

## 13. Delivery roadmap (recommended)

### Horizon A — Shell, branches, links ~ short

1. Module launcher + `ModuleShell` + CRM pilot under `/apps/crm`.  
2. `resource_link` ui-schema + orchestrator wiring from command results.  
3. Branch entity + **list all accessible + switcher** in global chrome.  
4. Spec stubs: `docs/specs/modules/{crm,platform,accounting}.md` (platform stub exists).

### Horizon B — Harness honesty & memory foundation ~ medium

1. Capability catalog + gap tickets + UI part.  
2. User invites, session hardening, branch-scoped RBAC.  
3. Turn embeddings + passive memory inject (M1–M2).  
4. Notifications inbox + optional sound; reminder jobs MVP.  
5. Ingestion MVP: Excel/CSV → profile → map → dry-run → commit customers.  
6. ReportSpec v0 + 3 seed reports; NL “build report” using catalog only.

### Horizon C — Self-dev, proactive time, SMB depth ~ longer

1. Customization agent + local coding-agent detection/handoff + test gates.  
2. Placement recommender (local / marketplace / private cloud / roadmap).  
3. FollowUp → harness re-entry; calendar + email adapters.  
4. Memory extraction side-agent + ambient consolidation + customization lessons.  
5. Deepen CRM/Accounting/Inventory to SMB checklists.  
6. Multi-model routing (local support vs plan vs frontier customize).  
7. Cross-module outcome packs (Get Paid, replenishment) via workflows.

---

## 14. Success metrics

- Time-to-first-value: install → import sample customers → open record from AI link &lt; 30 minutes.  
- Gap honesty: &gt;95% of “missing feature” evals produce ticket not hallucinated command.  
- Self-dev safety: 0 privilege escalations; extensions install only after green checks.  
- Core slimness: majority of org-specific features stay outside shared core.  
- Memory: judged-relevant passive recall on golden dialogues; p95 memory-block tokens under budget.  
- Import quality: dry-run error rate &lt; X% on golden messy Excels; human confirm structure once.  
- Report integrity: 0 metrics without query lineage.  
- Branch isolation: zero cross-branch leaks; users can list + switch all allowed branches.  
- Proactive follow-up: scheduled NL follow-ups re-enter harness and notify without duplicate spam.  
- Local support: p95 classify latency on-prem acceptable without cloud.

---

## 15. Non-goals (near term)

- Full multi-company consolidation / intercompany accounting.  
- Unrestricted per-tenant codegen into production without sandbox, tests, and policy.  
- Merging every customization into the shared monorepo by default.  
- BI tool replacement (Power BI/Metabase) — we compose **operational** reports first.  
- Real-time multi-master DB sync.  
- Using 0.8B as sole model for high-stakes financial automation or greenfield feature coding.  
- AI that grants itself roles or reads secrets into chat.

---

## 16. Immediate next implementation slices (when approved)

1. **ADR:** Module UI manifests + `/apps` routing (plus ADR 0007 already for memory/self-dev).  
2. **ui-schema:** `resource_link` + `gap_ticket` parts + chat render.  
3. **db:** `branches`, `user_branch_access`, `capability_gap_tickets`, `ingest_jobs`, memory graph tables, `notifications`.  
4. **docs/specs:** remaining module specs with SMB checklists (platform done as draft).  
5. **ai-core:** dual provider (support vs plan); gap classifier; passive memory inject spike.  
6. **platform commands:** `core.branch.*`, `core.capability.gap.*`.  
7. **worker:** reminder/notification delivery skeleton.

---

## 17. Spec index

| Document | Intent |
|----------|--------|
| [specs/agent-harness.md](./specs/agent-harness.md) | Operate business via tools; specialists; proactive general agent |
| [specs/memory-system.md](./specs/memory-system.md) | jcode-inspired semantic memory graph |
| [specs/self-development.md](./specs/self-development.md) | Gap → coding agent → marketplace/extension |
| [specs/scheduling-and-comms.md](./specs/scheduling-and-comms.md) | Calendar, reminders, follow-up, ring, email |
| [specs/modules/platform.md](./specs/modules/platform.md) | Branches, identity, gaps, marketplace, time |

---

*This roadmap keeps ChasteBusinessOS modular, AI-native, and generalizable — a **harness** where every client customization pressure becomes **configuration**, a **shared capability**, or a **controlled extension**, not an agency bottleneck or a bloated core.*
