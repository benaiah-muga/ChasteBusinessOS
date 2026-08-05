# Spec: UI correctness & chat safety contracts

**Status:** Draft  
**Related:** [agent-harness.md](./agent-harness.md), [ai-autonomy-and-safety.md](../ai-autonomy-and-safety.md), [ui-schema package](../../packages/ui-schema)

## 1. Problem

The harness could emit generative UI (`UiPart`s). Wrong parts break trust: dead `resource_link` buttons, confirm cards for non-existent commands, or tables of fabricated metrics. Correctness is a **platform contract**, not a model courtesy.

## 2. Contracts (must hold)

| Contract | Rule |
|---|---|
| **C1 Zod boundary** | Every assistant part validates against `uiPartSchema` before persistence or stream to web. Invalid parts are dropped or replaced with `error`. |
| **C2 Command existence** | `confirm_action.command` and plan step commands MUST exist in the live command registry for the org’s installed modules. |
| **C3 Permission** | Confirm/auto-exec still go through the command bus; no UI part elevates privileges. |
| **C4 Resource links** | `resource_link` only emitted after **server-side resolve**: known resource type + id exists in org (and branch if scoped), user may read it, href is allowlisted path template. |
| **C5 No invented URLs** | Href must match registered templates (`/crm?customerId=…`, `/apps/…`). External URLs only with explicit `external: true` + allowlist host policy. |
| **C6 Metrics** | Metric/table values that claim ledger/stock/balance must come from query results in the same turn (or stamped `unverified: true`). |
| **C7 Gap honesty** | Missing capability → `gap_ticket` part or clear text; never a fake command name. |
| **C8 Feedback loop** | Like/dislike stores signal without changing permissions; used for evals and prompt quality only. |

## 3. `resource_link` schema

```ts
{
  type: "resource_link";
  resourceType: string;      // e.g. "crm.customer", "core.branch"
  resourceId: string;        // uuid or stable id
  label: string;
  href: string;              // app-relative path, validated
  verified: boolean;         // true only if resolve succeeded
  branchId?: string;
}
```

**Emit path:**

1. Command succeeds with known entity id.  
2. `resolveResourceLink({ resourceType, resourceId, orgId, branchId?, actor })`.  
3. On failure → omit link or emit text “Created but link unavailable”; never unverified clickable primary CTA.  
4. Web renders only `verified === true` as navigation buttons; otherwise muted text.

## 4. Allowlisted href templates

Maintained in `packages/ai-core` (or platform) as a registry:

| resourceType | Template |
|---|---|
| `crm.customer` | `/crm?customerId={id}` |
| `acc.invoice` | `/accounting?invoiceId={id}` |
| `inv.product` | `/inventory?productId={id}` |
| `core.branch` | `/settings?branchId={id}` |
| `core.capability.gap` | `/settings?gapId={id}` |
| `core.notification` | (open bell; no deep path required) |

Unknown types → no link.

## 5. Chat history & continuation

- Sessions listed for the acting user (org-scoped).  
- Continue = load messages by `sessionId`; never cross-user.  
- Title derived from first user message (editable later).  
- Top bar of chat: New · History · (optional branch badge).

## 6. Feedback

```ts
{ sessionId, messageId, rating: "up" | "down", comment?: string, runId? }
```

Stored in `chat_message_feedback`. Not visible to other orgs. Aggregates feed the **model eval suite**, not live privilege changes.

## 7. Tests required

- Unit: href template expansion + reject open redirects  
- Unit: drop invalid UiPart  
- Integration: successful create → verified link; deleted entity → no verified link  
- E2E: continue session restores transcript; feedback POST succeeds  

## 8. Out of scope

- Client-side only “validation” of links  
- Trusting model-supplied absolute URLs without allowlist  
