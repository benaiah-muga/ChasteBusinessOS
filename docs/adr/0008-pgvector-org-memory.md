# ADR 0008, pgvector for org memory; no separate vector database

Date: 2026-08-22 · Status: accepted

## Context
Agent memory (business profile, SOPs, preferences) needs semantic retrieval,
but a second datastore (Pinecone/Qdrant) splits the source of truth and adds
ops burden.

## Decision
Embeddings live in Postgres via pgvector (`memories.embedding`, HNSW-ready),
tenant-scoped by `org_id`. Embeddings come from NVIDIA NIM
`nv-embedqa-e5-v5` (1024-dim, free tier). Keyword fallback uses `pg_trgm`.
Onboarding embeds the business description; retrieval degrades gracefully
(zero-vector) if the embedding service is down.

## Consequences
- Joins between memory and transactional data are plain SQL.
- One backup story. Migration path to dedicated ANN infra stays open if
  recall/latency demands it.
