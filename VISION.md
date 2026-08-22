# ChasteBusinessOS — Vision

## The problem

Most ERPs fail at adoption, not at features. Teams spend months implementing
them and years clicking through every screen by hand. Meanwhile, the software
that could do the work for them — AI agents — is bolted on as a chatbot with a
hidden write path, elevated privileges, and no audit trail. That's not
automation; that's an unaudited second employee with root access.

## What we are building

**ChasteBusinessOS is an agentic ERP.** You describe your business in plain
language, and an AI co-worker configures and operates as much as possible on
your behalf — under your authority, through your rules, on the record.

The long-term goal is simple to state and hard to deliver:

> A business owner should be able to describe their business, processes, and
> goals in plain language, and the system should configure and operate as much
> as possible — with integrity, explainability, and human authority preserved.

We aim to be to **AI-native business software** what Linux is to operating
systems: an open, community-driven foundation others can trust, fork, and
extend.

## The one rule

There is exactly one way to change state in ChasteBusinessOS, and humans and
agents share it:

```
intent → resolve capability → validate input → check permissions
      → policy evaluation → [execute | request approval]
      → append to ledger → notify
```

Clicking "pay invoice" in the UI and typing "pay the Acme invoice" in chat
reach the same executor with the same capability ID. One path means one place
for security review, and automatic parity between what you can do and what
your AI co-worker can do.

## What we will never compromise

1. **Human authority.** The agent cannot spend above your approval threshold,
   assign itself a role, or take identity or destructive actions without a
   person. Policy gates are set by the org, enforced by the kernel.
2. **One governed path.** No hidden writes. Every action — human or agent —
   flows through the same capability pipeline: validate → authorize → policy →
   execute → audit.
3. **Reversibility.** State changes carry declared inverses. Financial
   documents reverse; they don't mutate. Posted documents are immutable.
4. **Honesty about gaps.** When the agent meets something it can't do, it
   files a ticket instead of improvising. A hallucinated command is worse than
   no command.
5. **Verifiable claims.** Demos are executable specifications (`pnpm demo:*`).
   Ledger balance is a property-tested invariant. If a demo fails, that's a
   bug worth knowing about.

## Where this goes

- **Near term:** complete the accounting/CRM/inventory core so an SMB could
  actually run on it (see [ROADMAP.md](ROADMAP.md)).
- **Mid term:** Creator Mode matures — the agent proposes platform changes as
  governed artifacts (diff + tests + risk assessment) and humans merge.
- **Long term:** a marketplace of community capabilities, enterprise hardening
  (RLS everywhere, SSO/SCIM, SOC2-style control mapping), and an ERP where
  describing the business *is* configuring it.

The model proposes; the harness disposes. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for how that holds up in practice.
