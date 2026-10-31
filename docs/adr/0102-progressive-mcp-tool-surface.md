# ADR 0102: Advertise three meta tools to coding agents, not the catalog

Status: accepted (2026-10-29)

## Context

The MCP bridge for connected coding agents built its tool list from every
capability the signed user could invoke, filtered by a per-connection allowlist.
Two problems followed.

First, the allowlist was signed into the two-day connection token at configure
time. The product configured it with an empty list, so `tools/list` returned
nothing at all. A coding agent connected to Chaste could not see a single tool.
The test suite encoded that as the expected behavior, which is how it survived.

Second, even with a populated list the design scales badly. Every tool
definition is a name, a description, and a JSON schema, and the MCP client sends
all of them on every model request. The governed catalog is in the hundreds. An
agent that spends most of its context on tool definitions has little left for
the work, which is exactly the problem ByteByteGo's account of Salesforce's
headless toolkit describes: the practical fix is a small index, not a smaller
toolbox.

Chaste already had the right primitives inside the Workmate chat turn:
`capability_search` and `capability_invoke` reach the whole governed registry
without advertising it, and ADR 0092 recorded that discovery is not a bypass
because the executor re-checks everything. The MCP bridge simply did not use
that pattern.

## Decision

### A stable three-tool surface

The bridge always advertises:

- `chaste_discover`: ranked search over the governed catalog the user may
  invoke. Returns id, title, intent, module, and risk. No schemas.
- `chaste_describe`: one capability's contract, including the closed input
  schema and the advisory skills that include it.
- `chaste_dispatch`: runs one capability by id with schema-valid input.

Direct capability tools are advertised only when a connection explicitly pins
them in its allowlist. `tools/call` still accepts those direct names, so a
client that cached an older list keeps working.

### Discovery has to be good enough to replace the catalogue

The article's discover step is semantic. Chaste's is deterministic lexical
search, so the ranking had to earn its place:

- filler words are ignored, and a query made only of filler matches nothing;
- a term in the capability id or title counts more than the same term in prose;
- a term in the id's last segment counts more still, because that segment names
  the object the capability acts on;
- common asking verbs map to capability verbs (`find` to `list` and `get`,
  `create` to `create` and `add`), at lower weight than a literal match;
- ties prefer the shorter id, which is the more direct answer.

This is what makes `find a customer` return `crm.listCustomers` before
`crm.listDeals`, a fix proved by a unit test.

### Dispatch is the existing governed path

`chaste_dispatch` builds the same agent claims the direct call path built, runs
the executor, and records `tool_call` and `tool_result` events in the session
trajectory. Permissions, module switchboard, policy, approvals, ledger receipts,
and inverses are unchanged. A capability the user may not invoke is refused at
discovery, at dispatch, and again in the executor.

The allowlist remains an advertisement filter, not an authority boundary. The
authority boundary is the executor, exactly as ADR 0092 decided for chat
discovery.

### Bounded metadata

Discover returns at most twenty rows and never a schema. Describe returns one
contract. The bridge rejects capability names that would collide with a meta
tool after sanitization, so a future `chaste.discover` capability cannot make
the surface ambiguous.

## Consequences

- A production connection now advertises three tools and can still reach every
  governed capability it is permitted to use. The empty-allowlist production
  configuration is now meaningful instead of broken.
- Discovery quality is load-bearing. The ranking is deterministic, tested
  against natural-language queries, and deliberately lexical. A semantic
  index remains a future improvement, not an assumption.
- Read-only discover and describe calls are not written to the session
  trajectory; dispatch is, so the audited record stays about business actions.
- Pinned direct tools keep working, and the bridge still refuses them when the
  user lacks the permission. Nothing about approvals or reversibility changes.
- The rate limiter now covers the meta calls as well as direct calls.
