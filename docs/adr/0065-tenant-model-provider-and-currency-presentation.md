# ADR 0065: Tenant model providers and currency presentation

Status: accepted

## Context

The workmate previously read one process-wide provider configuration. That
made it impossible for a workspace administrator to choose an already
supported provider, a compatible gateway, or model roles without changing the
deployment. It also encouraged a dangerous assumption that a local coding
agent subscription could be copied into the web application. Separately,
shared money helpers always printed a dollar sign even when the organization
or device preference was Ugandan shillings.

## Decision

Add a governed, tenant-scoped model configuration stored in the existing
organization settings JSON. API keys are encrypted with the deployment secret
before they enter the kernel payload or database; reads return only a masked
hint. The existing Settings page edits provider, endpoint, model roles, and
key state through `settings.configureAiProvider`, with an inverse restore
capability. Chat, conversations, routines, support drafts, and home-page
summaries resolve this runtime configuration before constructing their model
client. Environment configuration remains the fallback.

Supported coding-agent detection remains a Creator-mode integration boundary:
the app may report or invoke an explicitly selected agent, but it never reads
or imports private CLI subscription tokens. Provider credentials must be
entered explicitly by an authorized administrator.

Display currency is initialized from the active organization's recording
currency and can be overridden by the existing device preference. Formatting
changes the symbol only; stored integer minor units and document currencies
are unchanged.

## Consequences

Workspaces can use OpenAI-compatible providers without a new app or deployment
variable. Provider changes are auditable and reversible, but still require an
administrator and a deployment encryption secret. Currency rendering is
consistent across existing pages, while actual conversion remains outside the
display preference and must be a separate accounting decision.
