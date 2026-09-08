## What this changes

<!-- One or two sentences. What is now true that was not true before? -->

## Why

<!-- The problem, not the implementation. Link an issue if there is one. -->

## Stack position

<!--
REQUIRED for stacked PRs. If this PR branches off another open PR rather than
off `main`, list the chain bottom-up and mark this one. A stacked PR is NOT
independently reviewable: its diff is the delta against its parent branch, not
against `main`. Reviewers need to know what they are diffing against.

Example:
    main <- os-phase3 <- m7-core-platform <- m8-signals (this PR)

Delete this block if the PR targets `main` directly.
-->

- Base: <!-- e.g. stack/m7-core-platform -->
- Chain: <!-- e.g. main <- os-phase3 <- m7-core-platform <- (this PR) -->
- Merge after: <!-- PR number that must land first -->

## How it was verified

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm --filter web build`
- [ ] `pnpm-lock.yaml` regenerated with `pnpm install` if dependencies changed
- [ ] Migrations added under `packages/db/migrations` if the schema changed
- [ ] ADR added/updated for architectural changes

<!--
CI runs `verify` (install, migrate, typecheck, lint, test, build) and
`gitleaks`. A green check here proves this PR is correct against its own base --
not that `main` is green once the whole stack lands. Say what you actually ran.
-->

## Risks / follow-ups

<!-- Rollback plan, known gaps, deferred work. Be honest about coverage. -->
