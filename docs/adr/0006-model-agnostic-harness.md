# ADR 0006 — Model-agnostic harness; NVIDIA NIM as default provider

Date: 2026-08-22 · Status: accepted

## Context
Models change monthly. The kernel must never depend on a vendor SDK or a
specific model's quirks.

## Decision
The kernel defines `ModelAdapter` (OpenAI tool-calling protocol in, agent
turns out). Providers adapt to it: `OpenAiCompatAdapter` targets NVIDIA NIM
(`integrate.api.nvidia.com`) today; any OpenAI-compatible endpoint or local
CLI agent fits the same seam. Model routing is env-configured
(primary/fast/reasoning/embeddings). Tool names are sanitized
(dots→underscores) because some providers reject them — mapping lives in
the loop, invisible to capabilities.

## Consequences
- Verified live against kimi-k3, deepseek-v4-flash, nemotron, gpt-oss, minimax.
- Swapping providers is an env change plus zero kernel edits.
