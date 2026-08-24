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
