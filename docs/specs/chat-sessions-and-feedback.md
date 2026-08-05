# Spec: Chat sessions, history, feedback

**Status:** Draft  
**Related:** [ui-correctness-and-safety.md](./ui-correctness-and-safety.md), [memory-system.md](./memory-system.md)

## 1. Sessions

| Field | Purpose |
|---|---|
| `id` | UUID session key |
| `organizationId` / `userId` | Isolation |
| `title` | Display in history (auto from first user message) |
| `updatedAt` | Sort history |
| `activeBranchId?` | Optional branch context for the conversation |
| `pending` | Confirm gate state |
| messages | Ordered `ChatMessage` rows |

## 2. API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/ai/chat` | Continue or create; pass `sessionId` to resume |
| GET | `/api/v1/ai/sessions` | List current user’s sessions (title, updatedAt, preview) |
| GET | `/api/v1/ai/sessions/:id` | Load full transcript (owner only) |
| POST | `/api/v1/ai/sessions` | Explicit new empty session |
| POST | `/api/v1/ai/feedback` | Like/dislike a message |

## 3. Chat top bar (web)

```
[ New chat ]  [ History ▾ ]  · title ·  [ branch badge ]
```

- **New chat** — new `sessionId`, empty log.  
- **History** — dropdown/list of sessions; select loads transcript and sets `sessionId`.  
- Continue is automatic when `sessionId` is sent on each turn.

## 4. Feedback

- Thumbs up / down on **assistant** messages.  
- Optional short comment on down.  
- Stored: `sessionId`, `messageId`, `rating`, `userId`, `orgId`, `createdAt`, optional `runId`.  
- Used for internal eval quality and future fine-tuning/routing — never for elevating access.

## 5. Privacy

- Users only see their own sessions (admin audit is separate).  
- Deleting a session cascades messages + feedback for that session.
