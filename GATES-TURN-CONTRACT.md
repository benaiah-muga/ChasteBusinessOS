# Gates: deterministic Workmate turn contract

OWNS: apps/api/internal/agentturn/*.go, apps/api/internal/httpapi/chat_session.go, apps/api/internal/httpapi/chat_loop.go, apps/api/internal/httpapi/chat_session_test.go, apps/api/internal/httpapi/chat_loop_test.go, apps/web-vite/src/chat-store.ts, apps/web-vite/src/chat-store.test.ts, docs/adr/0100-deterministic-workmate-turn-contract.md, CHANGELOG.md, ROADMAP.md

Scope: take the four jobs that the Salesforce Agentforce deep dive shows must not
live in a single prompt (rule enforcement, identity lookup, context selection,
authority) and enforce the enforceable ones in code around the Workmate model
call, instead of adding more sentences to the prompt.

- [x] T1: the turn facts are compiled from live state before the model call and an unavailable read is never rendered as zero
  CHECK: cd apps/api && go test ./internal/agentturn -run 'TestCompileFacts|TestRenderFacts' -count=1 -v
  EXPECT: /--- PASS: TestCompileFacts[\s\S]*--- PASS: TestRenderFacts/
  EVIDENCE: Both tests and all sub-tests passed, including "a failed read is unknown, never zero", "malformed payload is unknown", "caps the rows but not the count", and "summary is the durable digest".

- [x] T2: post-reasoning enforcement removes dash characters, surfaces every pending approval the model omitted, and acknowledges a failed material action exactly once
  CHECK: cd apps/api && go test ./internal/agentturn -run 'TestEnforce|TestSanitize' -count=1 -v
  EXPECT: /--- PASS: TestEnforce[\s\S]*--- PASS: TestSanitize/
  EVIDENCE: Ten sanitize cases plus idempotency and dash-free assertions passed, and nine enforcement cases passed: omitted gate, honest gate, several gates deduplicated, failed material action, honest failure, failed read ignored, empty answer, idempotent retry, and dash plus obligation together.

- [x] T3: a chat turn sends the facts to the model, streams dash-free text, and persists plus returns the enforced reply
  CHECK: cd apps/api && go test ./internal/httpapi -run 'TestChatSessionHandlerTurnContract' -count=1 -v
  EXPECT: /--- PASS: TestChatSessionHandlerTurnContract/
  EVIDENCE: The handler test passed against the Go chat route: the system prompt carried <turn_facts> with pendingApprovals: 1 and the approval row, every streamed delta and the final reply were dash free, the reply carried the pending-approval notice with approval id appr-1, the stored assistant event matched the returned reply with corrected=2, and the user event stored the facts digest with pendingApprovals 1.

- [x] T4: the client adopts the server's final reply so a corrected or appended result is what the person sees
  CHECK: cd apps/web-vite && pnpm exec vitest run src/chat-store.test.ts -t 'authoritative'
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: The chat store suite passed 18 tests including "adopts the server's authoritative final reply when it corrects the stream"; the full Vite suite later ran 120 files and 2312 tests green.

- [x] T5: rules that code now guarantees are removed from the prompt rather than duplicated
  CHECK: cd apps/api && go test ./internal/httpapi -run 'TestChatSystemPromptDropsEnforcedRules' -count=1 -v
  EXPECT: /--- PASS: TestChatSystemPromptDropsEnforcedRules/
  EVIDENCE: The test passed: the approvals-first, notifications, and signals-are-not-approvals rules are gone, the facts and pendingApproval guidance remain, the writing-style dash rule is retained, and the rule bullet count is 18 (was 19).

- [x] T6: the TypeScript workspace typechecks, lints, and tests clean
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo WORKSPACE_OK
  EXPECT: WORKSPACE_OK
  EVIDENCE: pnpm typecheck reported 3 successful tasks; pnpm lint reported 0 errors and 143 pre-existing warnings; pnpm test exited 0 with Tasks 3 successful, 3 total in 8m56s.

- [x] T7: the Go workspace tests and vet pass
  CHECK: GOCACHE=/tmp/chaste-go-cache GOFLAGS=-p=1 pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api/
  EVIDENCE: With DATABASE_URL sourced from .env, go test ./... reported ok for every package (agentturn cached, capability 297s, httpapi 87s, ledger 118s, jobs 25s, signals, policy, session, authn, crm, dashboard, dbx, metrics, outbox, and the cmd binaries) and go vet ./... was clean.

- [ ] T8 (open): the Workmate route loads with no new console or request errors
  CHECK: focused browser pass on the Workmate route against the built app
  EXPECT: BROWSER CHECK PASS
  EVIDENCE: NOT RUN. No in-app browser tool is available in this session, so the runtime interaction gate stays open. The changed client path is exercised in jsdom by src/chat-store.test.ts.
