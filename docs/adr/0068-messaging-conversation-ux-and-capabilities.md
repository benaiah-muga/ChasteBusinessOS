# ADR 0068: Searchable conversations and collaboration state

## Status

Accepted

## Context

The Messages workspace listed a small set of conversations and loaded at most 200 messages. Members could not find older posts, tell which channels had unread activity, or share files and reactions in the conversation itself. Opening a thread on a phone also hid the list without a clear list-level search or filter. Draft text disappeared when a person changed channels.

The application routes human actions through the same capability pipeline used by the AI workmate. Message visibility must continue to follow conversation membership, while new tenant data must satisfy the database RLS conformance sweep.

## Decision

- Keep conversation-name and latest-preview filtering in the browser. Add a separate server history search, scoped to the current organization and the caller's conversation memberships. Load recent messages in pages and use a message cursor to request earlier pages. Searching an older result opens a context window around that message.
- Store each member's read position on `conversation_members`. Count unread messages after that position, excluding the member's own messages. Return conversation member read positions with a thread so the interface can label messages seen by colleagues.
- Store message replies, pins, reactions, attachments, and short-lived presence in dedicated database structures. Attachment bytes stay in PostgreSQL with a 5 MB per-file limit because this repository has no configured object storage service. Downloads require an active conversation membership and are served as attachments with `nosniff`.
- Register durable writes as messaging capabilities. Attachment transfer is a secret-class capability so file contents are redacted from the action ledger. A send links pending uploads to the new message within the same transaction. Tenant-owned tables carry `org_id` and use the standard RLS tenant policy.
- Use five-second polling for thread and presence updates. Typing signals expire after eight seconds and presence becomes offline after 45 seconds. This works with the existing request infrastructure and does not require a separate realtime service.
- Save draft text in local storage under the current user and conversation. Keep files in memory until send; a successfully uploaded file can be removed from the composer before it is posted.
- Render date dividers, adjacent sender groups, reactions, reply links, pins, attachments, and read status from the persisted message data. Keep the mobile conversation list and open thread as distinct views with a visible back action.

## Consequences

Members can locate older messages and collaborate without leaving the thread, and the server checks membership for search, reads, writes, presence, and downloads. The first rollout stores up to five-megabyte attachment blobs in the primary database, so larger files or high attachment volume will require an object storage adapter. Updates appear within the polling interval and may take longer when the browser tab is in the background.
