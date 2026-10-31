# 0079: Go owns opt-in provider-neutral OIDC sign-in

Status: accepted for migration, default off

## Context

The application is moving authentication ownership to Go while preserving the
existing Better Auth-compatible PostgreSQL user, account, verification, and
session tables. Future clients may not be browser applications, so provider
tokens must not become application session credentials and provider endpoints
must not be tied to a Vite callback.

## Decision

Implement one configured OpenID Connect issuer as a Go-owned authorization-code
flow. Go requires a configured issuer, client credentials, and exact registered
callback URI. It creates short-lived, one-use state transactions and uses
nonce and PKCE. The ID token is checked for issuer, signature, audience, expiry,
authorized party, and nonce. Multi-audience tokens require `azp`, and any
provided `azp` must equal the configured client ID. Discovery metadata is
validated before provider construction: every endpoint URL, including JWKS,
must use HTTPS and the issuer authority or an exact operator allowlist entry.
The OIDC HTTP client enforces the same authority boundary, resolves and pins
each connection to public IP addresses, disables proxies that could resolve
the hostname again, has a request timeout, and refuses redirects. Private and
special-use network addresses are not supported for OIDC endpoints. OIDC
accounts are keyed by issuer and subject. Existing users are
linked by email only when the signed `email_verified` claim is true and the
operator explicitly trusts the issuer to make that assertion. Provider access,
refresh, and ID tokens are not persisted or returned.

Successful sign-in creates a row in the existing Go-owned session table and
sets the existing signed HttpOnly session cookie. This first slice only
completes browser callbacks. A native client needs a separately designed
short-lived, one-time session handoff that does not expose reusable provider
tokens. SAML and SCIM provisioning writes remain out of scope until a governed
external identity actor and capability path exists.

Both `GO_AUTH_ROUTE=1` and `GO_OIDC_ENABLED=1` are required, and route ownership
remains unchanged by default.

## Consequences

Each deployment must configure its IdP and callback URI before OIDC can start.
The explicit verified-email trust setting prevents an arbitrary issuer from
silently claiming a pre-existing account. MIG-5 remains open until native
client exchange, SCIM provisioning writes, and provider-specific compatibility
proofs are addressed.
