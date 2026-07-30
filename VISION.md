# ChasteBusinessOS Vision

## What we are building

**ChasteBusinessOS** is an open-source, modular, **AI-native Business Operating System** for small and medium-sized businesses.

It is **not** an ERP with a chatbot bolted on. AI is the primary way users operate the platform. Traditional manual interfaces remain available for people who prefer them, for auditability, and for precise control.

The long-term goal is simple to state and hard to deliver:

> A business owner should be able to describe their business, processes, and goals in plain language, and the system should configure and operate as much as possible -- with integrity, explainability, and human authority preserved.

We aim to be to **AI-native business software** what **Linux** is to operating systems and what **Odoo** is to modular ERP: a community-driven, extensible foundation others can trust, fork, and extend.

## The harness metaphor

ChasteBusinessOS is engineered as a **harness** through which a model can operate a business the way a human operator would -- using the same tools, the same rules, and the same audit trail.

| Human operator | Agent through the harness |
|---|---|
| Uses screens, forms, menus | Uses tools = registered commands/queries |
| Respects roles & permissions | Same RBAC; **never** elevated privileges |
| Knows what the product can do | Capability catalog + installed modules |
| Escalates missing features to IT/agency | **Capability Gap Ticket** → coding harness / marketplace |
| Remembers how the business works | Semantic memory graph (jcode-inspired) |
| Follows up, schedules, notifies | Scheduling, calendar, reminders, email, rings |

**Security-sensitive work stays gated:** role assignment, permission grants, break-glass admin, secret management, and destructive identity actions always require human authority at policy-defined thresholds. The agent does not invent privileges.

The point of the harness is to **remove the need for human intervention of agencies** during ordinary customization and day-to-day operations. The business speaks plain language; the platform does the easy and complex steps that are already possible -- and honestly escalates what is not.

## Product principles

1. **Single source of truth** -- One consistent data model across departments and workflows.
2. **AI/manual parity** -- Every action a human can perform is available to AI through the same business services. AI has no special privileges and cannot bypass rules.
3. **Reliability over novelty** -- Transactional integrity and data consistency outrank autonomous cleverness.
4. **Modular by install** -- Capabilities ship as installable modules. Install only what you need.
5. **Explainable by default** -- Users can always ask why something happened, what data was used, and which rules applied.
6. **Permission-aware AI** -- Autonomy is governed by org policy, approvals, and the acting user's rights.
7. **Memory is architecture** -- Short-term chat, workflow state, long-term semantic memory, and permanent business knowledge are distinct, with explicit write policies.
8. **Loose coupling at boundaries** -- Clients (web, future mobile) consume **HTTP APIs**. Domain logic lives in the kernel and modules, not in the UI.
9. **Honest about gaps** -- Missing capability becomes a ticket and a build path, never a hallucinated command or a one-off client fork.
10. **Self-development when needed** -- When config and modules are not enough, a controlled coding pipeline can extend the platform (local coding agents or cloud-hosted build) and ship back through the marketplace/registry.

## How people (and AI) work

Instead of only navigating screens, users can say:

- "We're opening a second branch in Nairobi."
- "Create a quotation for our biggest customer."
- "Show me why profits dropped this month."
- "Order more stock when inventory reaches this level."
- "Prepare payroll for this month."
- "Remind me every Friday to review overdue invoices."
- "We need multi-currency price lists with customer-specific discounts."

The system understands context across conversations, asks clarifying questions when intent is ambiguous, plans multi-step operations, engages proactively when updates or decisions are needed, and suggests follow-up actions after completing work.

Where interaction needs structure, the chat surface renders **validated UI components** (forms, buttons, confirmations, plans, resource links) -- not free-form side effects.

### Two cooperating modes

| Mode | Role | Uses |
|---|---|---|
| **Operations agent** | Day-to-day business work with what exists | Command bus, workflows, calendar, notifications, memory |
| **Customization agent** | Spec out and implement what does not exist yet | Capability catalog, gap tickets, coding harness, marketplace |

