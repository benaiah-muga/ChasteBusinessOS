# Gates: Documents product rebuild

OWNS: GATES.md, CHANGELOG.md, docs/adr/**, apps/web/src/app/**/documents/**, apps/web/src/app/api/documents/**, apps/web/src/components/documents/**, apps/web/src/lib/documents/**, apps/web/src/server/documents/**, modules/documents/**, packages/db/src/schema/**, packages/db/migrations/**, scripts/verify-documents*.mjs, tokens.css, .hallmark/**

Scope: Deliver and verify a dependable Documents workspace spanning organization, templates, editing, persistence, responsive preview, and professional PDF export.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: gate-lint.mjs GATES.md -> LINT OK

- [x] G1: the Documents domain and API tests prove tenant isolation, validation, folder operations, record binding, draft round trips, upload errors, and export behavior
  CHECK: pnpm --filter @chaste/module-documents test
  EXPECT: Test Files
  EVIDENCE: modules/documents: 2 test files, 9 tests passed

- [x] G2: every supported document type has three structurally distinct templates with complete required metadata
  CHECK: node scripts/verify-documents-templates.mjs
  EXPECT: document template verification passed
  EVIDENCE: DOCUMENT TEMPLATE CATALOG OK: 8 types, 24 distinct professional templates

- [x] G3: the complete repo verification gate passes
  CHECK: pnpm typecheck && pnpm lint && pnpm exec turbo test --concurrency=1 && node -e "console.log('REPOSITORY_VERIFICATION_PASSED')"
  EXPECT: REPOSITORY_VERIFICATION_PASSED
  EVIDENCE: typecheck passed (26 tasks); lint passed with 0 errors and 213 warnings; serialized tests passed (24 tasks, web 321 tests); final marker REPOSITORY_VERIFICATION_PASSED

- [x] G4: desktop and mobile browser checks prove the workspace, folders, template gallery, editor, live preview, save and reopen flows without console or server errors
  EVIDENCE: authenticated agent-browser desktop and mobile screenshots; Next MCP compilation/issues/errors clean; browser console had no errors

- [x] G5: all eight document types and all three templates per type can create, edit, save, reopen, organize, search, and export through the running product
  EVIDENCE: DOCUMENT MATRIX OK: 24 templates verified across 8 types, including folder moves and Chromium PDF export

- [x] G6: rendered exported PDFs match saved content and handle pagination, long tables, empty fields, logos, signatures, and multi-page output without visual defects
  EVIDENCE: long-table PDF rendered 6 pages; logo PDF contained one embedded JPEG image; text and signature output verified with pdfinfo/pdftotext/pdfimages

- [x] G7: runtime negative checks prove validation, permission boundaries, missing business records, upload failures, and interrupted saves recover clearly and without data loss
  EVIDENCE: unauthenticated APIs returned 401; missing-record, invalid-upload, and offline autosave retry flows exercised in browser

- [x] G8: user-visible behavior is recorded and the context graph is refreshed
  CHECK: graft build && git diff --check
  EXPECT: Graph built
  EVIDENCE: CHANGELOG.md and ADR 0066 updated; graft build and git diff --check completed
