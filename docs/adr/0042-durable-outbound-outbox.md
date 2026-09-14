# ADR 0042: Durable outbound notification outbox

Status: Accepted

Date: 2026-09-14

## Context

Approval and support escalation notifications previously called webhook and
SMTP providers directly from the application path. A timeout or process crash
could leave the provider outcome unknown, while retrying the request could
duplicate a notification. The B03 contract requires external intent to be
committed before dispatch and requires uncertainty to remain visible.

## Decision

Persist notification delivery intent in `outbox_messages` before provider IO.
Approval requests and support escalations enqueue webhook and configured SMTP
messages through the same database handle used by the governed approval path.
The worker dispatches the outbox after commit.

Every row has an organization-scoped dedupe key and a stable provider
operation ID. Webhooks receive both as idempotency metadata; SMTP messages use
the operation ID as their `Message-ID`. A successful response is `sent`, a
known client rejection or missing configuration is `failed`, rate limiting is
bounded and retryable, and transport errors, 5xx responses, lease expiry, or
lost acknowledgements become `unknown`. Unknown rows are never automatically
resent; `reconcileOutboxMessage` is the explicit operator boundary.

The outbox uses fenced leases, but expiry is conservative: an expired
processing row becomes `unknown` rather than being redelivered. This prevents
a provider without enforceable idempotency from receiving a second request
after a worker may already have sent the first one.

## Consequences

- Committed approval/support events no longer depend on provider availability.
- Provider uncertainty is durable and cannot be mistaken for “nothing sent.”
- A provider outage requires explicit reconciliation or a deliberate retry
  policy, which is safer than automatic duplicate delivery.
- Customer invoice mail and future payment/connector effects still need their
  own recipient-bound outbox contracts and provider-specific reconciliation.
