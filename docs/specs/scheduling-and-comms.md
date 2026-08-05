# Spec: Scheduling, calendar, reminders, notifications, email

**Status:** Draft product/engineering spec  
**Related:** [agent-harness.md](./agent-harness.md), [ARCHITECTURE.md](../../ARCHITECTURE.md), [product-architecture-next.md](../product-architecture-next.md)

## 1. Goal

Provide a **brilliant, efficient** time-and-attention layer so the harness can:

- Schedule work and meetings in natural language
- Maintain calendars humans and agents share
- Set reminders and **natural-language follow-ups**
- Deliver in-app notifications with optional **sound / ring**
- Send email (invites, digests, operational alerts)

All of this uses the same command bus, permissions, audit, and outbox patterns as the rest of the OS -- not a side channel the agent invents.

## 2. Domain model

```
Organization
  └── Calendar (org | user | branch-scoped)
        └── CalendarEvent
  └── Reminder
  └── FollowUp          # re-enter agent harness at time T with goal text
  └── Notification      # in-app inbox item
  └── EmailOutbox       # provider delivery record
```

### 2.1 CalendarEvent

| Field | Notes |
|---|---|
| `id`, `organizationId` | Tenancy |
| `calendarId` | Owner calendar |
| `title`, `description` | |
| `startsAt`, `endsAt`, `timezone` | Stored UTC + zone |
| `branchId?` | Optional branch scope |
| `attendees[]` | Users / emails |
| `linkedResources[]` | Optional SoR pointers (invoice, customer) |
| `createdBy` | user or `agent:<session>` with principal |

### 2.2 Reminder

| Field | Notes |
|---|---|
| `fireAt` | Instant |
| `channel` | `in_app` \| `email` \| `both` |
| `payload` | Short message + deep link |
| `status` | scheduled / fired / cancelled / failed |

### 2.3 FollowUp (NL continuation)

Durable job that **re-enters the agent harness**:

```ts
type FollowUp = {
  id: string;
  organizationId: string;
  userId: string;
  fireAt: string;
  goal: string;                 // natural language continuation
  sessionId?: string;           // resume or new
  branchId?: string;
  autonomyOverride?: …;         // rarely; default org policy
  status: "scheduled" | "running" | "done" | "cancelled" | "failed";
};
```

On fire: worker creates a **system turn** ("Follow-up: review overdue invoices") → orchestrator → may notify user with plan/confirm.

## 3. Natural language mapping

Examples:

| Utterance | Structured result |
|---|---|
| "Remind me Friday 4pm to review AR" | Reminder + optional FollowUp with goal |
| "Block Tuesday 10–11 for stock count, Nairobi branch" | CalendarEvent + branchId |
| "Email me a daily digest of failed jobs" | Notification preference + scheduled email job |
| "Follow up with Acme next week if no payment" | FollowUp + entity_link customer |

Parser strategy:

1. Deterministic datetime parsing where possible (chrono-like rules + org timezone).
2. LLM fill only for ambiguous relative phrases; always show confirm for writes under default autonomy.
3. Never schedule irreversible financial posts from a reminder alone without policy.

## 4. Notifications & sound/ring

### 4.1 In-app

- `notifications` table + query `core.notification.list`
- Realtime: SSE/WebSocket later; MVP poll or focus refetch
- Client (`apps/web`) respects `user_preferences.notifications`:
  - `pushEnabled`, per-category mute, quiet hours
  - `soundEnabled` / `ringEnabled` -- play sound or use Notification API + optional vibrate where platform allows
- Permission: browser notification permission is user-granted; agent cannot force OS-level ring without client policy

### 4.2 Categories

`ops`, `approval`, `reminder`, `security`, `marketing_none` (product never uses marketing spam by default), `system`.

Security category ignores some mute settings except hard quiet-hours break-glass rules documented in security policy.

## 5. Email

