# Model provider and currency integration gates

- [x] G0: Provider configuration is tenant-scoped, encrypted, and kernel-governed.
- [x] G1: Chat, conversations, routines, support drafts, and summaries consume the workspace runtime.
- [x] G2: Settings exposes provider, base URL, model roles, key rotation, and CLI-subscription boundary copy.
- [x] G3: Organization/device currency reaches shared money formatting; UGX is covered by a unit test.
- [ ] G4: Authenticated browser proof of the Settings AI form on the running dev server.
- [x] G5: Consolidated-worktree full verification gate (typecheck, lint, and 26-task test gate; 44 web files / 308 tests passed).
- [x] G6: Refresh graft after consolidation (2708 nodes, 7553 edges, 476 cards).

G4 requires a signed-in browser session; no credentials are stored in this
worktree. G5 and G6 are completed only after the brand worktree is brought
into the engine worktree.
