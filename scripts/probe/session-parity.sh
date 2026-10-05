#!/usr/bin/env bash
# Proves the Go session resolver reaches the same decisions as the TypeScript
# session authority, for the same live cookies.
#
# The TypeScript side is the running legacy app's own /api/org route, which is
# the production authority rather than a reimplementation. The Go side runs
# cmd/sessionprobe through the same cookie-reading path the middleware uses,
# including percent-decoding.
#
# The fixture is a user who belongs to two organizations with deliberately
# different roles, permissions, currency, and module state, plus an unverified
# account that also holds an Owner role. A resolver that ignored the active-org
# cookie, or read the base organization after switching, would pass a
# single-organization case and fail here.
#
# Usage:
#   pnpm migration:session-parity
#
# Seeds and tears down its own fixture. Exits non-zero on any disagreement.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

set -a && [ -f .env ] && . ./.env && set +a

LEGACY_ORIGIN="${LEGACY_WEB_ORIGIN:-http://localhost:3001}"
TIMEOUT="${PROBE_TIMEOUT:-300}"
ORG_A="11111111-0000-4000-8000-0000000000a1"
ORG_B="11111111-0000-4000-8000-0000000000b1"
FOREIGN="99999999-0000-4000-8000-0000000000ff"
MULTI_TOKEN="parity-multi-token-0000000000000001"
UNVERIFIED_TOKEN="parity-unverified-token-000000000001"

OUT_DIR="$(mktemp -d)"
source scripts/probe/fixture-lib.sh
trap 'teardown_fixture; rm -rf "$OUT_DIR"' EXIT

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

echo "==> seeding the multi-organization fixture"
RUN="$(date +%s)$$"
seed_fixture "$RUN" || exit 3
ORG_A="$FIXTURE_ORG_A"
ORG_B="$FIXTURE_ORG_B"
FOREIGN="$(node -e "
  const { createHash } = require('node:crypto');
  const h = createHash('sha256').update('foreign-' + process.argv[1]).digest('hex');
  process.stdout.write(h.slice(0,8) + '-0000-4000-8000-' + h.slice(8,20));
" "$RUN")"

echo "==> minting signed session cookies"
MULTI_COOKIE="$(node scripts/probe/sign-session-cookie.mjs "$FIXTURE_TOKEN")" \
  || { echo "cookie minting failed" >&2; exit 4; }
UNVERIFIED_COOKIE="$(node scripts/probe/sign-session-cookie.mjs "$FIXTURE_UNVERIFIED_TOKEN")"

failures=0

# compare <label> <cookie> <active-org>
compare() {
  local label="$1" cookie="$2" active_org="$3"
  local header="better-auth.session_token=$cookie"
  [[ -n "$active_org" ]] && header="$header; chaste_active_org=$active_org"

  if ! curl -sS --max-time "$TIMEOUT" -H "cookie: $header" \
      -o "$OUT_DIR/ts.json" "$LEGACY_ORIGIN/api/org" 2>/dev/null; then
    echo "  [$label] could not reach the legacy authority at $LEGACY_ORIGIN"
    failures=$((failures+1))
    return
  fi

  if ! PROBE_COOKIE="$cookie" PROBE_ACTIVE_ORG="$active_org" \
      go -C apps/api run ./cmd/sessionprobe > "$OUT_DIR/go.json" 2>"$OUT_DIR/go.err"; then
    echo "  [$label] Go resolver failed: $(head -2 "$OUT_DIR/go.err" | tr '\n' ' ')"
    failures=$((failures+1))
    return
  fi

  if node scripts/probe/compare-session-parity.mjs "$OUT_DIR/ts.json" "$OUT_DIR/go.json" \
      > "$OUT_DIR/out.txt" 2>&1; then
    echo "  [$label] OK  $(sed -n 's/^  active organization: /org=/p' "$OUT_DIR/out.txt")"
  else
    echo "  [$label] FAILED"
    sed 's/^/      /' "$OUT_DIR/out.txt"
    failures=$((failures+1))
  fi
}

echo "multi-organization verified user:"
compare "no cookie (falls back to base)"    "$MULTI_COOKIE" ""
compare "switch to org A"                   "$MULTI_COOKIE" "$ORG_A"
compare "switch to org B"                   "$MULTI_COOKIE" "$ORG_B"
compare "foreign org (must fall back)"      "$MULTI_COOKIE" "$FOREIGN"
compare "org id uppercased (must fall back)" "$MULTI_COOKIE" "$(echo "$ORG_A" | tr 'a-f' 'A-F')"
compare "whitespace cookie (must fall back)" "$MULTI_COOKIE" "   "

echo "unverified mailbox that also holds an Owner role:"
compare "unverified, no cookie"             "$UNVERIFIED_COOKIE" ""
compare "unverified, claims org A"          "$UNVERIFIED_COOKIE" "$ORG_A"

echo
if [[ "$failures" -ne 0 ]]; then
  echo "SESSION PARITY FAILED ($failures case(s))"
  exit 1
fi
echo "session parity OK across 8 cases"