# Enterprise planning review — 2026-09-10

## Scope and repository synchronization

Planning/documentation only. No application, schema, deployment or dependency-manifest implementation was made by this review.

Fetched `origin` and fast-forwarded `cordis-like-engine` from `af4c628` to remote main `1f3b078`. The branch had no upstream configured; its history was an ancestor of `origin/main`, so no rebase or conflict resolution was needed. Incoming changes included CSV/onboarding tests and changelog corrections.

Original local changes were `.gitignore` and the untracked `docs/CORDIS_LIKE_ENGINE_PLAN.md`. Both were backed up under ignored `.unlazy/enterprise-plan/` before integration and compared byte-for-byte afterwards. The original plan subsequently received only an additive link to the enterprise extension; its original bytes remain the prefix of the current file. `.gitignore` remains byte-for-byte unchanged from the user's version. Nothing was committed or pushed.

## Deliverables and coverage

- [Enterprise Evolution Plan](ENTERPRISE_EVOLUTION_PLAN.md): source evidence register, backend contracts, autonomy definitions and mandates, security/privacy/operations, UX/onboarding/UI, developer experience, cleanup/error conventions, measured performance programme, continuous development lifecycle, edge-case matrix, delivery waves, starter tickets and release acceptance.
- [Original plan](CORDIS_LIKE_ENGINE_PLAN.md): preserved, with an explicit link explaining the integrity-first ordering change.
- [Roadmap](../ROADMAP.md): additive proposed-programme link; historical milestone checkboxes unchanged.

The unlazy ledger is local at `.unlazy/enterprise-plan/GATES.md`. Its preservation gate is executable; planning judgments are manual gates citing concrete sections. No placeholder gate is used to pretend the proposed product has been built. The four review passes covered initial drafting, domain/architecture reread, contradiction and failure-case review, and reference/wording polish. Important corrections included identifying the actual rejection route boundary, distinguishing external compensation from undo, writable queue operation from read-replica analytics, proposed tests from executed evidence, and proposed service targets from measured guarantees.

## Verification

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed; no manifest or lockfile changes. |
| `pnpm typecheck` | Passed: 25 successful workspace tasks. |
| `pnpm lint` | Passed after fixing the review helper's console import: zero errors, 154 warnings. The first lint attempt had one error in that local helper; the final run is authoritative. |
| `pnpm test` | Failed: 7 successful task groups out of 8; `web#test` failed. Web summary: 14 test files passed, 2 failed; 202 tests passed, 1 failed, 6 skipped. |
| Source paths and local document links | Checked directly; all referenced local paths/links resolve. |
| Git preservation gate | Re-executed successfully after the helper correction. Remote baseline is an ancestor of HEAD; original local plan remains the exact prefix; `.gitignore` preserved. |
| `git diff --check` | Passed. |

The initial combined verification command stopped at the helper lint error. After correcting it, lint and tests were run separately. No application test assertions were changed to obtain a pass.

Test failures: `apps/web/src/server/products.test.ts:49` timed out in `beforeAll` at the configured 10-second limit; its six tests were skipped. `apps/web/src/server/jobs.test.ts:58` expected a “no document” business error, but received a failed SQL query against `documents`. The underlying database-query cause was not established by this planning review; do not label it a confirmed migration defect or dismiss it as unrelated without reproduction. The host was under memory/swap pressure during checks, but that observation does not prove the cause of either failure.

The repository gate remains **not green**. Investigating these failures in an isolated, migrated fixture database is a W0 prerequisite. No live milestone demo was rerun, and no claim is made that all existing milestones currently pass.

Planning ledger outcome: 7 met, 0 unmet, 0 abandoned. These gates certify the planning deliverable and accurate reporting, including failed repository tests; they do not certify the proposed implementation. Six planning judgments are manual, and the preservation gate is executable. The gate linter reports advisory warnings for that manual-heavy document-review ledger.

## Limits

This review does not certify enterprise readiness, security compliance, statutory correctness, usability or capacity. No application UI was edited, so a browser runtime proof was not required for this documentation change. Live milestone demos, penetration testing, production deployment checks, load tests and restore drills were not performed; the plan specifies where they become implementation/release gates. Findings from source are labelled separately from unverified exploit paths. No new architectural proposal was marked as an accepted ADR.

Local evidence fingerprints (logs retained under ignored `.unlazy/enterprise-plan/`; full logs are not published because tests may include business fixture payloads):

