# 0080: Go owns opt-in federated sign-in and SCIM provisioning

Status: accepted for migration, default off

## Context

The Go API is the authentication authority for future browser and native
clients. Authentication behavior must not depend on a browser framework, and
business identity changes from external providers must use the same governed
capability pipeline as other state changes.

## Decision

Keep OIDC and SAML provider flows in Go. OIDC callbacks create the existing
Go-owned session. Native OIDC clients exchange a short-lived, one-use code
bound to an S256 PKCE challenge and receive the session bearer only in a
no-store response. SAML uses operator-pinned IdP issuer, SSO endpoint, and
signing certificate, requires a signed response, and consumes request and
assertion replay identifiers before creating a session. Verified-email account
linking requires explicit operator trust.

SCIM provisioning and deactivation writes resolve the token and organization
in Go, attribute the action to an explicit external actor, and execute through
the capability executor in an organization-scoped transaction. Successful
state transitions use capability receipts for retry handling. Standard SCIM
clients may omit an idempotency header; clients that provide a UUID
`Idempotency-Key` get explicit operation identity.

Provider flows and SCIM reads and writes remain independently opt-in. Vite may
proxy supported auth paths to Go, but no browser client owns provider tokens or
the underlying session lifecycle.

## Consequences

Each deployment must configure and test its own provider metadata and trust
settings. Browser and native flows need provider-specific compatibility proofs
before route ownership changes. SCIM integrations must verify their resource
and deactivation semantics against the configured identity provider. MIG-5
remains open until those proofs and production ownership cutover are complete.
