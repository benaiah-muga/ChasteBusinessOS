# N03 - Verified identity binding: deployment matrix

Domain identities are pre-provisioned (SCIM provisioning, invitations) and
bind by email. A password account for that email proves nothing about
mailbox ownership, so two layers seal the binding:

1. **Better Auth gate** (`apps/web/src/server/auth.ts`):
   `emailAndPassword.requireEmailVerification = true` - sign-in refuses an
   unverified account (`EMAIL_NOT_VERIFIED`) and re-sends the verification
   link (`sendOnSignIn`); sign-up skips auto-sign-in in this mode and
   duplicate-address responses stay generic (anti-enumeration).
2. **Resolution gate** (`apps/web/src/server/session.ts`): an unverified
   session resolves to a bare identity - no memberships surfaced, no
   permissions - whatever the address's case. Verification, or a trusted
   IdP assertion in SSO profiles, unlocks pre-provisioned access.

The executable proof for the binding rule is
`apps/web/src/server/identity-binding.test.ts`: a pre-provisioned domain
user with an unverified sign-up for its email inherits nothing (including
case variants); verification unlocks the membership; concurrent first
sign-ins collapse to one domain user.

## Deployment profiles

| Profile | Mail transport | Identity path | Behavior |
|---|---|---|---|
| Dev / self-hosted, no SMTP | none - verification links are logged by the `sendVerificationEmail` callback | password | Operator copies the logged link to the new user; until verified, the session sees no orgs. Org creation (bootstrap) stays possible but the org is unusable until verified. |
| Production password + SMTP | wired via the mailer of the deployment | password | Verification email goes out at sign-up and again on each sign-in attempt (`sendOnSignIn`); the standard resend/change-email flow applies. Existing users with `emailVerified = false` from before this control are locked out at next sign-in and receive a fresh verification email - the audit's required clear resend path. |
| Trusted IdP / SSO | n/a | SSO assertion | The IdP assertion is the mailbox proof: treat SSO-originated identities as verified at the resolution layer if the assertion is trusted (verify the provider's `email_verified` claim mapping before enabling). |
| SCIM pre-provisioning + any of the above | per profile | SCIM creates the domain user and membership only | Membership stays claimable only by a verified (or IdP-proven) session for that email - never by a fresh unverified password sign-up. |

## Known edges covered

- **Case variations**: emails normalize to lowercase at every identity
  boundary (SCIM provisioning, actor resolution); a case-variant claim
  resolves to the same domain user and the same wall.
- **Concurrent first login**: both sign-ups race the unique
  `users.email`; the loser re-selects the winner's row - one domain user.
- **Email change / recovery**: Better Auth's change-email flow re-runs
  verification on the new address; recovery links prove mailbox control
  the same as verification.
- **Duplicate-address enumeration**: with the verification gate on,
  duplicate sign-up responses are generic.
- **Org bootstrap while unverified**: creating a brand-new organization
  claims nothing pre-provisioned and stays allowed; the org becomes usable
  once the session is verified.

## Not covered here

Real-SMTP and real-IdP end-to-end runs are deployment reproductions
(needs a running deployment): execute profile rows 2–4 against a staging
environment before exposing sign-up publicly.
