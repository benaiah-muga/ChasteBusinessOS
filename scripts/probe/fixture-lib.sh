#!/usr/bin/env bash
# Seeds a fresh multi-organization session-parity fixture with unique ids and
# prints the values the caller needs. Sourced by the parity gates.
#
# Posted ledger rows are immutable, so ids must be unique per run or the fixture
# would collide with its own history on the second invocation.

# seed_fixture <run-tag>
# Exports: FIXTURE_ORG_A, FIXTURE_ORG_B, FIXTURE_TOKEN, FIXTURE_UNVERIFIED_TOKEN
seed_fixture() {
  local run="$1"
  FIXTURE_ORG_A="$(node -e "
    const { createHash } = require('node:crypto');
    const h = createHash('sha256').update('org-a-' + process.argv[1]).digest('hex');
    process.stdout.write(h.slice(0,8) + '-0000-4000-8000-' + h.slice(8,20));
  " "$run")"
  FIXTURE_ORG_B="$(node -e "
    const { createHash } = require('node:crypto');
    const h = createHash('sha256').update('org-b-' + process.argv[1]).digest('hex');
    process.stdout.write(h.slice(0,8) + '-0000-4000-8000-' + h.slice(8,20));
  " "$run")"
  FIXTURE_ORG_A="${FIXTURE_ORG_A:0:8}-0000-4000-8000-${FIXTURE_ORG_A: -12}"
  FIXTURE_ORG_B="${FIXTURE_ORG_B:0:8}-0000-4000-8000-${FIXTURE_ORG_B: -12}"

  FIXTURE_RUN="$run"
  FIXTURE_TOKEN="parity-multi-token-${run}"
  FIXTURE_UNVERIFIED_TOKEN="parity-unverified-token-${run}"

  psql "${DATABASE_URL}" -q -v ON_ERROR_STOP=1 \
    -v org_a="$FIXTURE_ORG_A" -v org_b="$FIXTURE_ORG_B" -v run="$run" \
    -f scripts/probe/multi-org-fixture.sql >/dev/null \
    || { echo "fixture seeding failed" >&2; return 1; }
}

# Marks the fixture rows for cleanup. Organization rows may already carry posted
# ledger events that cannot be removed, in which case they are simply left
# behind; each run uses fresh ids so that never blocks the next run.
teardown_fixture() {
  [[ "${KEEP_FIXTURE:-0}" == "1" || -z "${FIXTURE_RUN:-}" ]] && return 0
  psql "${DATABASE_URL:-}" -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<SQL || true
DELETE FROM auth_session WHERE token LIKE 'parity-%-${FIXTURE_RUN}';
DELETE FROM auth_user WHERE id LIKE 'parity%${FIXTURE_RUN}';
DELETE FROM users WHERE email LIKE 'parity-%-${FIXTURE_RUN}@%';
DELETE FROM organizations WHERE slug LIKE '%-${FIXTURE_RUN}';
SQL
}