# Gates: inventory replenishment planning slice

OWNS: docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/adr/0086-replenishment-planning-read-only.md, docs/adr/README.md, docs/migration/go-capability-overrides.json, CHANGELOG.md, ROADMAP.md, GATES-REPLENISHMENT.md, apps/api/internal/capability/inventory_replenishment*.go, apps/api/internal/capability/agent_tools.go, apps/api/internal/capability/agent_tools_test.go, apps/api/internal/capability/executor.go, apps/api/internal/jobs/routines.go, apps/api/internal/jobs/routines_test.go, apps/api/internal/jobs/worker.go

Scope: Deliver a read-only, deterministic inventory replenishment planning capability over live records, exposed to Workmate and routines, with tests and migration evidence.

- [x] G1: The strategy note records the post-migration baseline, the trend response, the delivery gates, and the deliberately deferred work.
  EVIDENCE: Reviewed docs/strategy/2026-10-19-post-migration-agentic-erp.md: baseline commit 3b0d7bd0 and green CI run 39203144543, five trend responses, gates A through F, the deferred list, and the first-slice acceptance are present.

- [x] G2: The pure replenishment math uses documented integer and rounding rules and its unit tests pass.
  CHECK: go -C apps/api test ./internal/capability -run '^TestReplenishmentMath' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/capability/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=4a4649a1df4e5133460664cdabf9cca3a01bf0bd31da4bd44e268e861562b428; output-bytes=82

- [x] G3: The capability is registered as a read-only inventory capability, its input contract rejects unknown or invalid fields, and Workmate advertises it only with inventory.read.
  CHECK: go -C apps/api test ./internal/capability -run '^TestInventoryReplenishmentPlan' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/capability/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=87a0f2b95cebdcb5659a8fb10b7c006815cfad7f174392ab49b07046f3d2e996; output-bytes=82

- [x] G4: The executor proof runs the capability against a migrated database and shows open incoming supply and reservations reduce the suggestion while another tenant's records stay invisible.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestInventoryReplenishmentPlanExecutor' -count=1 -v
  EXPECT: /--- PASS: TestInventoryReplenishmentPlanExecutor/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=00a907b14fb0ab3f60996ec47a5bc7edd8cb3b39ba6f1ae6266e850b31fbb7a7; output-bytes=255

- [x] G5: Scheduled routines advertise the same replenishment contract and permission as Workmate.
  CHECK: go -C apps/api test ./internal/jobs -run '^TestRoutineTools' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/jobs/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=7aa9c9275093c654d91a12724dcf37487e70d5c61328e01d7848d09444c6da15; output-bytes=76

- [x] G6: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=dc96250017d0b3cb67752948ecd5c10be3c70b924d0426d9165471f2bc1564fc; output-bytes=2109

- [x] G7: The TypeScript workspace typechecks and lints cleanly.
  CHECK: pnpm typecheck && pnpm lint && echo WORKSPACE_CHECKS_OK
  EXPECT: WORKSPACE_CHECKS_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=9259385c39c0e8b41788b9a573766925fc0dde2d2f9626597bba830cfcf4ef7d; output-bytes=19200

- [x] G8: The capability manifest stays in sync with the new registration.
  CHECK: pnpm migration:capabilities:check
  EXPECT: Capabilities:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=a0a29278c7f154e74688877d7060f5b02d43b2073e1f7c99cb2eed4928d9a1b5; output-bytes=175

- [x] G9: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/internal/capability/inventory_replenishment.go apps/api/internal/capability/inventory_replenishment_math.go apps/api/internal/capability/inventory_replenishment_test.go apps/api/internal/capability/inventory_replenishment_math_test.go apps/api/internal/capability/executor.go apps/api/internal/capability/agent_tools.go apps/api/internal/jobs/routines.go apps/api/internal/jobs/worker.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9
