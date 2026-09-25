# Architecture Decision Records

Numbered, immutable records of significant design decisions. New ADRs take
the next number; superseded ones get a Status update, never deletion.

| # | Decision | Status |
|---|---|---|
| 0001 | Governed capability model | accepted |
| 0002 | Append-only hash-chained ledger | accepted |
| 0003 | Money in integer minor units | accepted |
| 0004 | Immutable postings; corrections via reversal | accepted |
| 0005 | Money risk threshold-governed, not blanket-capped | accepted |
| 0006 | Model-agnostic harness, NIM default | accepted |
| 0007 | Single execution path through the kernel | accepted |
| 0008 | pgvector for org memory | accepted |
| 0009 | Append-only stock ledger, GL deferred | accepted (GL deferral retired by 0033) |
| 0010 | Three-way matching on vendor bills | accepted |
| 0011 | Capability conformance validated at boot | accepted |
| 0012 | Creator Mode proposals are governed artifacts | accepted |
| 0013 | Document ingestion: deterministic coding, model-assisted extraction | accepted |
| 0014 | Payroll posts as one gated ledger entry | accepted |
| 0015 | Design system brand shell | accepted |
| 0016 | Org memory retrieval capability | accepted |
| 0017 | RLS everywhere | accepted |
| 0018 | Signed plugin manifests | accepted |
| 0019 | Cash basis and year-end close | accepted |
| 0020 | Trust spine hardening | accepted |
| 0021 | Multi-currency groundwork | accepted |
| 0022 | Ledger scaling | accepted |
| 0023 | Creator sandboxing | accepted |
| 0024 | Security audit remediation | accepted |
| 0025 | Customer care agent | accepted |
| 0026 | Manufacturing module split and full production lifecycle | accepted |
| 0027 | Next.js 16.3 upgrade and first-class AI-agent tooling | accepted |
| 0028 | Cache Components adoption (incremental) and Next.js Skills | accepted |
| 0029 | Governed analytics: datasets, declarative frames, report rendering | accepted |
| 0030 | OS navigation model and token-driven theme system | accepted |
| 0031 | Routines, the proactive agent, and Paperclip compatibility | accepted |
| 0032 | Postgres-first infrastructure | accepted |
| 0033 | Inventory to GL integration: periodic valuation summary | accepted (M7) |
| 0034 | Needs-attention signal registry | accepted (M8) |
| 0035 | Module composition conformance | accepted (M8) |
| 0036 | Sales-order fulfillment model | accepted (M9.2) |
| 0037 | Money integrity surfaces | accepted (M10) |
| 0038 | People, planning, and expense decisions | accepted (M11) |
| 0039 | The understanding layer | accepted (M12) |
| 0040 | Retail & reach | accepted (M13) |
| 0041 | Durable jobs: leases, fencing, recurring occurrence receipts | accepted |
| 0042 | Durable outbound notification outbox | accepted |
| 0043 | Marketing delivery through the provider-aware outbox | accepted |
| 0044 | Routine schedule contract | accepted |
| 0045 | Atomic routine occurrences | accepted |
| 0046 | The shared posting service owns the closed-period guard | accepted |
| 0047 | One availability budget per item identity, serialized on item rows | accepted |
| 0048 | Bank matching reconciles money, not identities | accepted |
| 0049 | Order-line budgets for receipts, returns, and bills | accepted |
| 0050 | One inventory command service with item locks and count watermarks | accepted |
| 0051 | Domain compensations, not generic journal reversal | accepted |
| 0052 | Commit-time ledger enforcement | accepted |
| 0053 | Identity lifecycle and widget containment | accepted |
| 0054 | Durable agent run checkpoints | accepted |
| 0055 | Read-only trajectory replay | accepted |
| 0056 | Capability-gap contracts | accepted |
| 0057 | Isolated Creator candidate pipeline | accepted |
| 0058 | Harness composition stays above the capability kernel | accepted |
| 0059 | Persist approved harness identity and inspect it by metadata | accepted |
| 0060 | Resolve approved profiles before creating durable runs | accepted |
| 0061 | Resolve approved harness bundles through explicit adapters | accepted |
| 0062 | Govern harness composition approval through the existing approval path | accepted |
| 0063 | Record controlled evolution release handoffs without executing Creator source | accepted |
| 0064 | Record Creator canary outcomes as release evidence | accepted |
| 0065 | Tenant model providers and currency presentation | accepted |
| 0066 | Document workspaces and virtual folders | accepted |
| 0067 | Business paper design system | accepted |
| 0068 | Messaging conversation UX and capabilities | accepted |
| 0069 | Accounting workbenches separate planning, review, submission, and settlement | accepted |

Gaps in numbering are intentional placeholders for decisions not yet
written down, if you made one of those calls, write the ADR.
