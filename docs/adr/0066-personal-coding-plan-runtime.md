# ADR 0066: Personal coding-plan inference connections

## Status

Accepted

## Context

The workspace API-key provider is shared configuration and may be used by
scheduled work. Coding-plan accounts belong to individual users and are billed
under the provider's own plan. The app must keep those ownership and charging
boundaries clear while allowing Buzz and other user-started assistants to use a
person's Codex or OpenCode login.

Business tool calls must continue through workspace permissions, policy,
approval, compensations, and the append-only audit ledger. Sending native CLI
credentials to the generic model-provider adapter would blur the billing source
and require extracting credentials that the CLI manages itself.

## Decision

- Store connection ownership by organization and user. A personal connection
  can be selected only by its owner.
- Use Codex's device login and keep the resulting native account state in a
  service-owned per-user `CODEX_HOME` directory. Chaste does not read or copy
  its credential file. The Codex CLI is started with an empty temporary working
  directory, ephemeral sessions, a read-only sandbox, built-in tools disabled,
  and only the Chaste MCP bridge configured.
- Connect OpenCode through its authenticated HTTPS server API. Encrypt its
  Basic-auth secret with the existing AI configuration key and refuse unsafe
  private-network endpoints in production.
- Give each agent turn a signed MCP grant that expires, is revoked by connection
  status, and contains the tool names already exposed to that agent. The MCP
  route resolves current user membership, modules, and permissions before
  calling the kernel executor.
- Use the personal connection only for requests initiated by its owner. Work
  without a requesting user, including scheduled runs, continues to use the
  workspace provider.
- Record run and provider-reported token counts. Do not infer subscription
  price, remaining quota, or plan usage beyond the data each provider returns.

## Consequences

Users can keep one personal plan selected across interactive assistant
features, while workspace API keys remain available as a fallback when no
personal default exists. Native Codex connections require a persistent server
runtime with a private per-user data directory. OpenCode connections require a
dedicated server reachable over HTTPS and may serialize concurrent requests
per connection to keep its transient tool scope isolated.

Each MCP operation has the user's identity and agent session in its ledger
record. A provider can propose a business action, but the normal capability
pipeline still decides whether it is allowed or needs approval.
