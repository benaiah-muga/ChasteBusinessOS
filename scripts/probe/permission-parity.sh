#!/usr/bin/env bash
# Proves Go's RBAC permission decision matches what the legacy app actually
# allows for the same session.
#
# /api/crm is gated by the crm.read permission. The fixture user holds crm.read
# in org B only, so the legacy route must refuse in org A and allow in org B. If
# Go's guard disagreed on either, Go could not own authorization.
#
# This reuses the same fixture as session-parity, so it seeds and tears down its
# own rows and can be run independently.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

set -a && [ -f .env ] && . ./.env && set +a

LEGACY_ORIGIN="${LEGACY_WEB_ORIGIN:-http://localhost:3001}"
TIMEOUT="${PROBE_TIMEOUT:-300}"
OUT_DIR="$(mktemp -d)"
source scripts/probe/fixture-lib.sh
trap 'teardown_fixture; rm -rf "$OUT_DIR"' EXIT

RUN="$(date +%s)$$"
seed_fixture "$RUN" || exit 3
ORG_A="$FIXTURE_ORG_A"
ORG_B="$FIXTURE_ORG_B"

COOKIE="$(node scripts/probe/sign-session-cookie.mjs "$FIXTURE_TOKEN")"
failures=0

# check <label> <active-org> <permission> <endpoint>
check() {
  local label="$1" active_org="$2" permission="$3" endpoint="$4"
  local status
  status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    -H "cookie: better-auth.session_token=$COOKIE; chaste_active_org=$active_org" \
    "$LEGACY_ORIGIN$endpoint" 2>/dev/null)"

  if [[ -z "$status" || "$status" == "000" ]]; then
    echo "  [$label] legacy unreachable"
    failures=$((failures+1))
    return
  fi

  PROBE_COOKIE="$COOKIE" PROBE_ACTIVE_ORG="$active_org" PROBE_PERMISSIONS="$permission" \
    go -C apps/api run ./cmd/sessionprobe > "$OUT_DIR/go.json" 2>/dev/null \
    || { echo "  [$label] Go resolver failed"; failures=$((failures+1)); return; }

  local go_allows
  go_allows="$(node -e "
    const out = JSON.parse(require('node:fs').readFileSync('$OUT_DIR/go.json', 'utf8'));
    process.stdout.write(String(Boolean((out.permissionDecisions || {})['$permission'])));
  ")"

  # 401 means the legacy app saw no session at all, which is a different failure
  # from a permission refusal and would make the comparison meaningless.
  if [[ "$status" == "401" ]]; then
    echo "  [$label] INVALID: legacy reported no session, so the comparison proves nothing"
    failures=$((failures+1))
    return
  fi

  # The legacy app answers a capability-backed permission refusal with 422 and a
  # "forbidden" body, not 403, so status alone must not be read as "denied".
  local body_file="$OUT_DIR/body.json"
  curl -sS --max-time "$TIMEOUT" -o "$body_file" \
    -H "cookie: better-auth.session_token=$COOKIE; chaste_active_org=$active_org" \
    "$LEGACY_ORIGIN$endpoint" 2>/dev/null || true
  local body
  body="$(tr -d '\n' < "$body_file" 2>/dev/null)"

  local legacy_allows="true"
  if [[ "$status" != "200" ]]; then
    legacy_allows="false"
  fi
  if [[ "$body" == *"forbidden"* ]]; then
    legacy_allows="false"
  elif [[ "$status" != "200" ]]; then
    # A non-200 that is not an explicit refusal means the route failed for an
    # unrelated reason, so this case proves nothing.
    echo "  [$label] INVALID: HTTP $status body=$body"
    failures=$((failures+1))
    return
  fi

  if [[ "$go_allows" == "$legacy_allows" ]]; then
    echo "  [$label] OK  legacy HTTP $status, Go allows=$go_allows"
  else
    echo "  [$label] FAILED  legacy HTTP $status (allows=$legacy_allows) vs Go allows=$go_allows"
    failures=$((failures+1))
  fi
}

# crm.read is granted in org B only, so the same session must invert between
# the two organizations. This is the discriminating case.
check "org A lacks crm.read, must be refused" "$ORG_A" "crm.read" "/api/crm?tasks=1"
check "org B holds crm.read, must be allowed" "$ORG_B" "crm.read" "/api/crm?tasks=1"

# Neither organization grants iam.read, so both runtimes must refuse. This
# catches a resolver that grants permissions it was never given.
check "neither org grants iam.read" "$ORG_A" "iam.read" "/api/team"

echo
if [[ "$failures" -ne 0 ]]; then
  echo "PERMISSION PARITY FAILED ($failures case(s))"
  exit 1
fi
echo "permission parity OK"