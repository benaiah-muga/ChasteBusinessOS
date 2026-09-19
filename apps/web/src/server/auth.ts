import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, authAccount, authSession, authUser, authVerification } from "@chaste/db";

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const auth = betterAuth({
  database: drizzleAdapter(getDb().db, {
    provider: "pg",
    schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    // N03: a password account proves nothing about mailbox ownership, and a
    // pre-provisioned domain identity (SCIM, invitation) binds by email -
    // so sign-in stays sealed until the address is verified. Sign-up skips
    // auto-sign-in in this mode and duplicate-address responses stay
    // generic (anti-enumeration).
    requireEmailVerification: true,
  },
  emailVerification: {
    // This deployment has no SMTP transport wired; the verification link is
    // logged for the operator. docs/n03-verified-binding-matrix.md records
    // which deployment profiles transport a real mailer and which rely on
    // trusted-IdP assertions instead of email verification.
    sendVerificationEmail: async ({ user, url }) => {
      console.info(`[auth] email verification link for ${user.email}: ${url}`);
    },
    sendOnSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
  },
  rateLimit: {
    // Explicit over defaults: credential endpoints are throttled even in
    // dev-like environments and the window is tight enough to blunt
    // password spraying without hurting real sign-ins.
    enabled: true,
    window: 60,
    max: 100,
    rules: {
      "/sign-in/email": { max: 10, window: 60 },
      "/sign-up/email": { max: 10, window: 60 },
    },
  },
  trustedOrigins: [appUrl],
});
