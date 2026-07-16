# ADR 0001: TypeScript and Node.js LTS

## Status

Accepted

## Context

ChasteBusinessOS needs shared validation across API, AI tools, and generative UI;
strong OSS contributor familiarity; and a lean self-host story.

## Decision

- Primary language: **TypeScript** (strict)
- Production runtime: **Node.js LTS**
- Package manager: **pnpm**

Bun is not the production runtime for v1 (optional later for local DX only).

## Consequences

- Excellent shared Zod contracts and agent DX
- Single primary language for api/worker/web tooling
- Memory profile is acceptable when API process stays lean and AI work is isolated
