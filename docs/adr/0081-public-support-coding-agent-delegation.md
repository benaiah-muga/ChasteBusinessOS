# ADR 0081: Explicit coding-agent delegation for public support replies

## Status

Accepted

## Context

The public support widget is anonymous. Its ordinary auto-reply uses the
organization's workspace AI provider and may call two server-side, read-only
tools: order status bound to the support conversation and published knowledge
search scoped to the organization. Coding-agent connections are personal and
must not be selected implicitly for an anonymous visitor's conversation.

## Decision

- A public support reply may use a personal OpenCode connection only when the
  organization AI settings explicitly name its owner with
  `ai.codingAgentUserId`. This setting is an operator authorization to use that
  member's personal connection for public widget replies.
- Resolve the connected default connection using both the configured user ID
  and organization ID. Missing, invalid, disconnected, unsupported, or
  undecryptable connections fail closed. Never fall back to workspace
  credentials after this setting is present.
- OpenCode receives no native tools. The Go server runs only the existing
  same-organization order-status and published-knowledge reads, then passes
  their results as quoted data. The order lookup remains bound to the current
  support conversation.
- If `ai.codingAgentUserId` is absent, preserve the existing workspace-provider
  auto-reply path and its scoped function tools.

## Consequences

An operator can deliberately authorize a personal connection for a public
support channel. The connected member's provider account may process widget
conversation content, so that delegation must be explicit and visible in the
organization's stored AI settings. Provider failures do not silently switch
the billing source or credential to a workspace API key.