| Concern | Approach |
|---|---|
| Provider | Pluggable adapter (`EmailAdapter`): `resend` (REST, N/A SDK) and `smtp` (nodemailer); `console` fallback. Selected by config, never by the caller. |
| Selection | `createEmailAdapter()` precedence: `CHASTE_RESEND_API_KEY` → `CHASTE_SMTP_HOST` → console. |
| Templates | Versioned templates (invite, reminder, digest, gap_ticket) via `renderEmailTemplate` (missing vars throw). |
| Auth | No raw secrets in modules; SMTP creds + Resend key come from env/config/vault. |
| Idempotency | `email_outbox` with `provider`/`providerMessageId`; `core.email.retry` re-queues failed for the same org only. |
| Bounce/complaint | Worker handles webhooks when available. |
| AI | May draft body; send is a command with autonomy gate (`guarded_auto`). |

Commands: `core.email.send`, `core.email.enqueue_template`, `core.email.retry`.
Queries: `core.email.outbox.list`, `core.email.provider.status` (reports active provider + from-address only, never secrets).

### 5.1 Config reference

| Env | Purpose |
|---|---|
| `CHASTE_RESEND_API_KEY` | Enables the Resend adapter. |
| `CHASTE_RESEND_FROM` | From-address for Resend (default `Chaste BusinessOS <onboarding@resend.dev>`). |
| `CHASTE_SMTP_HOST` | Enables the SMTP adapter. |
| `CHASTE_SMTP_PORT` | Default `587`. |
| `CHASTE_SMTP_SECURE` | `"true"` for implicit TLS (465), default `"false"` (STARTTLS). |
| `CHASTE_SMTP_USER` / `CHASTE_SMTP_PASS` | SMTP auth (anonymous if unset). |
| `CHASTE_SMTP_FROM` | From-address for SMTP (default `Chaste BusinessOS <no-reply@chaste.local>`). |
| `CHASTE_EMAIL_FROM` | Shared override used when the provider-specific `FROM` is unset. |

## 6. Worker architecture

```
command commit → outbox row
       │
       ▼
apps/worker
  - deliver notification
  - send email
  - schedule BullMQ/Redis or PG job for fireAt
  - on fire: reminder notify and/or follow-up harness entry
  - memory consolidation (separate cadence)
```

Prefer **PG-backed jobs** for simplicity in early alpha if Redis is optional; document Redis path for scale.

## 7. Permissions

| Permission | Ability |
|---|---|
| `core.calendar.read` | See calendars in scope |
| `core.calendar.write` | Create/update events |
| `core.reminder.write` | Set reminders for self; admin for others |
| `core.followup.write` | Schedule agent follow-ups |
| `core.notification.read` | Inbox |
| `core.email.send` | Outbound email (often admin / guarded) |

AI uses the **acting user's** permissions. Scheduling email to external domains may require higher gate.

## 8. UX

- Global chrome: notification bell + unread count; optional sound toggle
- Calendar views under Platform or dedicated module world
- Chat: `resource_link` to event; confirm cards for proposed times
- Branch switcher does not hide org-level events unless filtered

## 9. Efficiency notes

- Batch digest emails (already have `notificationDigest` in settings schemas)
- Dedupe notifications for the same resource+reason within a window
- Follow-ups share session memory passively -- do not dump full history into email
- Use cheap local model for "parse time phrase" only when rules fail; heavy model for multi-constraint scheduling

## 10. Phasing

| Phase | Deliverable |
|---|---|
| C0 | Notification prefs in settings (partially exists) |
| C1 | `notifications` table + bell UI + optional sound |
| C2 | Reminders + PG/Redis scheduled jobs |
| C3 | Calendar events CRUD + simple week UI |
| C4 | NL schedule/remind via orchestrator tools |
| C5 | FollowUp → harness re-entry |
| C6 | Email adapter + invite/reminder templates |
| C7 | Digests, quiet hours, branch-aware calendars |

## 11. Non-goals (near term)

- Full Google/Microsoft calendar sync (connectors later)
- Telephony / PSTN ringing
- Marketing automation suites
- Guaranteeing sound on every locked mobile OS without native apps
