# ADR 0043: Marketing campaigns queue recipient-bound delivery operations

Status: Accepted

Date: 2026-09-14

## Context

`marketing.sendCampaign` previously wrote a recipient log and marked the
campaign sent without creating an external delivery operation. That made the
log look like delivery, allowed missing addresses into the audience, and gave
an unsubscribe made after queueing no protection at dispatch time.

## Decision

Create one durable `marketing_deliveries` row per qualifying customer and bind
it to one organization-scoped email outbox row. The campaign/customer unique
constraint and outbox dedupe key make repeated send attempts idempotent. The
outbox payload carries the customer identity and address snapshot; immediately
before SMTP dispatch, the worker rechecks organization, activation, consent,
and address equality. A changed or withdrawn recipient is failed without a
provider call.

Campaign analytics count only outbox rows with provider-confirmed `sent`
status. Queue time and provider completion time remain separate in the API and
UI, and missing-address/opt-out exclusions are returned to the caller.

## Consequences

- A campaign is durably queued even when SMTP is unavailable, without claiming
  that it was delivered.
- A recipient can be retried independently once provider reconciliation or a
  future retry policy marks its operation eligible again.
- Existing `marketing_sends` rows remain historical legacy records; they are
  not treated as provider-confirmed delivery and are not sent retroactively.
- Explicit campaign lifecycle states, provider delivered/bounced receipts,
  and connector-specific retry/reconciliation remain follow-up work.