Users do not need to know which specialists or pipelines run underneath. Domain specialists (CRM, Accounting, Inventory, …) share general harness rules and add domain knowledge; the **general agent** is proactive -- it not only reacts but engages the user on necessary clarifications, confirmations, and status updates.

### Conversation intelligence

1. **Semantic multi-turn memory** -- Turns are embedded; related memories surface automatically via similarity (and optional memory side-agent verification). Explicit memory tools remain available.
2. **Clarifying questions** -- Ambiguous intent produces targeted questions, not guesses.
3. **Multi-step planning** -- Complex goals become sequential plans with per-step gates.
4. **Proactive engagement** -- Follow-ups, reminders, and "you should know" updates without waiting for the next user message.
5. **Proactive suggestions** -- After successful actions, relevant next steps from rules first, LLM refinement second.

## Capability gaps and self-development

When a request cannot be fulfilled with installed modules and configuration:

1. Classify against the **capability catalog**.
2. Do what is possible; explain the remainder honestly.
3. File a **Capability Gap Ticket** (generalized requirement, not a client-named fork).
4. With user confirmation, route to a **customization pipeline**:
   - **Local install:** detect available coding agents (OpenCode, Codex, Claude Code, …) and use them under platform conventions.
   - **Cloud hosted:** recommend whether the feature should ship as a shared marketplace module, a private org extension, or wait for platform roadmap; frontier models advised for new feature work.
5. Build, test, and deploy into a **secure extension surface**; publish to marketplace/registry when appropriate.
6. Store **how the hard customization was done** in semantic memory so future similar work reuses lessons.

We ship comprehensive **common ERP features** so most businesses never need code. Custom code is the exception path -- optimized, audited, and modular -- not the default dump into a monolithic core.

## Multi-branch organizations

Organizations operate across locations and legal/ops units. Users must be able to:

- See **all branches** they are allowed to access.
- **Switch active branch** in global chrome (and via natural language).
- Have lists, documents, and AI context scoped correctly to branch (or HQ "all allowed").

## Scheduling, calendar, reminders, and communications

The harness includes first-class **time and attention** services:

- Natural-language scheduling and follow-ups ("next Tuesday after close of books").
- Calendar entities and views shared with humans.
- Reminders with notification sound/ring where the client supports it.
- Email (and later other channels) for digests, invites, and operational alerts.
- All side effects still permissioned, audited, and policy-gated.

## Autonomy levels

Organizations configure how far AI may go:

| Level | Behavior |
|---|---|
| Recommend | Propose only |
| Confirm | Prepare validated actions; user approves |
| Guarded auto | Auto-run within allowlists and limits |
| Full autonomous | Broad auto-execution with hard warnings and full audit |

**Full autonomous mode is powerful and risky.** Users remain responsible for outcomes. The product must warn clearly; confidence in the platform never replaces organizational judgment.

## What success looks like

- A new business can stand up core operations with natural language and a short guided setup.
- Day-to-day ops rarely need external agencies; customization pressure becomes config, modules, or audited self-dev.
- Operators trust the system because every AI action is inspectable and reversible where policy allows.
- Memory feels human-like: relevant past work and decisions reappear without token-burning tool spam.
- Branch switching and visibility match how multi-location SMBs actually work.
- Contributors can add a module without forking the kernel or rewriting the UI stack.
- Self-hosters can run a lean stack and optionally plug in local coding agents for private extensions.
- Cloud tenants get safe recommendations on shared vs private feature placement.

## Non-goals (near term)

- Replacing professional judgment in regulated domains without human oversight
- Black-box analytics that cannot be verified
- Monolithic "do everything" installs that overwhelm SMBs
- AI that mutates data outside the business command layer
- Unrestricted self-modification of production without tests, review gates, and audit
- Dumping every tenant customization into the shared core codebase

## North star

**A trustworthy harness for operating and evolving a real business** -- modular, permissioned, explainable, self-extending when needed, and built in the open.
