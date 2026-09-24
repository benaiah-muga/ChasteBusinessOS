# Gates: Messages UX and capabilities

OWNS: GATES-MESSAGES.md, CHANGELOG.md, docs/adr/0068-messaging*, apps/web/src/app/(app)/messages/**, apps/web/src/app/api/conversations/**, apps/web/src/app/api/messages/**, apps/web/src/app/api/message-attachments/**, modules/messaging/**, packages/db/src/schema/**, packages/db/drizzle/**

Scope: Deliver the requested Messages UI, durable conversation features, access boundaries, and runtime behavior.

- [x] G1: conversation browsing, mobile navigation, loading, empty states, composer drafts, and grouped messages are usable
  CHECK: pnpm --filter web typecheck && node -e "console.log('MESSAGES_UI_TYPECHECK_PASSED')"
  EXPECT: MESSAGES_UI_TYPECHECK_PASSED
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=4e5aebc4b370/36 entries; EXPECT=matched; output-sha256=3d0d69f524301427cea341e6750378272cca025aaa3df40246fdd4fa6c70bbab; output-bytes=45

- [x] G2: read receipts, message search and pagination, file attachments, reactions, replies, pins, presence, and member search are backed by scoped API operations and persisted schema
  CHECK: pnpm --filter @chaste/module-messaging test && node -e "console.log('MESSAGES_INTEGRATION_TESTS_PASSED')"
  EXPECT: MESSAGES_INTEGRATION_TESTS_PASSED
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=4e5aebc4b370/36 entries; EXPECT=matched; output-sha256=8cb8954525bfe9a38503408061183d4e3d9318a7955bb3be5bfcf4d86061e93e; output-bytes=27819

- [x] G3: the full application passes the repository verification gate
  CHECK: pnpm typecheck && pnpm lint && pnpm exec turbo test --concurrency=1 && node -e "console.log('MESSAGES_REPOSITORY_VERIFICATION_PASSED')"
  EXPECT: MESSAGES_REPOSITORY_VERIFICATION_PASSED
  EVIDENCE: typecheck passed (26 tasks); lint passed with 0 errors and 213 warnings; serialized tests passed (24 tasks, messaging 8 tests, web 321 tests); final marker MESSAGES_REPOSITORY_VERIFICATION_PASSED

- [x] G4: authenticated desktop and mobile Messages flows work in the running app without browser or Next runtime errors
  EVIDENCE: Next 16.3.2 Turbopack `get_compilation_issues` returned `[]`, `get_errors` returned no errors; `/messages` returned 200 in 9.4s cold; browser verified empty state, multi-character channel rename focus, emoji insertion at caret, attachment icon and send button in one composer container, and mobile Back to conversations; temporary verification channel was deleted

- [x] G5: user-facing behavior is recorded and generated files are clean
  CHECK: graft build && git diff --check && node -e "console.log('MESSAGES_GRAPH_AND_DIFF_CLEAN')"
  EXPECT: MESSAGES_GRAPH_AND_DIFF_CLEAN
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=4e5aebc4b370/36 entries; EXPECT=matched; output-sha256=59dbfcac7dde288e113abdb535246d62ad2ad9ecbe7c30dd3df55ce84f9d89c9; output-bytes=35987
