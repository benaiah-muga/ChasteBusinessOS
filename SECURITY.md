# Security Policy

## Supported versions

Security fixes are applied to the default branch (`main`). Pre-1.0 releases may
receive fixes on a best-effort basis.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report vulnerabilities privately by emailing the maintainers (see
repository owner contact) or using GitHub’s private vulnerability reporting if
enabled on this repository.

Include:

- Description of the issue
- Steps to reproduce
- Affected versions / commit
- Potential impact
- Any suggested fix (optional)

We aim to acknowledge reports within **72 hours** and to provide a status update
within **7 days**.

## Security principles for this project

- AI has **no elevated privileges** over human users.
- All mutations go through the **command bus** with permission checks and audit.
- Secrets must never be committed; use environment variables / secret managers.
- Prefer least privilege for database roles, API tokens, and worker credentials.
- Full autonomous AI mode must be explicitly enabled and heavily audited.

## Safe harbor

We welcome good-faith research. Please avoid privacy violations, data destruction,
and service disruption while testing.
