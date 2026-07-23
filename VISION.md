# ChasteBusinessOS Vision

## What we are building

**ChasteBusinessOS** is an open-source, modular, **AI-native Business Operating System** for small and medium-sized businesses.

It is **not** an ERP with a chatbot bolted on. AI is the primary way users operate the platform. Traditional manual interfaces remain available for people who prefer them, for auditability, and for precise control.

The long-term goal is simple to state and hard to deliver:

> A business owner should be able to describe their business, processes, and goals in plain language, and the system should configure and operate as much as possible -- with integrity, explainability, and human authority preserved.

We aim to be to **AI-native business software** what **Linux** is to operating systems and what **Odoo** is to modular ERP: a community-driven, extensible foundation others can trust, fork, and extend.

## Product principles

1. **Single source of truth** -- One consistent data model across departments and workflows.
2. **AI/manual parity** -- Every action a human can perform is available to AI through the same business services. AI has no special privileges and cannot bypass rules.
3. **Reliability over novelty** -- Transactional integrity and data consistency outrank autonomous cleverness.
4. **Modular by install** -- Capabilities ship as installable modules. Install only what you need.
5. **Explainable by default** -- Users can always ask why something happened, what data was used, and which rules applied.
6. **Permission-aware AI** -- Autonomy is governed by org policy, approvals, and the acting user's rights.
7. **Memory is architecture** -- Short-term chat, workflow state, long-term organizational memory, and permanent business knowledge are distinct, with explicit write policies.
8. **Loose coupling at boundaries** -- Clients (web, future mobile) consume **HTTP APIs**. Domain logic lives in the kernel and modules, not in the UI.

## How people (and AI) work

Instead of only navigating screens, users can say:

- "We're opening a second branch in Nairobi."
- "Create a quotation for our biggest customer."
- "Show me why profits dropped this month."
- "Order more stock when inventory reaches this level."
- "Prepare payroll for this month."

The system understands context across conversations, asks clarifying questions
when intent is ambiguous, plans multi-step operations autonomously, and
suggests follow-up actions after completing work.

Where interaction needs structure, the chat surface renders **validated UI
components** (forms, buttons, confirmations, plans) -- not free-form side
effects.

### Conversation intelligence

The AI layer provides four capabilities that make natural language a reliable
interface for business operations:

1. **Multi-turn memory** -- The system remembers prior messages in a session.
   "Create an invoice for that customer" resolves references from earlier
   turns. Sessions persist to the database so conversations survive restarts.

2. **Clarifying questions** -- When intent is ambiguous or required fields are
   missing, the AI asks targeted questions rather than guessing. This prevents
   incorrect actions and builds trust.

3. **Multi-step planning** -- Complex requests are decomposed into sequential
   plans with per-step confirmation. "Onboard a new employee" can produce a
   plan that creates the employee record, sets up payroll, and assigns
   department access -- each step validated through the command bus.

4. **Proactive suggestions** -- After every successful action, the system
   proposes relevant next steps based on the command just executed. Creating a
   customer suggests creating an invoice; adjusting stock suggests reviewing
   stock levels. Suggestions come from rules first, LLM refinement second.

## AI specialists (not silos)

Domain specialists (CRM, Accounting, Inventory, Purchasing, Analytics, HR, Knowledge, ...) are **scoped operators** over module command registries. They improve routing and reasoning; they do **not** own private write paths.

- Tools come from **installed modules**.
- Execution goes through the **kernel command bus**.
- A conversation **orchestrator** handles policy, memory, autonomy, and multi-domain work.

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
- Operators trust the system because every AI action is inspectable and reversible where policy allows.
- Conversations feel coherent -- the AI remembers context, asks when unsure, and suggests what comes next.
- Complex operations are broken into plans the user can review step by step before anything executes.
- Contributors can add a module without forking the kernel or rewriting the UI stack.
- Self-hosters can run a lean, understandable stack (TypeScript, Node.js, PostgreSQL) without a cloud lock-in.

## Non-goals (near term)

- Replacing professional judgment in regulated domains without human oversight
- Black-box analytics that cannot be verified
- Monolithic "do everything" installs that overwhelm SMBs
- AI that mutates data outside the business command layer

## North star

**Trustworthy automation of real business operations** -- transparent, modular, permissioned, and built in the open.
