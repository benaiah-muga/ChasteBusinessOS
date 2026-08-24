# ADR 0018, Signed plugin manifests for Creator Mode and the marketplace

Date: 2026-08-23
Status: Accepted

## Context

Creator Mode lets agents propose platform changes as governed proposals, and the
roadmap calls for a plugin distribution format with signature verification plus
marketplace groundwork. Community capability packages must be verifiable
offline, without trusting a registry server, before any code path registers them.

## Decision

`@chaste/plugin-kit` defines the distribution format:

- A **manifest** is validated by zod: slug, semver version, capability ids
  (`module.action`), and a risk class per capability.
- Signing is over **canonical JSON** (sorted keys, no whitespace) hashed with
  SHA-256, then **ed25519**-signed (node:crypto, no new deps).
- `verifyPlugin` fails closed: schema violations, undeclared risks, or malformed
  key material all return `{ valid: false, reason }`.
- Installers pin publisher public keys; re-signing with a different key does not
  verify.

Marketplace listings store the manifest + signature + publisher key; publishing
refuses invalid signatures outright, and install re-verifies at execution time
(`creator.installListing`), so a key compromise invalidates old installs rather
than poisoning them silently.

Install records the installing org but does **not** hot-register capabilities
into the running kernel, community packages land through the same governed
proposal → CI merge path as everything else. The marketplace is discovery +
provenance, not live code injection.

## Consequences

- Anyone can verify provenance offline; no trusted registry required.
- Manifest changes of one byte invalidate signatures (array order included).
- Plugin code itself still ships via git/npm out-of-band; the manifest binds
  identity to declared capabilities and risks, which is what governance needs.
