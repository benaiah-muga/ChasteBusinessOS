# ChasteBusinessOS

An ERP where the AI can do everything you can do, through the same doors you use.

`erp` `ai-agents` `accounting` `double-entry` `human-in-the-loop` `audit-trail` `postgresql` `pgvector` `nextjs` `typescript` `turborepo` `drizzle-orm` `pos` `crm` `open-source`

---

I've watched companies spend six months implementing ERPs and another year learning to hate them. The software is fine. The problem is that someone has to sit there and click through every screen. ChasteBusinessOS flips that. You describe your business in plain language, an agent sets up your chart of accounts and starts working, and every action it takes passes through the exact same checks yours do. It cannot spend money without hitting the same $500 threshold you would. It cannot grant itself a role. When it meets something it can't do, it files a ticket instead of making something up.

That last part matters more than it sounds. The failure mode for AI business software is confident nonsense. A model invents a field, posts a made-up entry, and nobody notices until tax season. We designed so the model physically can't do that. It calls capabilities. Capabilities validate input against schemas, check permissions, consult policy, execute, and write to a hash-chained ledger. If a step fails, nothing happens and the agent has to explain why.

## The one rule

There is exactly one way to change state in this system, and humans and agents share it.

```
intent → resolve capability → validate input → check permissions
      → policy evaluation → [execute | request approval]
      → append to ledger → notify
```

When you click "pay invoice" in the UI, that button calls the executor. When you type "pay the Acme invoice" in chat, the model calls the same executor with the same capability ID. One path means one place for security review, and automatic parity between what you can do and what your AI co-worker can do.

Capabilities carry their own metadata. Risk class (`read`, `write`, `money`, `identity`, `destructive`), permission reference, zod schemas, and an inverse action so corrections are possible. The registry validates all of this when the server boots. If a module declares an inverse pointing at something that doesn't exist, boot fails. Broken plugins have killed enough ecosystems; we check instead.

## What actually runs today

This isn't a whitepaper. All of this works and each item below is proven by a demo script you can run.

**Books that hold themselves together.** Double-entry core as pure functions, with property-based tests generating hundreds of random balanced ledgers and asserting the balance sheet still balances. Those tests earned their keep early: they caught zero-total invoices producing empty postings, and a sign error that negated revenue. Journal entries are immutable. Corrections happen through mirror reversals that reference the original. Close a period and posting into it fails, even if the agent really wants to.

**Money that asks permission.** Payments above your org's threshold sit in an approvals inbox rendered like a pull request, with the full payload and a reason. The default threshold is $500 and each org sets its own. Approve executes under your authority; reject writes the refusal to the ledger. Identity changes and destructive operations always gate, regardless of policy. An agent once tried to close an accounting period on its own. The gate held, and that story is now a test.

**Sales end to end.** Customers, invoicing with automatic receivable postings, AR aging buckets, payments with overpayment protection. On the buy side, vendors, bills with per-line expense coding, AP aging, threshold-gated bill payments. P&L and balance sheet compute from live balances, and if the equation ever stops holding, the UI shows a red UNBALANCED badge rather than pretending.

**A register that counts honestly.** Open a drawer with a float, ring cash and card sales where each sale posts atomically, then count the drawer at close. Card sales bypass the drawer. Cash sales don't. If counted cash differs from expected, the variance gets flagged in orange and stays flagged. A NULL column bug here briefly made cash sales invisible to reconciliation; live verification caught it, which is why we verify live.

**A pipeline you can drag.** Deals across six stages with weighted forecasting. Lead values at 10%, negotiation at 70%. The forecast number is honest about being a guess.

**An agent with receipts.** Chat streams tokens as they arrive and shows chips for each capability call. Every conversation replays event by event afterwards: what the user asked, what tools ran, what came back. Team channels can include the agent, which reads the thread and answers in context, audited like everything else.

## Quick start

```sh
git clone https://github.com/benaiah-muga/ChasteBusinessOS.git
cd ChasteBusinessOS
pnpm install
cp .env.example .env        # add NVIDIA_API_KEY and BETTER_AUTH_SECRET
docker run -d --name chaste-pgvector -e POSTGRES_PASSWORD=chaste_dev \
  -e POSTGRES_USER=chaste -e POSTGRES_DB=chaste_os_v2 \
  -p 5433:5432 pgvector/pgvector:pg16
pnpm --filter @chaste/db db:migrate
pnpm dev                    # http://localhost:3000
```

Sign up, describe your business in two sentences, and the workspace builds itself: ten standard accounts seeded, your description embedded into org memory, owner role granted to you.

Then try the proofs:

```sh
pnpm demo:slice   # customer → invoice → gated payment → approval → trial balance
pnpm demo:m4      # vendor bill → gated payment → P&L and balance sheet prove out
pnpm demo:m5      # register session → sales → drawer variance flagged
```

If a demo fails, that's a bug worth knowing about. These scripts are the spec.

## Models

Routing goes through NVIDIA NIM's OpenAI-compatible endpoint by default, and any OpenAI-compatible provider drops in via env config. Kimi K3 handles primary agent duty because it passed our tool-calling probes cleanly. DeepSeek V4 Flash covers fast loops. Embeddings come from nv-embedqa-e5-v5 at 1024 dimensions. The kernel never talks to a vendor SDK directly; adapters translate, and tool names get sanitized because some providers reject dots. Swap models without touching governance code.

## Repo layout

```
packages/kernel      capability contract, registry, policy engine, ledger, loop
packages/erp-core    pure domain math, property-tested, zero IO
packages/db          drizzle schema: orgs, RBAC, ledger, sessions, vectors
packages/ai          NIM adapter, embeddings, coding-agent detection
modules/             accounting, crm, purchasing, messaging, pos
apps/web             Next.js console: chat, accounting, pipeline, POS,
                     messages, approvals inbox, ledger viewer, session replay
docs/adr/            nine decision records explaining the why
scripts/             demo proofs, runnable specifications
```

## Honest limits

Multi-currency consolidation doesn't exist yet. Neither does payroll, formal year-end close, or email notifications, though the webhook seam for those already runs. Creator Mode, where permitted users have the agent build features onto the platform itself behind sandboxed proposals, is designed and sketched in the roadmap but not built. Single-org per user for now. Postgres 14 lacks pgvector support without extra work, hence the Docker container.

We'd rather ship this paragraph than pretend those features exist.

## Contributing

Read `AGENTS.md` even if you're human. It holds the conventions, the verification gate of typecheck, lint, tests and a demo, and the rules for authoring new capabilities. Significant decisions get an ADR in `docs/adr/`. Behavioral changes get a `CHANGELOG.md` entry. Both stay because future contributors, human or not, deserve to know why things are the way they are.
