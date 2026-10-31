/**
 * Authenticated live pass for every Go-owned API method still marked
 * `go/pending` in docs/migration/route-ownership.json.
 *
 * Signs up a real account against a running API, verifies the email through
 * the local mailpit sink, onboards an organization, then probes each pending
 * method with a minimal request. A probe passes when the route answers an
 * authenticated outcome (200, 400, 403, 404, 405, 422): 401 means the session
 * never reached the handler and 5xx means the handler failed. Machine-token
 * routes (SCIM, AI tools MCP) are probed without their bearer token; their own
 * JSON 401 answer counts as reached.
 *
 * Usage:
 *   pnpm exec tsx scripts/gates/go-live-pending.ts
 *   LIVE_BASE=http://127.0.0.1:18083 LIVE_AUTH_ORIGIN=http://localhost:3000 \
 *     pnpm exec tsx scripts/gates/go-live-pending.ts
 *
 * Defaults target the local dev stack: Go API on 127.0.0.1:18083, Vite/Auth
 * origin http://localhost:3000 (the Better Auth trusted origin), mailpit on
 * http://127.0.0.1:8025.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.LIVE_BASE ?? "http://127.0.0.1:18083";
const AUTH_ORIGIN = { origin: process.env.LIVE_AUTH_ORIGIN ?? "http://localhost:3000" };
const ROUTE_ORIGIN = { origin: BASE };
const MAILPIT = process.env.LIVE_MAILPIT ?? "http://127.0.0.1:8025";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter(Boolean)
    .join("; ");
}

async function findVerificationLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (res.ok) {
      const data = (await res.json()) as { messages?: Array<{ ID: string }> };
      for (const message of data.messages ?? []) {
        const detail = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`);
        if (!detail.ok) continue;
        const body = (await detail.json()) as { Text?: string; HTML?: string };
        const haystack = `${body.Text ?? ""}\n${body.HTML ?? ""}`;
        const match = /https?:\/\/[^\s"'<>]+\/api\/auth\/verify-email\?token=[^\s"'<>]+/.exec(haystack);
        if (match) return match[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no verification link found for ${email}`);
}

async function main(): Promise<void> {
  const email = `go-live-pending-${Date.now()}@chaste.test`;
  const password = "live-proof-password-1A";
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_ORIGIN },
    body: JSON.stringify({ email, password, name: "Live Pending Proof" }),
  });
  if (!signup.ok) throw new Error(`sign-up failed: ${signup.status} ${await signup.text()}`);
  let cookie = cookiesFrom(signup);
  console.log(`[live] signed up ${email}`);

  const onboard = () =>
    fetch(`${BASE}/api/onboarding`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...ROUTE_ORIGIN },
      body: JSON.stringify({
        intentId: crypto.randomUUID(),
        // The bootstrap slug retry caps at five attempts, so re-runs need a
        // fresh org name or they exhaust live-pending-trading through -5.
        orgName: `Live Pending Trading ${Date.now()}`,
        businessDescription:
          "A small distribution business buying stock from vendors and selling to local shops.",
      }),
    });
  let onboarding = await onboard();
  if (onboarding.status === 401) {
    const link = await findVerificationLink(email);
    const verified = await fetch(link.replace(/^https?:\/\/[^/]+/, BASE), { redirect: "manual" });
    console.log(`[live] verification link status ${verified.status}`);
    const signin = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    if (!signin.ok) throw new Error(`sign-in failed: ${signin.status} ${await signin.text()}`);
    cookie = cookiesFrom(signin);
    onboarding = await onboard();
  }
  if (!onboarding.ok) throw new Error(`onboarding failed: ${onboarding.status} ${await onboarding.text()}`);
  const onboarded = (await onboarding.json()) as { orgId?: string };
  const orgId = onboarded.orgId;
  if (!orgId) throw new Error(`no orgId in onboarding response: ${JSON.stringify(onboarded)}`);
  console.log(`[live] onboarded org ${orgId}`);

  const manifest = JSON.parse(readFileSync("docs/migration/route-ownership.json", "utf8")) as {
    entries: Array<{ kind: string; path: string; method: string; owner: string; parity: string }>;
  };
  const entries = manifest.entries.filter(
    (entry) => entry.kind === "api" && entry.owner === "go" && entry.parity === "pending",
  );
  console.log(`[live] probing ${entries.length} Go-pending methods`);

  let failures = 0;
  const machineAuthProbes = new Set([
    "POST /api/ai-tools/mcp",
    "DELETE /api/scim/v2/Users",
    "GET /api/scim/v2/Users/[id]",
    "DELETE /api/scim/v2/Users/[id]",
  ]);
  for (const entry of entries) {
    const path = entry.path.replace(/\[id\]/g, "00000000-0000-4000-8000-000000000000");
    const query = entry.method === "GET" && entry.path === "/api/messages/search" ? "?q=live" : "";
    const headers: Record<string, string> = { cookie, "x-organization-id": orgId, ...ROUTE_ORIGIN };
    let body: string | undefined;
    if (entry.method !== "GET") {
      headers["content-type"] = "application/json";
      body = "{}";
    }
    let status = 0;
    let text = "";
    try {
      const res = await fetch(`${BASE}${path}${query}`, {
        method: entry.method,
        headers,
        body,
        redirect: "manual",
      });
      status = res.status;
      text = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
    } catch (error) {
      text = String(error);
    }
    const machineProbe = machineAuthProbes.has(`${entry.method} ${entry.path}`);
    const machineAnswered = machineProbe && status === 401 && /scim|jsonrpc/i.test(text);
    const bad = (!machineAnswered && status === 401) || status >= 500 || status === 0;
    if (bad) failures++;
    console.log(`${bad ? "FAIL" : "ok  "} ${entry.method.padEnd(6)} ${entry.path} -> ${status} ${text}`);
  }
  if (failures > 0) throw new Error(`${failures} live probes failed`);
  console.log("[live] authenticated live pass OK");
}

main().catch((error) => {
  console.error(`[live] FAILED: ${error}`);
  process.exit(1);
});
