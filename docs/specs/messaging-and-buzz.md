# Spec: Internal messaging & Buzz bridge

**Status:** Implemented (v1) — messaging core + optional Buzz webhook bridge
**Related:** [scheduling-and-comms.md](./scheduling-and-comms.md), [agent-harness.md](./agent-harness.md), [ARCHITECTURE.md](../../ARCHITECTURE.md)

## 1. Goal

Give members of an organization a first-class way to message each other —
1:1 direct messages and group conversations — with the same command bus,
permissions, audit, and outbox guarantees as every other capability. Group
creation is a distinct, grantable permission ("who creates a group, maybe one
who has that permission"). Architecturally this is interchangeable with the
AI agent surface: agents join threads and post through the same commands, so
feature-development collaboration can flow through the platform.

A **Buzz bridge** (optional, explicitly env-gated) lets the platform mirror
selected events into a configured Buzz deployment and accept signed inbound
messages/triggers, so humans and agents can also coordinate through Buzz.

## 2. Domain model

```
Organization
  └── Thread (direct | group)
        ├── ThreadMember (role: member | admin)
        ├── Message (kind: text | system; parent_id for replies; soft-delete)
        └── ReadCursor (per member: last_read_message_id)
```

### 2.1 Thread
| Field | Notes |
|---|---|
| `type` | `direct` (implicit 2 members) or `group` |
| `name` | Required for groups; null for direct |
| `createdBy` | Who opened it (becomes admin) |
| `isArchived` | Soft hide from list |

### 2.2 Message
`kind text|system`, `body`, `parentId?`, `editedAt?`, `deletedAt?` (soft delete;
keeps threads auditable/exportable). Senders are users *or* agents posting via
the same command.

## 3. Permissions

| Permission | Ability |
|---|---|
| `messaging.thread.read` | List threads, read messages you belong to |
| `messaging.thread.write` | Send messages / create a direct thread / leave |
| `messaging.group.create` | Create group conversations |
| `messaging.group.manage` | Add/remove members, rename, archive a group |

Security note: direct threads can be created by any user with
`messaging.thread.write`; *groups* require the separate `messaging.group.create`
permission. `messaging.group.manage` is admin-only (operators do **not** get it
by default from the seed's `.create/.read/.write` auto-grant). Agents always act
with the calling user's permissions (AI/manual parity).

## 4. Commands & queries

| Name | Permissions | Notes |
|---|---|---|
| `messaging.thread.create` | `thread.write` (direct) / `group.create` (group) | Also adds members provided by id |
| `messaging.thread.send` | `thread.write` | Enforces membership; notifies other members |
| `messaging.thread.add_member` | `group.manage` | Group only; direct threads are 2-party |
| `messaging.thread.remove_member` | `group.manage` | |
| `messaging.thread.leave` | `thread.write` | Self-service |
| `messaging.thread.rename` | `group.manage` | |
| `messaging.thread.archive` | `group.manage` (group) / self (direct) | |
| `messaging.thread.mark_read` | `thread.read` | Cursor-based |
| `messaging.thread.list` (q) | `thread.read` | Own threads, last preview + unread count |
| `messaging.thread.get` (q) | `thread.read` | Thread + members + paginated messages |
| `messaging.unread.count` (q) | `thread.read` | Bell badge |

**Guarantees:** every handler re-checks org scoping and membership; sends write
an audit entry via the command bus and an outbox event `messaging.message.sent`;
creates an in-app notification (`kind: "message"`, href `/messaging?thread=<id>`) for
the other members.

## 5. Buzz bridge (optional)

Enabled only when `CHASTE_BUZZ_WEBHOOK_SECRET` (and optionally
`CHASTE_BUZZ_OUTBOUND_WEBHOOK_URL`) are configured. Out-of-the-box the bridge is a
no-op/, so a stock install has zero hidden external calls.

- **Outbound mirror:** a worker outbox handler listens for
  `messaging.message.sent` (and future agent events) and POSTs a signed payload
  (`X-Chaste-Signature: HMAC-SHA256`) to the configured Buzz workflow webhook. Failures
  are non-fatal (logged, flagged) — the platform's own record remains the source of truth.
  Messages that themselves arrived via Buzz (body prefixed `[via Buzz]`) are not mirrored,
  so the channel cannot loop back on itself. System messages are never mirrored.
- **Inbound triggers:** `POST /api/v1/buzz/webhook` verifies the HMAC, resolves the
  referenced internal thread (id carried in the echoed payload), and posts the message
  into that thread via `messaging.thread.send` as the thread creator. This lets a Buzz
  channel message file an internal follow-up (agent collaboration).

### 5.1 Signature contract

Both sides sign/verify the **canonical JSON body** — `JSON.stringify(<payload object>)`
— with `HMAC-SHA256(secret, body)`, hex-encoded, sent in the `X-Chaste-Signature`
header. The payload object is the parsed request body (field order as produced by
`JSON.stringify`). Buzz companions must sign `JSON.stringify(body)` with the shared
secret (`CHASTE_BUZZ_WEBHOOK_SECRET`). Unconfigured bridge → `503 BUZZ_NOT_CONFIGURED`;
bad/missing signature → `401 BUZZ_SIGNATURE_INVALID`.

Known limitation (v1): inbound messages are attributed to the thread creator and
prefixed `[via Buzz]`; full per-agent identity mapping and bidirectional event parity is
roadmap. This keeps the bridge honest and audited without inventing privileged paths.

## 6. Non-goals (v1)

- Attachments/files, reactions, mentions/typing presence, threads-within-threads, encryption-at-rest beyond DB.
- Full Buzz bidirectional identity parity.
- Real-time websockets (MVP polls/refetches like notifications).

## 7. UI

`/messaging` (workspace group): thread list (title, preview, unread badge) +
thread view (message bubbles, composer) + "New message" to start a DM or group.
A notification bell badge may surface `messaging.unread.count`.