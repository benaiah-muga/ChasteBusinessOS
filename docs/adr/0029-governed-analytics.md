# 0029 - Governed analytics: datasets, declarative frames, and report rendering

Date: 2026-08-24

## Status

Accepted

## Context

The platform needs analytics for humans and agents: revenue trends, invoice
aging, pipeline forecasts, customer concentration, stock valuation. The
obvious "let the model write SQL / dataframe code" designs break the core
thesis: an agent that can query arbitrary tables is an exfiltration primitive,
no matter how good the prompt. Two further constraints:

- Permission awareness must be per source domain (accounting vs crm vs
  inventory), and every access must land in the audit ledger.
- Multi-org deployments need a jurisdiction story: consumers of a number must
  be able to tell where the underlying data is domiciled.

We evaluated pandas-like JS engines: Danfo.js (unmaintained, TensorFlow.js
payload), DuckDB-WASM (powerful but redundant with Postgres aggregation), and
Arquero (small, maintained, dplyr-style verbs). For charts we evaluated
seaborn-equivalents and chose ECharts for its server-side SVG rendering,
which lets one spec serve both the live UI and downloadable reports.

## Decision

Three layers, all inside the governed capability pipeline:

1. **Extractors are ordinary read capabilities** (`analytics.*ByStage`,
   `revenueByMonth`, `invoiceAging`, `salesByCustomer`, `stockLevels`). Each
   re-declares its *source module's* permission (`accounting.read`, etc.), so
   the executor gates them exactly like native reads; each runs only
   org-scoped SQL; each result carries the org's `data_region` tag.
2. **Shaping is declarative**: Arquero-backed ops (`filter`, `sort`, `top`,
   `pick`, `groupBy`, `pctOfTotal`) validated by Zod. No expression strings,
   no eval, no arbitrary code path from model to database.
3. **Reports are rendered server-side** by `analytics.renderReport`: ECharts
   SVG plus exact HTML tables plus optional narrative text, emitted as one
   self-contained HTML document (downloadable; prints to PDF). The narrative
   is decoration; numbers come only from extracted frames, mirroring the care
   agent's "never invent numbers" rule.

Jurisdiction model: organizations gain a nullable `dataRegion` column. The
boundary is structural rather than advisory: actors are bound to exactly one
org (RLS + executor scoping), so cross-org rollups cannot be expressed at all;
the region tag makes provenance visible in every output, UI or agent.

## Consequences

- New datasets are additive: one extractor + registration + catalog entry;
  conformance, module gating, and ledger audit come free.
- The agent composes analyses through the same two tools the UI uses; there
  is no second, ungoverned analytics path to defend.
- Frame sizes are bounded (pre-aggregated extracts, row caps) because frames
  transit tool results; raw row-level exports would need streaming and a new
  risk class.
- `dataRegion` is a label, not enforcement of residency at the storage layer;
  actual geographic hosting remains a deployment concern.