- `install.log`: SHA-256 `63cd10e284a81a400ad83edd03946a5437cffb4ad0aad7a45f3a041232b9a76e`.
- `typecheck.log`: SHA-256 `0a00f39b5da8e84247bb72643b44d88623fe7c2703e1f3ab96004231120cc0ae`.
- `lint-final.log`: SHA-256 `c74c048c8e05b280d5459dc9373308c0ff1ad8f7e0236c91844fa8d66a68da1f`.
- `test.log`: SHA-256 `6180c75f7357ad8580ce795fde8535c23c1e09a426a0d379a98033fcc3893d07`.


## Follow-up product systems review — 2026-09-11

Added [Product Systems Addendum](ENTERPRISE_PRODUCT_SYSTEMS_ADDENDUM.md) and integrated it through §16 of the enterprise plan. All 20 follow-up topics have current-state judgment, proposed behavior, ownership/priority and acceptance tests, plus wave mapping and three cross-system journeys. Existing README/assets and other local changes were left untouched. No application/runtime, skills, schema, provider account or network deployment was changed.

Source review confirmed the existing human/agent actor distinction, ask_user/AskCard, skill find/load, static capability registration and public support/portal foundations. New findings include stale skill guidance, missing catalogue goods/service kind, direct import writes with two-decimal float conversion, report rows without verified source provenance, public visitor-identity limitations and stale document derivations after version changes. These are source findings; exploit and production behavior tests remain the stated implementation gates.

Primary sources were checked for Odoo automation, DeepSeek image/API naming, Tailscale workload identity, Neon pooling and Supabase connections/RLS. Links appear beside the relevant addendum decisions; no vendor superiority or deployed compatibility is claimed.

Verification rerun: `pnpm typecheck` passed (25 cached workspace tasks); `pnpm lint` passed (zero errors, 154 warnings). `pnpm test` failed in `web#test`: 15 web test files passed, one failed; 208 tests passed and one failed. The products setup timeout from the previous run did not recur. `src/server/jobs.test.ts:58` still expected “no document” but received a failed SQL query against documents; root cause remains unestablished. Seven other task groups passed from cache. No live milestone/browser/load/security proof was performed for this documentation-only change.

Checked all 20 section IDs and ownership/acceptance sections, local document links and `git diff --check`. Four review passes covered drafting, domain/current-state accuracy, security/integration edge cases and wording/link polish. Follow-up unlazy outcome: 20 met, zero unmet, zero abandoned, all manual planning judgments with section-specific evidence; structural checks do not pretend to prove the implementation. The ledger linter warns appropriately about manual-only gates. Local ledger/logs: `.unlazy/enterprise-followup/`.

Evidence fingerprints:

- `typecheck.log`: SHA-256 `6d501673533e90a1c3dd3e457258c7588b77bb8cb6f2e6015711a38e916fe677`.
- `lint.log`: SHA-256 `c74c048c8e05b280d5459dc9373308c0ff1ad8f7e0236c91844fa8d66a68da1f`.
- `test.log`: SHA-256 `ac39d1a854ae7a215985ea73629d02433f12ad8a622e90ac9f20cc21533e5e74`.


## Broader module audit follow-up — 2026-09-11

Added [Enterprise Module Audit](ENTERPRISE_MODULE_AUDIT.md), linked from Enterprise Evolution §17. It accounts for the measured 19 module directories, separates source-confirmed behavior, local reproduction, investigation and product gaps, and supplies 36 finding entries plus 12 product hypotheses with implementation/release criteria. Findings were checked against shared services/schema where relevant; absence in migrations is explicitly not a live database claim. Parallel reviewers supplied candidate observations but did not complete their artifacts; the lead checked the cited source and wrote the integrated audit locally. No claim of completed independent review is made.

The user clarified during this pass that unlazy applies to implementing agents, not the planning review. The final artifact therefore provides their assignment/proof/verification contract in §8, and makes no self-gate completion claim for this review.

Verification in this pass: `pnpm typecheck && pnpm lint && pnpm test` executed. Typecheck passed (25 cached workspace tasks), lint passed with existing warnings; tests failed in `apps/web/src/server/jobs.test.ts:58`, expecting “no document” but receiving a wrapped failed documents SELECT. Web reported 208 passed / 1 failed; Turbo reported seven successful cached test tasks and one failed task. The earlier products setup timeout did not recur. Root-cause diagnosis of the SQL failure remains required. N36 additionally records 19 module test files not wired into the root test task, so these commands do not constitute full module coverage.

Three synthetic pure-code probes reproduced the manufacturing transfer-value projection, overlapping leave counting and ignored routine-schedule qualifier. No account attack, customer message, production financial effect, full business demo, live browser usability proof, load test or restored backup was performed. This was documentation work; no runtime source, dependency, migration or user README/assets/.gitignore changes were made. Nothing was committed or pushed.
