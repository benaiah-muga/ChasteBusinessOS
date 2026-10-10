# Gates: React and Go migration, Vite home, foundation reads, and capability slices

OWNS: AGENTS.md, GATES.md, .env.example, .github/workflows/ci.yml, README.md, CHANGELOG.md, package.json, packages/db/**, apps/api/**, apps/web-vite/**, apps/web/src/app/(app)/accounting/page.tsx, apps/web/src/app/api/policy/route.ts, apps/web/src/app/api/ledger/route.ts, apps/web/src/app/api/customers/route.ts, apps/web/src/server/auth.ts, apps/web/src/server/auth-origins.ts, apps/web/src/server/auth-origins.test.ts, apps/web/src/server/ui-surface.test.ts, apps/web/src/server/policy-route.test.ts, apps/web/src/server/go-bridge.ts, apps/web/src/server/go-bridge.test.ts, apps/web/src/server/ledger-route.test.ts, docs/**, scripts/migration/**, modules/crm/**, packages/erp-core/src/duplicates.ts, scripts/demo-slice.ts

Scope: Preserve the migration plan and verify the Go foundation, policy and ledger reads, Vite login and organization switching, verified-email boundaries, internal CRM capability and approval slices, and repository gates.

- [x] G1: The plan identifies the current runtime boundaries and a concrete target architecture.
  EVIDENCE: Plan records the route, page, capability, backend, worker, and test inventory, then defines the Vite, Go, PostgreSQL, and staged-auth target.

- [x] G2: The plan defines parity checks for data, auth, governance, audit, agent flows, routes, and existing demos.
  EVIDENCE: Plan lists the preserved contracts and golden-fixture comparisons, including adaptation of direct-TypeScript demos to exercise Go.

- [x] G3: The plan gives an ordered delivery path with ownership, measurable speed gates, cutover, and rollback.
  EVIDENCE: Seven dependency-gated phases include a benchmark protocol, one-writer route ownership, cutover rules, and rollback conditions.

- [x] G4: A numbered ADR records the tradeoffs and the roadmap links the migration program.
  EVIDENCE: ADR 0070 is listed in the ADR index and linked from the roadmap.

- [x] G5: AGENTS.md keeps repository engineering practices and uses framework-neutral React, Vite, and Go guidance.
  EVIDENCE: Engineering, data, security, changelog, graft, and demo rules remain; Next-specific text was removed and the file was scanned for framework-specific references.

- [x] G6: Receivables aging cards filter the invoice list, return focus, and reveal long lists on demand.
  CHECK: pnpm exec vitest run --silent=false src/server/ui-surface.test.ts
  EXPECT: RECEIVABLE-AGING-FILTERS-OK
  CWD: apps/web
  EVIDENCE: Direct run exited 0; all 12 ui-surface tests passed, including RECEIVABLE-AGING-FILTERS-OK.

- [x] G7: The Go API tests and vet pass while connected as the provisioned least-privilege role.
  CHECK: DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only pnpm db:provision-runtime && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/policy/
  EVIDENCE: Direct run exited 0; provisioning reported chaste_app ready; Go integration tests and vet passed with GO_RUNTIME_INTEGRATION_REQUIRED=1.

- [x] G8: TypeScript, lint, full tests, and the generated API/page inventory pass.
  CHECK: pnpm typecheck && pnpm lint && pnpm test && pnpm migration:routes:check
  EXPECT: Routes:
  EVIDENCE: Each check exited 0; typecheck passed 27 packages, lint had 0 errors, full tests passed 24 tasks including 48 web files / 342 tests, route inventory reported 93 route files / 156 methods / 30 pages.

- [x] G9: The Vite React client passes strict TypeScript checking and produces production assets.
  CHECK: pnpm --filter @chaste/web-vite build
  EXPECT: built in
  EVIDENCE: Direct run exited 0; tsc --noEmit passed and Vite 8.3.1 emitted index.html, CSS, JS, and the local favicon.

- [x] G10: Workspace typecheck and lint include the new Vite client without introducing errors.
  CHECK: pnpm typecheck && pnpm lint
  EXPECT: Tasks:
  EVIDENCE: Typecheck exited 0 with 27/27 packages successful; lint exited 0 with existing advisory warnings and no errors.

- [x] G11: The Vite client renders in a browser and its health refresh reaches the Go API through the dev proxy.
  EVIDENCE: agent-browser loaded the page, showed a connected Go API and database, refreshed through /api/health with HTTP 200, and reported no console errors; screenshot reviewed at /tmp/chaste-vite-shell.png.

- [x] G12: The migration census records the complete live capability registry and detects drift in CI.
  CHECK: pnpm migration:capabilities:check
  EXPECT: Capabilities:
  EVIDENCE: Generator and CI drift check passed; manifest contains all 311 runtime registrations across 21 modules, with risk, permission, inverse targets, and input/output JSON Schemas.

- [x] G13: The policy GET can opt into the Go-backed response after session/permission checks; the default stays on legacy and POST stays on the governed path.
  CHECK: pnpm --filter web exec vitest run src/server/policy-route.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/policy ./internal/httpapi
  EXPECT: 6 tests passed
  EVIDENCE: Six adapter tests passed. Go integration tests passed with the provisioned runtime role, reading a configured policy and defaults for a second organization. Go vet passed; the full repository gate passed 27 typecheck targets and 342 tests. GET stays legacy unless GO_POLICY_READ=1; POST remains on iam.setOrgPolicy.

- [x] G14: Go ledger reads require a distinct signed audience and the accounting.read claim before querying data.
  CHECK: go -C apps/api test -v ./internal/authbridge ./internal/httpapi
  EXPECT: /--- PASS: TestGoLedgerHandlerRejectsMissingPermissionBeforeRead/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=95876b6cea61d1621911acf44563635391bb7db0baf18fe1953927e1d4e4b0e7; output-bytes=3671

- [x] G15: Go reads preserve existing ledger rows, event fields, descending order, limit behavior, and organization isolation under the runtime role.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only go -C apps/api test -v ./internal/ledger
  EXPECT: /--- PASS: TestPostgresReaderPreservesLedgerRowsAndScopesOrganizations/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=c18e7fd1ff4c2add2f4b1deeda5653a71ac99bcbc97481529ac07b742c5b1674; output-bytes=233

- [x] G16: The legacy API preserves its response and authorization, with optional Go reads failing closed and shadow mode returning legacy data.
  CHECK: pnpm --filter web exec vitest run src/server/ledger-route.test.ts src/server/go-bridge.test.ts
  EXPECT: /Tests\s+9 passed \(9\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=fed37ce4cee9933647ec469275953f79720467ef55c957a73ff3ecff827dd35c; output-bytes=32606

- [x] G17: The ledger route remains legacy-owned until every parity gate passes.
  EVIDENCE: `docs/migration/route-ownership.json` still lists `GET /api/ledger` as `legacy/pending`; `route-ownership-overrides.json` remains empty. The manifest check passes.

- [x] G18: The migration slices pass the repository TypeScript, lint, test, Go, and inventory gates.
  CHECK: pnpm typecheck && pnpm lint && pnpm test && pnpm go:verify && pnpm migration:routes:check && pnpm migration:actions:check && pnpm migration:data:check && pnpm migration:capabilities:check && pnpm migration:inventory:check
  EXPECT: Continuity inventory:
  EVIDENCE: Re-run after the Vite login, dev-only Better Auth origin, Go approval decision, and human-write policy parity slices exited 0. Workspace typecheck completed 27/27 packages; lint had zero errors and 214 warnings; tests completed 25/25 tasks; Go tests and vet passed; migration checks reported 156 API methods, 1 server action, 133 tables, 311 capabilities, and 292 valid source citations.

- [x] G19: Unverified sessions cannot read organization names or set the active-org cookie; verified members retain the existing cookie contract.
  CHECK: pnpm --filter web exec vitest run --reporter=dot src/server/org-route.test.ts
  EXPECT: /Tests\s+7 passed \(7\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=5f68afca01f84d46abd91d0c1cba7a4cf1e630aa3f3697ceffc262fd0a107ff7; output-bytes=32520

- [x] G20: The Vite organization API client validates response shapes, carries same-origin credentials, and reports permission failures.
  CHECK: pnpm --filter @chaste/web-vite exec vitest run --config vitest.config.ts src/api/organizations.test.ts
  EXPECT: /Tests\s+4 passed \(4\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=630b9ec48347f9d799ebcb783974d2f2661facf0679dd4e2a33b8b4445448204; output-bytes=303

- [x] G21: The Vite selector covers memberships, signed-out and empty states, pending changes, timeout recovery, and server rejection.
  CHECK: pnpm --filter @chaste/web-vite exec vitest run --config vitest.config.ts src/components/ActiveOrganization.test.tsx
  EXPECT: /Tests\s+6 passed \(6\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=ae3a1603463f91472d4fa317791b7151b57713e6033ce619cf034e8fd262f2ff; output-bytes=318

- [x] G22: Vite builds the React client with the active-organization selector and same-host development proxy.
  CHECK: pnpm --filter @chaste/web-vite build
  EXPECT: built in
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=696d6af89af01c11369e74aa024539e0dd3c11b6196619c0e7eb025208add527; output-bytes=378

- [x] G23: Runtime browser verification shows the Vite shell, connected Go health endpoint, recoverable legacy-org timeout, and no browser errors.
  EVIDENCE: agent-browser loaded localhost:5173 with no Vite overlay or console errors; Go health refreshed to connected with a connected database. The existing Next dev server did not complete cold compilation of /api/org during this check, so Vite showed its 12-second timeout recovery and retry control. Screenshot: /tmp/chaste-vite-org-loading.png.

- [x] G24: Go org-switch assertions require their own audience and short lifetime, and the internal handler validates the signed target before membership access.
  CHECK: go -C apps/api test -v ./internal/authbridge ./internal/httpapi
  EXPECT: /--- PASS: TestGoOrgSwitchHandlerRejectsInvalidBodyAndClaimMismatch/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=412b4cea4968215bb733ee8b25d710c0f3899cffcb0b6e22518ef626a22eb6af; output-bytes=7156

- [x] G25: Go organization switching preserves the active-org cookie contract and denies nonmembers without setting a cookie.
  CHECK: go -C apps/api test -v ./internal/httpapi
  EXPECT: /--- PASS: TestGoOrgSwitchHandlerSetsExistingCookieForMember/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=cd2faaf9f7cf4196cadd321694b4a0a9a8383100e0d60848c10811bca9fdcccc; output-bytes=6059

- [x] G26: The Go organization switch rechecks membership in PostgreSQL under the runtime role and tenant RLS.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only go -C apps/api test -v ./internal/httpapi
  EXPECT: /--- PASS: TestGoOrgSwitchHandlerRechecksMembershipUnderRuntimeRLS/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=6d9a3d0ffcedf40f13d979cfce139e8cb6822acc2aebda8721f3b4c48362a29e; output-bytes=6388

- [x] G27: The legacy `/api/org` route remains the default, and the opt-in Go adapter forwards only a validated cookie while failing closed.
  CHECK: pnpm --filter web exec vitest run --reporter=dot src/server/org-route.test.ts src/server/go-bridge.test.ts
  EXPECT: /Tests\s+18 passed \(18\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=f7a9c873ac323364c645a77f9bb391408273897652c03a315ffedf62e15b3010; output-bytes=32544

- [x] G28: Go customer duplicate matching preserves the TypeScript normalization, priority, and warning verdicts used by crm.createCustomer.
  CHECK: PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/crm
  EXPECT: /--- PASS: TestFindDuplicateMatchesTypeScriptVectorsAndFirstMatchPriority/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=1e4e596a7780d469e032a1904cc45b68e6bfc2391d825aab10996317a6c4e8c3; output-bytes=7582

- [x] G29: Capability assertions bind one actor, session, capability, permission set, and canonical input digest for at most 30 seconds.
  CHECK: PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test ./internal/authbridge ./internal/httpapi && pnpm --filter web exec vitest run --reporter=dot src/server/go-bridge.test.ts
  EXPECT: /16 passed \(16\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=6e956254186dd12487554cdd337ea622800a4c1868c360c4cb26af95cc8f8b7f; output-bytes=32704

- [x] G30: Go rechecks the active verified Better Auth session, domain-email binding, organization membership, and current grants under tenant RLS before a CRM write.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerExecutionRechecksVerifiedIdentityAndMembership/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=e5981ef9d444f2fb13f40f6b005d0dd81966b1d94d7471709f04549f3335cb05; output-bytes=3875

- [x] G31: Agent CRM module, permission intersection, and autonomous-risk policy gates preserve approval behavior before effects or receipts.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerExecutionCreatesApprovalWithoutEffectWhenPolicyGates/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=e5981ef9d444f2fb13f40f6b005d0dd81966b1d94d7471709f04549f3335cb05; output-bytes=3875

- [x] G32: A Go customer effect, capability.executed event, and action receipt commit atomically while extending the existing global hash chain.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability ./internal/ledger
  EXPECT: /--- PASS: TestGoCustomerExecutionRollsBackEffectWhenAuditAppendFails/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=dfac4062d29c03d8a74577cdc297f70f46e19b2fbade54091a1c9a17c6b81238; output-bytes=4586

- [x] G33: Same-intent CRM retries replay their receipt, conflicting input is refused, and concurrent requests create one customer and ledger event.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerExecutionSerializesSameIntent/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=e5981ef9d444f2fb13f40f6b005d0dd81966b1d94d7471709f04549f3335cb05; output-bytes=3875

- [x] G34: The public multi-action customer route and its demo remain legacy-owned until all five CRM actions, approval decisions, agent dispatch, and audit-failure parity use the Go executor.
  EVIDENCE: `docs/migration/route-ownership.json` lists POST /api/customers as legacy/pending; `route-ownership-overrides.json` has an empty override list. The unchanged `scripts/demo-slice.ts` still exercises agent customer/invoice/payment actions followed by human approval.

- [x] G35: Vite login preserves existing Better Auth sign-in, sign-up, verification, and error behavior while the auth service remains legacy-owned.
  CHECK: pnpm --filter @chaste/web-vite test && pnpm --filter @chaste/web-vite build
  EXPECT: built in
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=3666f1ddb9cd12496fec496f6101f7ff3c1bfeb301b7c4f33e10af85d4c1e3f6; output-bytes=1074

- [x] G36: The Vite `/login` route renders in a browser and its auth requests reach the legacy Better Auth endpoint through the same-origin proxy without browser errors.
  EVIDENCE: `agent-browser` rendered `http://localhost:5173/login` with sign-in and account-creation controls. After the cold legacy auth route finished compiling, two same-origin `/api/auth/get-session` requests returned HTTP 200 with a null session; the browser showed no page or console errors. The browser session was closed. The cold legacy route compile took about seven minutes, so Vite login still depends on a slow first compile until auth moves off the legacy server.

- [x] G37: Better Auth trusts the Vite development origin only in development and retains the configured application origin.
  CHECK: pnpm --filter web exec vitest run --reporter=dot src/server/auth-origins.test.ts
  EXPECT: /Tests\s+2 passed \(2\)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=c31cc5861b917bd7bff00e3879c90eee09d6ad36f3daba289e1ec2840da70658; output-bytes=32508

- [x] G38: Go CRM policy matches the current TypeScript behavior for human writes, and approval re-executes an agent's exact stored payload once without creating another gate.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerExecutionMatchesLegacyHumanWritePolicy/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=8dc05d4f08c6/20 entries; EXPECT=matched; output-sha256=e0caf8a4de12dae4ee6c5d93ea724a3911c153de6da2689ae16df27bc5efb7ca; output-bytes=5329

- [x] G39: Go `crm.deactivateCustomer` preserves the existing soft-deactivation response and customer history while enforcing permission and organization scope.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerDeactivationPreservesHistoryAndScopesOrganization/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=5c57e7baf8cc4854587b08538bac7976b671159a856523bc731f352cd64b4241; output-bytes=5899

- [x] G40: Go CRM profile update, restore, and reapply preserve legacy field, tag, inverse, and audit behavior.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerProfileUpdatesAndInversesMatchLegacy/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=d28d6325439e1791aedbc1860c9bf3edb0e972347bbe6de1468cbbccbd9b7c2f; output-bytes=6727

- [x] G41: Go CRM profile operations reject cross-organization customers and non-member owners before changing rows.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerProfileUpdatesEnforceOrganizationScope/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=fdcfaf3b0f50321f643c1f67a690cab4aee464411c06ec62b542ae02334d8c54; output-bytes=6587

- [x] G42: Go customer merge combines the same profile fields and keeps existing document and transaction references unchanged.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerMergeMatchesLegacyAndPreservesHistory/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=a08362bb8044f7dc77ac8c317006d6864fcc46bc1c7585fb0fefd170e7ac1a78; output-bytes=7401

- [x] G43: Go customer merge restore preserves the legacy snapshot contract and returns the current values for its inverse.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerMergeRestorePreservesLegacySnapshotSemantics/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=353bcccf955f667059d39ea2f34aa4153bf53ea44f718c951e79c90cd48979d8; output-bytes=7403

- [x] G44: Go customer import, undo, and restore preserve duplicate skipping, inserted row shape, and inverse output.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerImportsAndInversesMatchLegacy/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=353bcccf955f667059d39ea2f34aa4153bf53ea44f718c951e79c90cd48979d8; output-bytes=7403

- [x] G45: Go merge and import actions enforce tenant scope and approval policy, and roll back effects when audit append fails.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerMergeAndImportEnforceScopeApprovalAndAudit/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=353bcccf955f667059d39ea2f34aa4153bf53ea44f718c951e79c90cd48979d8; output-bytes=7403

- [x] G46: Vite home requires a valid session, validates dashboard/setup/work-queue payloads, and preserves the legacy dashboard's visible facts, currency preference, loading/error states, receipt reminders, and workmate brief action.
  CHECK: pnpm --filter @chaste/web-vite test && pnpm --filter @chaste/web-vite build
  EXPECT: built in
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=23589e052c9ebde88a4b64fa4db81565c1b749b456c5dc28cab119254d090d1a; output-bytes=2295

- [ ] G47: The Vite home renders against the legacy dashboard and work-queue APIs in a browser; organization changes refresh its data, Ask actions prefill the existing workmate, and unported routes still reach their legacy owner.
  EVIDENCE: Browser redirected a signed-out request to Vite `/login`; controlled dashboard/setup/work-queue responses rendered the receipt reminder, and “Brief me” posted and displayed its response. `/onboarding` kept its query and hash when it reached the legacy dev origin, with no page errors. The browser had no signed-in session, so live API data, org-switch refresh, and prompt-to-dock handoff remain unverified.

- [x] G48: Go reproduces the dashboard's current financial and operational read calculations under tenant RLS; signals and the public route remain legacy-owned.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/dashboard
  EXPECT: /--- PASS: TestPostgresDashboardReaderMatchesLegacyAndScopesOrganizations/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=e10fcd88fc40/21 entries; EXPECT=matched; output-sha256=b636267a9be4b1e65f0a1158bebf4c3dc3535287cd083a938c67881b98cf003f; output-bytes=1198

- [x] G49: Go invoice creation preserves the legacy input, totals, posted document and balanced journal entry; audit failure rolls back the document and receipt.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoInvoiceCreationMatchesLegacyAndRollsBackOnAuditFailure/
  EVIDENCE: Full DB-backed Go suite exited 0 after the invoice parity test passed; covers empty currency default, 246000 total, posted journal, balanced trial balance, and rollback on injected audit failure.

- [x] G50: Go payment recording enforces tenant and accounting permissions, applies the configured money threshold, and its declared inverse reverses the payment while trial balance remains correct.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoPaymentAndReversalMatchLegacyAndBalance/
  EVIDENCE: Full DB-backed Go suite exited 0; payment, reversal, default and override thresholds, strict human money-gate behavior, permissions, and trial-balance checks passed.

- [x] G51: A verified, authorized human can decide a Go-created payment approval once; the stored payload is executed unchanged and concurrent decisions do not duplicate payment or audit effects.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -v ./internal/capability
  EXPECT: /--- PASS: TestGoMoneyApprovalDecisionReexecutesExactPayloadOnce/
  EVIDENCE: Full DB-backed Go suite exited 0; approval used the exact stored payment payload, human decision completed, and concurrent duplicate decisions produced one payment and one execution audit event.

- [x] G52: `pnpm demo:slice` creates the customer and invoice through Go, gates the large payment for approval, completes the verified human decision, and proves the books balance; public customer, accounting, and approval routes remain legacy-owned.
  CHECK: pnpm demo:slice
  EXPECT: GO DEMO SLICE PASSED
  EVIDENCE: `pnpm dev:api` health returned status ok and db connected; demo exited 0, created a 246000 USD invoice, held payment at the 50000 threshold, completed human approval, persisted exactly one payment, and reported balanced trial balance. Public route inventory remains legacy-owned.

- [x] G53: Go reverses a legacy-created foreign-currency payment as both linked journal entries, keeping each mirror in its original currency and refusing a second reversal.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoLegacyFxPaymentReversalMatchesBothCurrencies$' -count=1 -v ./internal/capability
  EXPECT: /--- PASS: TestGoLegacyFxPaymentReversalMatchesBothCurrencies/
  EVIDENCE: DB-backed FX reversal test passed in the focused suite and full Go suite; both original currencies and exact debit/credit mirrors were verified, and a second reversal was refused.

- [x] G54: Go creates a foreign-currency invoice with the legacy rate snapshot, posts paired settlements with exact realized gains and losses using explicit or latest effective rates, reverses both currencies, and keeps the trial balance balanced.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoFxInvoiceAndPaymentMatchLegacy$' -count=1 -v ./internal/capability
  EXPECT: /--- PASS: TestGoFxInvoiceAndPaymentMatchLegacy/
  EVIDENCE: Full DB-backed Go suite exited 0; FX invoice snapshot selected the latest effective 5/4 rate, explicit rates posted +200 and -200 outcomes, default settlement excluded the future rate, paired reversals restored invoice balances, and trial balance remained balanced. Pure tests covered zero and three-decimal currencies.

- [x] G55: Go `accounting.recordFxRate` validates and stores the legacy rate fraction, effective timestamp, uppercase quote currency, and actor attribution; invalid rates leave no row and a policy-gated agent rate is replayed from its stored payload once after human approval.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoRecordFxRateMatchesLegacy$' -count=1 -v ./internal/capability
  EXPECT: /--- PASS: TestGoRecordFxRateMatchesLegacy/
  EVIDENCE: Focused DB test and full Go suite exited 0. Agent-created approval replayed exact stored input once under human attribution; direct intent replay did not add a rate; invalid rate added no rate, receipt, or execution audit.

- [x] G56: Vite renders the approvals queue and decision history using the legacy API contract, keeps approval decisions on the governed legacy backend, redacts secrets in previews, and preserves legacy production route ownership.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite test && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite build && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm migration:routes:check
 EXPECT: /Routes:/
  EVIDENCE: Vite tests passed with 9 files and 47 tests; production build emitted 153 modules; Vite lint passed; route inventory stayed at 93 files, 156 methods, and 30 pages. Both route-ownership manifests were unchanged. Browser rendered the signed-out login route with no page errors; live approval interaction remains unverified without a signed-in session and is covered by API/component tests. Secret tests cover passwords, nested tokens, API keys, private keys, authorization, and bearer fields.

- [x] G57: Go CRM `listCustomers`, `pipelineReport`, and `listTasks` preserve their legacy output shapes, filters, ordering and aggregate math while requiring `crm.read` and enforcing organization isolation.
 CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoCustomerReadCapabilitiesMatchLegacy$' -count=1 -v ./internal/capability
 EXPECT: /--- PASS: TestGoCustomerReadCapabilitiesMatchLegacy/
  EVIDENCE: Focused DB-backed CRM parity test passed and the full Go integration suite and vet passed. It covers missing `crm.read`, organization isolation for all three reads, active/non-merged customer filtering and the 100-row limit, stage order plus per-deal and aggregate weighting, and task ordering, `openOnly`, UTC dates, assignee fallback, and same-organization customer labels.

- [x] G58: Go `crm.customerTimeline` preserves legacy event sources, summaries, stable ordering, date formatting, limits, `crm.read`, and tenant isolation.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoCustomerTimelineReadMatchesLegacy$' -count=1 -v ./internal/capability
  EXPECT: /--- PASS: TestGoCustomerTimelineReadMatchesLegacy/
  EVIDENCE: Focused DB integration test passed, covering merged-customer aliases, tenant isolation, all six event sources, per-source and global limits, millisecond dates, stable source ordering, and legacy summaries. Public CRM route ownership is unchanged.

- [x] G59: Vite `/ledger` preserves the existing audit API shape, event filters, hash-chain details, auth/org shell, loading and error behavior, while the public API and page owners remain legacy.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite test && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite build && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm migration:routes:check
  EXPECT: /Routes:/
  EVIDENCE: Vite tests, build, and lint passed. Browser verification confirmed signed-out redirect to login and, with controlled API fixtures, visible audit rows, organization shell, search/no-match state, hash disclosure, hidden payloads, and no page errors. Route inventory remained 93 files, 156 methods, and 30 pages.

- [x] G60: Go webhook outbox delivery uses a dedicated NOBYPASSRLS role, metadata-only global claims, tenant-scoped payload and acknowledgements, legacy retries, lease fencing, and reconciliation; the legacy worker remains the default owner.
  CHECK: GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only CHASTE_OUTBOX_WORKER_DB_PASSWORD=chaste_outbox_worker_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoWebhookOutboxWorkerMatchesLegacy$' -count=1 -v ./internal/outbox
  EXPECT: /--- PASS: TestGoWebhookOutboxWorkerMatchesLegacy/
  EVIDENCE: Focused database proof and full Go suite passed. Tests cover role attributes and ACLs, RLS and webhook-only rows, concurrent claims, attempts and fencing, lease renewal and expiry, stable idempotency keys, 429/4xx/5xx/transport outcomes, and organization-scoped reconciliation. Public API and default worker ownership are unchanged.

- [x] G61: Vite sessions, Go CRM read modes, and the opt-in Go capability-jobs worker pass their integrated parity gates without changing the default route or worker owners.
  EVIDENCE: Parent gates N1-N3 passed after re-verifying the session UI, CRM timeline/task read modes, and Go worker leaves. Full TypeScript, lint, tests, DB-backed Go tests, vet, and Vite checks passed; route inventory remained 93 files, 156 methods, and 30 pages. The Go worker supports only its verified capability allowlist; the TypeScript worker remains the default.

- [x] G62: Go metrics reads preserve newest-200 aggregation, null hit rate, tenant isolation, signed opt-in authorization, no-store responses, and default legacy route ownership.
  EVIDENCE: All six leaf checks passed, including both DB-backed reader tests, signed assertion/organization mismatch cases, and the legacy-default adapter contract. The full Go test suite and vet passed; route inventory remained unchanged and no owner override was added.

- [x] G63: Vite `/projects` is integrated into the authenticated shell with org-scoped reload, module state, board actions, confirmation, and approval notice behavior, with focused tests and production build checks passing.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite test && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite build && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: built in
  EVIDENCE: All 91 Vite tests passed, including authenticated `/projects` routing and organization-switch reload; Vite build and lint passed. Full route inventory remained unchanged. Runtime browser interactions remain unverified under open G64.

- [ ] G64: In-app browser proof confirms `/projects` loads and its board interactions work against fixture-backed responses without browser console or request errors.
  EVIDENCE: The in-app browser was requested but the runtime returned `Browser is not available: iab`. The user stopped the separate Chromium download; no alternate browser was used. Vite is listening on `localhost:3000` for a later in-app browser check.

- [x] G65: Go implements the five Projects write capabilities with parser, input/output, permission, module, verified-session, tenant, approval, receipt, and audit parity while leaving public routes and worker ownership unchanged.
  CHECK: PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -count=1 ./internal/capability && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -count=1 -run 'TestGoProjects' -v ./internal/capability
  EXPECT: /PASS/
  EVIDENCE: Root reverified both leaf-5.1 gates after the Zod 4.4.3 parser parity review; all package and six database-backed Projects tests passed. The route inventory remains 93 files, 156 methods, and 30 pages, with no ownership override or worker allowlist change.

- [x] G66: Vite `/analytics` is integrated into the authenticated, organization-scoped shell and proxies its existing API; the Projects assignee lookup also has a same-origin team proxy.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite test && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite build && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm migration:routes:check
  EXPECT: /Routes:/
  EVIDENCE: All 105 Vite tests passed, including Analytics API/component coverage and authenticated organization-switch reload; Vite production build and lint passed; the unchanged legacy route inventory reports 93 route files, 156 methods, and 30 pages.

- [ ] G67: Requested in-app browser proof confirms `/analytics` dataset discovery, preview, report generation, download, and no console/request errors.
  EVIDENCE: The in-app browser is unavailable in the current Codex VS Code session; runtime proof remains open for both Analytics and Projects.

- [x] G68: The signed opt-in `POST /api/projects` bridge covers all five Go writes, matches legacy response shapes, and never retries unknown outcomes through the TypeScript executor; GET list and board remain legacy-owned.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/migration-projects-go-bridge/gates/leaf-5.2.md
  EXPECT: /ALL MET/
  EVIDENCE: Root reverified all three bridge leaf gates; tests cover default legacy dispatch, all five signed Go mappings, output sanitization, auth and permission errors, GET preservation, and fail-closed responses. The route inventory remains unchanged.

- [x] G69: The integrated repository passes TypeScript, database-backed Go, Vite, route ownership, and whitespace checks.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm lint && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm test && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only CHASTE_OUTBOX_WORKER_DB_PASSWORD=chaste_outbox_worker_dev_only CHASTE_JOBS_WORKER_DB_PASSWORD=chaste_jobs_worker_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -count=1 ./... && PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api vet ./... && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite test && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite build && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm migration:routes:check && git diff --check
  EXPECT: /Routes:/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: full gate exited 0. TypeScript typecheck passed across 27 workspace tasks; lint reported 205 existing warnings and zero errors; all 25 test tasks passed; all DB-backed Go packages and `go vet` passed; all 105 Vite tests, build, and lint passed; route inventory stayed at 93 files, 156 methods, and 30 pages; `git diff --check` passed.

- [x] G70: Vite is the primary local app on port 3000, with the legacy compatibility server on port 3001 and Go API on port 8080.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite test && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite build && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter web exec vitest run --reporter=dot src/server/auth-origins.test.ts && curl -fsS -o /dev/null http://localhost:3000/
  EXPECT: /Tests\s+2 passed \(2\)/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: All 105 Vite tests passed, the build emitted production assets in 727 ms, both auth-origin tests passed, and Vite returned HTTP 200 at localhost:3000 after the config restart. Next's installed CLI confirms `--port 3001`; legacy and Go servers remain stopped until needed.

- [x] G71: Approval decisions can opt into the signed Go service using the exact stored payload, while queue reads and the default decision path remain legacy-owned.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter web exec vitest run --reporter=dot src/app/api/approvals/route.test.ts src/server/approvals.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run '^TestGoMoneyApprovalDecisionReexecutesExactPayloadOnce$' -count=1 -v ./internal/capability
  EXPECT: /--- PASS: TestGoMoneyApprovalDecisionReexecutesExactPayloadOnce/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: Root reverified all three adapter gates. Fourteen route and TypeScript approval tests passed, the Go database proof re-executed the exact stored payment payload once, and typecheck, route inventory, and whitespace checks passed. `GET /api/approvals` and default POST remain legacy; `GO_APPROVAL_DECISION=1` is opt-in.

- [x] G72: Go Projects collection and board reads preserve their legacy contracts behind the signed `GO_PROJECTS_READ=1` adapter; only the unaudited collection read can run in development shadow mode.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/migration-projects-go-reads/gates/leaf-5.3.md && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/migration-projects-go-reads/gates/leaf-5.4.md
  EXPECT: /ALL MET/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: Go capability, private reader, signed assertion, tenant isolation, audit behavior, route adapter, response validation, and list-only shadow gates passed. Typecheck and lint passed; route inventory remains 93 files, 156 methods, and 30 pages. Both public Projects API methods remain `legacy/pending` with no owner override. Browser proof remains open because this session's IAB is unavailable.

- [x] G73: Invoice creation alone can opt into the signed Go capability executor, preserving the legacy public response and fail-closed write behavior while the route remains legacy-owned.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --status .unlazy/migration-accounting-invoice/GATES.md
  EXPECT: /ALL MET \(3 met\)/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: Scoped gates G1-G3 passed. Ten focused route tests cover default-off TypeScript behavior, exact signed Go capability input/session, success and approval normalization, permission mapping, unrelated actions, and no fallback after uncertain writes. The DB-backed Go invoice proof passes balanced posting and audit rollback. Repository typecheck, lint, all workspace tests, route inventory, and whitespace checks passed. `/api/accounting` GET and POST remain `legacy/pending`; no route ownership override was added.

- [x] G74: Go CRM deal lifecycle writes preserve approval, audit, replay, tenant, and worker behavior behind the signed opt-in routes while route ownership stays legacy.
  CHECK: /home/benaiah/.nvm/versions/node/v24.18.0/bin/node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/migration-crm-deals/gates/leaf-6.1.md .unlazy/migration-crm-deals/gates/leaf-6.2.md && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm migration:routes:check
  EXPECT: /ALL MET[\s\S]*Routes:/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=f67208a7a5a6/21 entries; EXPECT=matched; output-sha256=b0748b1eb9a3b1532f45e6c50a770a2e308a108ac223e78f2ecfab9917558764; output-bytes=2813

- [x] G75: The versioned Go policy HTTP contract generates matching TypeScript and Go models used by the signed Go handler and React bridge, with runtime validation and the existing response behavior preserved.
  CHECK: pnpm migration:contracts:check && pnpm --filter web exec vitest run src/server/policy-route.test.ts && go -C apps/api test -run '^TestGoPolicyHandler' ./internal/httpapi && go -C apps/api test ./internal/policy
  EXPECT: Contract outputs current
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The contract drift check passed; all 6 policy route tests passed; the Go policy handler exact response and mixed-value tests passed; policy package tests passed; web TypeScript typecheck passed.

- [x] G76: Go inventory cycle-count creation, recording, posting, and cancellation preserve the existing governed behavior through the signed opt-in route and worker paths.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --scope migration-inventory-cycle-count --status
  EXPECT: /ALL MET/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: Parent re-verification passed the Go lifecycle and worker claim tests, route bridge tests, TypeScript checks, full workspace tests, Go verification, migration inventories, and whitespace checks. Cycle counts preserve item-wide movement watermarks, location-scoped snapshot and adjustment behavior, tenant isolation, approvals, audit, replay, and the original public response shape. The Go route flag remains off by default. Browser checks remain deferred by request.

- [x] G77: Go purchase order receiving preserves the existing stock, rejection, over-receipt, approval, audit, replay, and worker behavior behind a default-off route bridge.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --scope migration-purchasing-receipts --status
  EXPECT: /ALL MET/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: Parent re-verification passed the receipt and jobs worker DB gates, route tests, TypeScript typecheck and lint, all 25 workspace test tasks, Go test and vet, and route/capability/data inventories. The M6 proof passed all 21 guarantees after making its organization fixture repeatable and aligning its approval proof with human-versus-agent identity policy. Migration 0094 adds the receipt capability to the restrictive jobs policy and claim query. `GO_PURCHASING_RECEIPT_WRITES` remains off by default. Browser checks remain deferred by request.

- [x] G78: Wave 4 budget, period-close, inventory import/reservation, and supplier payment-run capabilities plus Go vendor returns preserve route contracts, approval, audit, replay, tenant isolation, and worker execution.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:$PATH node /home/benaiah/.agents/skills/unlazy/scripts/gate-check.mjs --scope migration-wave4-returns --status
  EXPECT: /ALL MET/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: Wave 4 scope ledger reports ALL MET (7 gates). Database-backed Go capability, worker, and returns tests pass; the focused payment-run persistence test passes. Route bridges pass 94 tests with web typecheck, route/capability/data/continuity inventories pass, full workspace typecheck/lint/test and Go test/vet pass, and the M10 proof passes all 20 guarantees. Browser checks remain deferred by user request.

- [x] G79: Vite supplier statements use the session-authenticated Go capability with UUID validation, paired route selectors, `purchasing.read`, session-derived organization scope, and visible errors for unavailable or malformed results.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite exec vitest run --reporter=dot src/api/purchasing.test.ts src/components/PurchasingPage.test.tsx src/api/go-route-proxy.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run 'TestPurchasingReadsParsersMirrorZodContracts|TestPurchasingReadsSupplierAnalytics|TestGoWave8PurchasingReadsGovernedExecutorPath' -count=1 -v ./internal/capability && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: /TestPurchasingReadsSupplierAnalytics|Test Files|Tasks:/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The three focused Vite files passed all 267 tests; Go parser, supplier statement reader/executor tests passed; Vite typecheck and lint passed. Independent review found no authorization or tenant-scope issues. Browser runtime proof remains open.

- [x] G80: Vite employee hire retry markers serialize across tabs, reuse exact intents, preserve newer markers during stale cleanup, and fail closed when Web Locks are unavailable.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite exec vitest run --reporter=dot src/api/hr.test.ts src/components/HrPage.test.tsx src/api/go-route-proxy.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run 'TestGoHREmployeesParsersMatchHRContracts|TestGoHREmployeesHirePersistsAllFieldsWithDefaults|TestGoHREmployeesGovernedExecutorPath' -count=1 -v ./internal/capability && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: /TestGoHREmployeesParsersMatchHRContracts|Test Files|Tasks:/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The focused Vite API/page/proxy suite passed all 206 tests; Go parser, DB-backed employee persistence, and governed executor tests passed; Vite typecheck, lint, and production build passed; Go vet and whitespace checks passed. Independent review found no actionable issues. Browser runtime proof remains open.

- [x] G81: Vite Purchasing Intel price history and supplier performance use the selected Go reads, validate their outputs, and surface failures without empty analytics or legacy fallback.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite exec vitest run --reporter=dot --testNamePattern='purchasing intel|Intel analytics|Go Intel|price history response' src/api/purchasing.test.ts src/components/PurchasingPage.test.tsx src/api/go-route-proxy.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test -run 'TestPurchasingReadsParsersMirrorZodContracts|TestPurchasingReadsSupplierAnalytics|TestGoWave8PurchasingReadsGovernedExecutorPath' -count=1 -v ./internal/capability && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: /TestPurchasingReadsSupplierAnalytics|Test Files|Tasks:/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The focused Vite suite passed 11 Intel tests, with 256 unrelated tests skipped by the name filter. Go parser, reader, and governed executor tests passed; Vite typecheck, lint, and whitespace checks passed. Independent review found no permission or tenant-scope gaps. Browser runtime proof remains open.

- [x] G82: Vite Accounting Reports reads use the selected Go aggregate capabilities, preserve required and optional result behavior, validate all report data, and fail closed on malformed or unavailable responses.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite exec vitest run --reporter=dot src/api/accounting.test.ts src/components/AccountingPage.test.tsx src/api/go-route-proxy.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test ./internal/capability -run 'TestGoIncomeStatementExecutorPreservesPermissionAndOrganizationScope|TestGoBalanceSheetExecutorPreservesStatementParityAndOrganizationScope|TestGoCashFlowExecutorPreservesStatementParityAndOrganizationScope|TestReportCurrencyMetadataCapabilityIsOrganizationScoped|TestGoWave6FxGovernedExecutorPath|TestAccountingFxUnrealizedExposureNetsCreditsAndScopesByOrg' -count=1 -v && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: /Tests  310 passed|PASS|TypeScript|eslint/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The focused Vite API/page/proxy suite passed all 310 tests. All six DB-backed Go report, metadata, FX, permission, and organization-scope tests passed with runtime integration required. Vite typecheck and lint passed; independent review found no actionable issues. Browser runtime proof remains open.

- [x] G83: Vite Manufacturing planning reads show session and permission guidance, and Go enforces manufacturing.read plus organization scoping for cost previews, feasibility checks, and BOM reports.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite exec vitest run --reporter=dot src/api/manufacturing.test.ts src/components/ManufacturingPage.test.tsx src/api/go-route-proxy.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test ./internal/capability -run 'TestManufacturingBomParsersMirrorZodContracts|TestManufacturingWorkOrdersParsersMirrorZodContracts|TestManufacturingWorkOrdersFeasibilityAndList|TestGoWave7ManufacturingGovernedExecutorPath' -count=1 -v && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: /Tests  222 passed|PASS|TypeScript|eslint/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The focused Vite suite passed all 222 tests without React style warnings. All four DB-backed Go contract/executor tests passed with runtime integration required. The governed executor test covers all three planning reads, missing manufacturing.read denial, and rejection of an SKU that exists only in another organization. Vite typecheck and lint passed. Independent review found no remaining issues; browser runtime proof remains open.

- [x] G84: Vite customer statements use selected Go reads with strict timestamp validation and cannot show stale rows after a customer change.
  CHECK: PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite exec vitest run --reporter=dot src/api/accounting.test.ts src/components/AccountingPage.test.tsx src/api/go-route-proxy.test.ts && GO_RUNTIME_INTEGRATION_REQUIRED=1 DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 CHASTE_APP_DB_PASSWORD=chaste_app_dev_only PATH=/home/benaiah/.local/share/go/1.27.1/bin:$PATH go -C apps/api test ./internal/capability -run '^TestGoCustomerStatementExecutorPreservesResponseScopePermissionAndAudit$' -count=1 -v && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite typecheck && PATH=/home/benaiah/.nvm/versions/node/v24.18.0/bin:/home/benaiah/.local/share/pnpm/.tools/pnpm/11.9.0/bin:$PATH pnpm --filter @chaste/web-vite lint
  EXPECT: /Tests  312 passed|PASS|TypeScript|eslint/
  CWD: /home/benaiah/projects/Chaste BusinessOS
  EVIDENCE: The focused Vite API/page/proxy suite passed all 312 tests. The DB-backed Go customer statement executor test passed with runtime integration required, covering accounting.read denial, customer and organization isolation, and audit behavior. Vite typecheck and lint passed. Tests cover malformed timestamps and a late old-customer result after a new customer's statement loads. Independent review found no remaining issues. The in-app browser was unavailable, so browser runtime proof remains open.
