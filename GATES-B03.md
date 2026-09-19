# Gates: B03 - worker-kill fixture and external-effect reconciliation proof

OWNS: apps/web/src/server/worker-kill.test.ts, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: a worker dies mid-flight holding the lease, and the surviving system converges honestly. Three kill windows are pinned by a live fixture: killed after the effect and receipt (replacement replays - exactly-once effects, late ack fenced), killed mid-execution before the effect (at-least-once redelivery, revived corpse's ack still fenced), and an external delivery whose acknowledgement died in transit (row converges to unknown, automatic retry never re-fires, reconciliation settles it from the provider receipt exactly once).

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-B03.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] B03-G1: killed after the effect and receipt - the replacement worker replays the stored receipt (one effect, one audit row, attempts advance), the job completes done, and the revived worker's acknowledgement is fenced
  CHECK: pnpm --filter web exec vitest run src/server/worker-kill.test.ts
  EXPECT: /killed after the effect and receipt/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=05fdb9830dbb8089bcadf87ab1080be44ba906fb1a448f18457acd57b7a4b81d; output-bytes=41618

- [x] B03-G2: killed mid-execution before the effect - the replacement runs fresh and completes, and when the corpse un-freezes its duplicate effect commits but its acknowledgement stays fenced: the queue promises at-least-once plus fencing, not mid-flight exactly-once
  CHECK: pnpm --filter web exec vitest run src/server/worker-kill.test.ts
  EXPECT: /killed mid-execution, before the effect/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=83e8fc53a0d7e680d9bc396613cd2a179da882146acffa9fe3c6da19111e2304; output-bytes=41618

- [x] B03-G3: external webhook delivered but the acknowledgement died in transit - the provider sees exactly one call, the row converges to unknown on the next worker pass, no automatic re-fire happens, reconciliation settles it to sent exactly once, and a duplicate enqueue collapses onto the settled row
  CHECK: pnpm --filter web exec vitest run src/server/worker-kill.test.ts
  EXPECT: /external delivery died after the provider received it/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=b5da8bd1eb3fd26c78f7a4d381c462be56ad83c60e7a86be5f1567f431b11db7; output-bytes=41424

- [x] B03-G4: the existing queue and outbox suites (lease/fencing predicates, dedupe, recipient eligibility) stay green alongside the kill fixture
  CHECK: pnpm --filter web exec vitest run src/server/jobs.test.ts src/server/outbox.test.ts && echo B03-REGRESSION-OK
  EXPECT: B03-REGRESSION-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=cb90b7500713b0ed8921add8874f16526611dab96a79fa81d40997575d873fb0; output-bytes=39919

- [x] B03-G5: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-b03-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-b03-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] B03-G6: the W0 evidence register records the worker-kill delivery and the CHANGELOG records the behavior documentation
  CHECK: grep -q "worker-kill" docs/W0_EVIDENCE_REGISTER.md && grep -qi "worker-kill" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
