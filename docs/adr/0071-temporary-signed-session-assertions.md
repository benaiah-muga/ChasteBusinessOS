# ADR 0071: Temporary signed session assertions for Go reads

Date: 2026-09-27
Status: accepted for migration reads

## Context

The current session resolver depends on the existing auth adapter, request
headers, and cookies. Phase 1 needs an authenticated, read-only Go request
before session resolution has moved. Forwarding browser cookies to a second
runtime would duplicate parsing and permission logic, while passing unsigned
user or organization headers would let a caller choose its tenant.

## Decision

- The current session resolver remains the identity authority during this
  phase. A legacy API handler signs claims only after it has resolved a
  verified session, active organization, and `iam.admin` permission.
- The internal Go policy-read endpoint accepts a short-lived HMAC-SHA256
  assertion with a path-specific audience, user id, organization id,
  `canEdit`, issue time, and expiry. The assertion expires after 30 seconds.
- Both runtimes require the server-only `GO_INTERNAL_AUTH_SECRET`, with at
  least 32 bytes of entropy. The browser never receives the secret or the
  assertion. Go rejects invalid, expired, overlong, or wrong-audience tokens.
- Go uses the signed organization id only inside a transaction that sets
  `app.org_id` locally before its policy query. The endpoint is read-only.
- The `/api/policy` adapter keeps the legacy response by default. Setting
  `GO_POLICY_READ=1` makes its GET return the validated Go response after the
  same session and permission checks. Deployments must run Go before enabling
  the flag; a failed Go read returns 503 rather than stale fallback data.
- Shadow mode compares Go's response with the existing database read, logs
  only match or failure state, and returns the legacy response to the caller.
  Shadow mode runs only in development when `GO_POLICY_SHADOW=1`. It accepts
  only loopback HTTP or HTTPS and has a one-second timeout, so it cannot add
  production latency or send its bearer assertion over cleartext to a remote
  service. The Go response carries `Cache-Control: no-store`.

## Consequences

This bridge proves a controlled session-to-Go read while preserving the
current API response by default and the single-writer rule. Go ownership for
the policy GET remains an explicit rollout choice until every deployment has
the Go service. It is not the final authentication protocol and must be
removed after Go validates existing Better Auth sessions and compatibility
tests pass.
