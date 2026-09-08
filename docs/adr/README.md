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

Gaps in numbering are intentional placeholders for decisions not yet
written down, if you made one of those calls, write the ADR.
