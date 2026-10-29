# ADR 0101: Resolve a customer to the surviving identity, with evidence

Status: accepted (2026-10-29)

## Context

The Workmate prompt tells the model to call `resolve_entity` before any write
that needs a customer id. That made the lookup the identity layer of the
product, and it was weaker than the rest of the system:

- it matched `name ILIKE %query% OR email ILIKE %query%`, so a name typed in a
  different word order, a company suffix, or a phone number in another format
  found nothing, and the assistant's honest conclusion was that the customer did
  not exist. The next step in that path is creating a duplicate, which is the
  failure customer merges exist to prevent.
- it returned every row it matched, including records already merged away. A
  merged customer is deactivated and points at its survivor. The executor's
  write guard rejects the tombstone, so the person saw a refusal after the
  assistant had confidently resolved an id.

ByteByteGo's account of Salesforce's data layer describes the same problem from
the other side: a model should never be the system that decides who a customer
is from a list of records. Match rules belong in code, the source records stay
untouched, and the output is a unified profile that links back to each of them.
Chaste already has that link: `customers.merged_into_customer_id`, written by
the governed `crm.mergeCustomers` with an inverse.

## Decision

### Normalize, then rank, then explain

`apps/api/internal/crm/identity.go` owns the pure half. It reuses the existing
normalizers (`NormalizeCustomerName` with company suffixes removed,
`NormalizeEmail`, `NormalizePhone` on the last nine digits) and scores a
candidate by the strongest evidence it can find:

| Evidence | Score | Reported as |
|---|---|---|
| normalized email equality | 100 | `email` |
| normalized phone equality | 95 | `phone` |
| normalized name equality | 90 | `exact name` |
| every query name token present in the name, any order | 75 | `name tokens` |
| one normalized name contains the other | 60 | `partial name` |
| conservative edit distance | 50 | `similar name` |

The strongest evidence is returned as `matchedOn`, so the model can say why it
picked a record instead of asserting an id.

### The merge link is the unified profile

`resolveCustomerMatchesSQL` walks merge roots in a recursive CTE, depth capped
at eight, and joins each candidate to its surviving record. The resolver:

- returns the survivor's id and name, never a merged record as the id to act on;
- reports the record that actually matched as `mergedFrom`;
- reports the survivor's deactivation, not the tombstone's;
- collapses rows that resolve to one survivor, keeping the strongest evidence
  and preferring a direct hit over a merge trail at equal strength.

Candidate selection is wider than the old substring match: the full text, the
subscriber digits of a phone, and all name tokens in any order. It is bounded by
pulling at most four times the requested limit and ranking down to the limit.

### Scope

Customers only. Vendors and employees keep their existing substring lookup:
they have no merge model and much lower duplicate pressure. If vendor merges are
ever added, the same ranker applies, because it takes no customer-specific input.

## Consequences

- The assistant can no longer resolve a tombstoned customer and then be refused
  by the executor, and it has the vocabulary to explain a merge.
- A lookup can now return more candidate rows before ranking. The bound is
  small, the query is organization-scoped, and the ranking is deterministic.
- The identity rules are pure and unit tested, and the database behavior is
  proved by an integration test that merges a duplicate and resolves it by
  name, token order, phone, and email.
- Source records are never rewritten by a lookup. The merge link, not a
  denormalized profile, remains the single source of identity.
- Similar names are the weakest signal and are only compared after exact and
  token evidence fail, so a typo cannot outrank a real match.
