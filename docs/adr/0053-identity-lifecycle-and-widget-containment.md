# ADR 0053: One identity lifecycle and unbound widget threads

Status: Accepted

Date: 2026-09-16

## Context

The W0.4 entry-point inventory and audit findings N03/N04/N07/N08 left four
write boundaries outside the kernel: invitation acceptance replaced roles
from a check performed outside its transaction; SCIM deactivation removed a
membership but left `user_roles` behind (re-provisioning resurrected old
powers) and could silently delete the org's last owner; conversation and
ticket creation wrote domain rows route-side with no audit entry; and the
public widget bound a conversation to whichever customer matched the
visitor's submitted email — anyone who knew a customer's address and the
public embed token could open a thread carrying that customer's account
facts into model-generated drafts.

## Decision

**One lifecycle service.** `server/identity-lifecycle.ts` owns the two
transitions that create and destroy authority. `claimInvitation` locks the
invitation row (`FOR UPDATE`), compares and sets the status transition,
requires a verified mailbox (N03: an invitation is a pre-provisioned
identity binding, and an unverified claim would let whoever registers a
claimed address inherit its authority), and commits membership, role grant,
and the accepted flag in one unit. `deactivateMember` removes membership,
every role grant, and pending invitations for the member's address in one
transaction, so an IdP-driven disable leaves no half-live identity and
re-provisioning starts from least privilege. Both refuse to act on the
organization's last owner via a shared guard (`@chaste/module-iam`
`assertNotLastOwner`) that `iam.assignRole` uses as well: role reassignment,
invitation replacement, and deactivation can never strand the books
without an owner.

**Widget threads start unbound.** The public route no longer looks up or
creates customers. A widget conversation stores the visitor's email on the
thread itself plus a per-conversation secret — issued once at start, stored
only as a SHA-256 hash, required (timing-safe compare) for every subsequent
message, escalation, and poll. A thread address in client hands is a
guessable uuid; the secret is what makes it the visitor's. Customer binding
becomes verified staff action on the desk. The care agent's order tool
honestly reports "no account on file" for unbound threads, so auto-replies
can lean on published knowledge but cannot disclose account facts about
anyone — including the address the visitor typed.

**Creation paths go through the kernel.** `messaging.createConversation`
(header + creator membership in one audited unit) and
`support.createTicket` (durable ticket id in the receipt) replace route-side
inserts; the chat loop's `file_ticket` sink executes the capability as the
acting user and reports a refusal honestly (`{ ok: false, error }`) instead
of a fake ticket id. The routine runner's sink stays a documented
infrastructure exception: its system actor's delegated permission set (F06)
does not include support authority, and governing system-work delegation is
A01 work, tracked in the W0 register.

## Consequences

- `support_conversations.customer_id` is nullable (migration 0047); the
  desk renders unbound threads via the visitor contact, and staff-created
  conversations still require a customer.
- Invite acceptance now requires `emailVerified` from the auth account; the
  session resolves it through `getResolvedUser`. Fresh sign-ups must verify
  before claiming pre-provisioned authority.
- Onboarding's bootstrap write remains the B01 exception work (T08) and is
  deliberately not claimed here.

## Proof

`identity-lifecycle.test.ts` (8 cases: atomic claim, concurrent double
accept with one winner, unverified/expired/mismatch refusals, last-owner
deactivation with zero partial effects, full grant clearing),
`last-owner.test.ts` (demotion refused then allowed), `create.test.ts` /
`create-ticket.test.ts` (governed creation + authority refusals through the
kernel executor), and `support-public.test.ts` (victim email binds nothing;
secret gates read, write, and escalate).
