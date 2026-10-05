import { createHmac } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";

/**
 * Mints a Better Auth session cookie for a token, using the same signing rule
 * the runtime and the Go resolver both implement: HMAC-SHA256 over the token
 * with the secret's UTF-8 bytes, encoded with standard base64.
 *
 * Used by the session parity harness so the fixture does not depend on a
 * browser session or a hand-written temporary file.
 */

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  console.error("BETTER_AUTH_SECRET is required");
  process.exit(2);
}

const token = process.argv[2];
if (!token) {
  console.error("usage: sign-session-cookie.mjs <session-token>");
  process.exit(2);
}

const signature = createHmac("sha256", Buffer.from(secret, "utf8"))
  .update(Buffer.from(token, "utf8"))
  .digest("base64");

process.stdout.write(`${token}.${signature}`);