import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  createGoRouteProxyPlugin,
  goRouteProxyFlagsFromEnv,
  isGoRouteRequest,
  type GoRouteProxyFlags,
} from "./go-route-proxy";

const runningServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function requestRecorder(target: string, streamed = false): Server {
  return createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (streamed && request.url?.startsWith("/api/support/public")) {
        response.writeHead(202, { "content-type": "text/plain" });
        response.write("accepted:");
        setTimeout(() => response.end("complete"), 50);
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "proxy-result=preserved; Path=/" });
      response.end(JSON.stringify({
        target,
        method: request.method,
        url: request.url,
        cookie: request.headers.cookie,
        idempotencyKey: request.headers["idempotency-key"],
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
  });
}

const selectorCases: Array<{ env: string; flag: keyof GoRouteProxyFlags; method: string; url: string }> = [
  { env: "CHASTE_GO_SUPPORT_PUBLIC_ROUTE", flag: "supportPublic", method: "POST", url: "/api/support/public?widget=1" },
  { env: "CHASTE_GO_AUTH_ROUTE", flag: "auth", method: "POST", url: "/api/auth/sign-in/email" },
  { env: "CHASTE_GO_SCIM_READ_ROUTE", flag: "scimRead", method: "GET", url: "/api/scim/v2/Users?startIndex=1" },
  { env: "CHASTE_GO_SCIM_READ_ROUTE", flag: "scimRead", method: "GET", url: "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001" },
  { env: "CHASTE_GO_SCIM_WRITE_ROUTE", flag: "scimWrite", method: "POST", url: "/api/scim/v2/Users" },
  { env: "CHASTE_GO_SCIM_WRITE_ROUTE", flag: "scimWrite", method: "DELETE", url: "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001" },
  { env: "CHASTE_GO_PORTAL_INVOICE_ROUTE", flag: "portalInvoice", method: "GET", url: "/api/portal/invoice/token?view=1" },
  { env: "CHASTE_GO_SALES_INVOICE_ROUTE", flag: "salesInvoice", method: "GET", url: "/api/sales/order-id" },
  { env: "CHASTE_GO_MODULES_ROUTE", flag: "modulesRead", method: "GET", url: "/api/modules" },
  { env: "CHASTE_GO_MODULES_WRITE_ROUTE", flag: "modulesWrite", method: "POST", url: "/api/modules" },
  { env: "CHASTE_GO_PROJECTS_ROUTE", flag: "projects", method: "POST", url: "/api/projects" },
  { env: "CHASTE_GO_ROUTINES_ROUTE", flag: "routines", method: "GET", url: "/api/routines" },
  { env: "CHASTE_GO_ROUTINES_ROUTE", flag: "routines", method: "POST", url: "/api/routines" },
  { env: "CHASTE_GO_TEAM_READ_ROUTE", flag: "teamRead", method: "GET", url: "/api/team" },
  { env: "CHASTE_GO_TEAM_WRITE_ROUTE", flag: "teamWrite", method: "POST", url: "/api/team" },
  { env: "CHASTE_GO_BRANDING_ROUTE", flag: "branding", method: "POST", url: "/api/branding" },
  { env: "CHASTE_GO_ANALYTICS_ROUTE", flag: "analytics", method: "GET", url: "/api/analytics" },
  { env: "CHASTE_GO_ANALYTICS_ROUTE", flag: "analytics", method: "POST", url: "/api/analytics" },
  { env: "CHASTE_GO_MY_WORK_ROUTE", flag: "myWork", method: "GET", url: "/api/my-work?status=open" },
  { env: "CHASTE_GO_DASHBOARD_ROUTE", flag: "dashboard", method: "GET", url: "/api/dashboard" },
  { env: "CHASTE_GO_SETUP_ROUTE", flag: "setup", method: "GET", url: "/api/setup?source=dashboard" },
  { env: "CHASTE_GO_LEDGER_ROUTE", flag: "ledger", method: "GET", url: "/api/ledger" },
  { env: "CHASTE_GO_METRICS_ROUTE", flag: "metrics", method: "GET", url: "/api/metrics" },
  { env: "CHASTE_GO_MY_WORK_SUMMARY_ROUTE", flag: "myWorkSummary", method: "POST", url: "/api/my-work/summarize?scope=mine" },
  { env: "CHASTE_GO_SIGNALS_ROUTE", flag: "signals", method: "GET", url: "/api/signals?status=active" },
  { env: "CHASTE_GO_SCIM_TOKENS_ROUTE", flag: "scimTokens", method: "GET", url: "/api/scim/tokens" },
  { env: "CHASTE_GO_SCIM_TOKENS_ROUTE", flag: "scimTokens", method: "POST", url: "/api/scim/tokens" },
  { env: "CHASTE_GO_SCIM_TOKENS_ROUTE", flag: "scimTokens", method: "DELETE", url: "/api/scim/tokens?id=token-id" },
  { env: "CHASTE_GO_SESSIONS_ROUTE", flag: "sessions", method: "GET", url: "/api/sessions?limit=10" },
  { env: "CHASTE_GO_SESSIONS_ROUTE", flag: "sessions", method: "GET", url: "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001?include=events" },
  { env: "CHASTE_GO_SESSIONS_ROUTE", flag: "sessions", method: "GET", url: "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001/replay" },
  { env: "CHASTE_GO_DURABLE_RUNS_ROUTE", flag: "durableRuns", method: "GET", url: "/api/durable-runs?limit=10" },
  { env: "CHASTE_GO_DURABLE_RUNS_ROUTE", flag: "durableRuns", method: "GET", url: "/api/durable-runs/aaaaaaaa-0000-4000-8000-000000000001?include=steps" },
  { env: "CHASTE_GO_NOTIFICATIONS_ROUTE", flag: "notifications", method: "GET", url: "/api/notifications?limit=10&cursor=next" },
  { env: "CHASTE_GO_NOTIFICATIONS_WRITE_ROUTE", flag: "notificationsWrite", method: "POST", url: "/api/notifications" },
];

const supportedGoAuthRoutes: Array<{ method: string; url: string }> = [
  { method: "POST", url: "/api/auth/sign-up/email" },
  { method: "POST", url: "/api/auth/sign-in/email" },
  { method: "POST", url: "/api/auth/send-verification-email" },
  { method: "GET", url: "/api/auth/verify-email?token=signed-token" },
  { method: "POST", url: "/api/auth/request-password-reset" },
  { method: "GET", url: "/api/auth/reset-password/signed-token" },
  { method: "POST", url: "/api/auth/reset-password" },
  { method: "GET", url: "/api/auth/get-session" },
  { method: "POST", url: "/api/auth/get-session" },
  { method: "POST", url: "/api/auth/sign-out" },
  { method: "POST", url: "/api/auth/revoke-session" },
  { method: "POST", url: "/api/auth/revoke-sessions" },
];

describe("Vite Go route proxy selection", () => {
  it.each(["http://127.0.0.1:8080/api", "http://user:secret@127.0.0.1:8080", "http://127.0.0.1:8080/?tenant=one"])(
    "rejects a non-origin Go API target: %s",
    (target) => {
      expect(() => createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), target))
        .toThrow("CHASTE_GO_API_ORIGIN must be an HTTP or HTTPS origin without credentials or a path");
    },
  );

  it("routes only implemented Go auth endpoints by default and leaves other Go routes disabled", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(flags.auth).toBe(true);
    expect(Object.entries(flags).filter(([key]) => key !== "auth").every(([, enabled]) => !enabled)).toBe(true);
    for (const { method, url } of supportedGoAuthRoutes) {
      expect(isGoRouteRequest(flags, method, url), `${method} ${url}`).toBe(true);
    }
    expect(isGoRouteRequest(flags, "POST", "/api/auth/sign-in/social")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/change-password")).toBe(false);
    expect(isGoRouteRequest(flags, "DELETE", "/api/auth/get-session")).toBe(false);
    expect(isGoRouteRequest(flags, "OPTIONS", "/api/auth/get-session")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/reset-password")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/reset-password/token/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/sign-in/oidc")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/auth/callback/saml")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/authentication/get-session")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/setup")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/routines")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/support/public")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/scim/v2/Users")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/scim/v2/Users")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/sessions")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/durable-runs")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/notifications")).toBe(false);
  });

  it("routes optional federated auth only when its matching Go selector is enabled", () => {
    const oidc = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_OIDC_ROUTE: "1" });
    expect(isGoRouteRequest(oidc, "GET", "/api/auth/sign-in/oidc")).toBe(true);
    expect(isGoRouteRequest(oidc, "GET", "/api/auth/callback/oidc?code=one")).toBe(true);
    expect(isGoRouteRequest(oidc, "POST", "/api/auth/native/exchange")).toBe(true);
    expect(isGoRouteRequest(oidc, "GET", "/api/auth/sign-in/saml")).toBe(false);

    const saml = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_SAML_ROUTE: "1" });
    expect(isGoRouteRequest(saml, "GET", "/api/auth/sign-in/saml")).toBe(true);
    expect(isGoRouteRequest(saml, "POST", "/api/auth/callback/saml")).toBe(true);
    expect(isGoRouteRequest(saml, "GET", "/api/auth/sign-in/oidc")).toBe(false);
  });

  it("allows an explicit legacy-auth compatibility opt-out", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_ROUTE: "0" });
    expect(flags.auth).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/auth/sign-in/email")).toBe(false);
  });

  it("keeps auth on the legacy route when the Go API explicitly disables its auth mount", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_ROUTE: "1", GO_AUTH_ROUTE: "0" });
    expect(flags.auth).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/auth/sign-in/email")).toBe(false);
  });

  it.each(selectorCases)("enables $flag only with its Vite selector", ({ env, flag, method, url }) => {
    const flags = goRouteProxyFlagsFromEnv({ [env]: "1" });
    expect(flags[flag]).toBe(true);
    expect(isGoRouteRequest(flags, method, url)).toBe(true);
  });

  it("keeps unsupported routine methods and subpaths on the legacy route", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_ROUTINES_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "DELETE", "/api/routines")).toBe(false);
    expect(isGoRouteRequest(flags, "HEAD", "/api/routines")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/routines/webhook/secret-token")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/routines/unknown")).toBe(false);
  });

  it("keeps unsupported ledger methods and subpaths on the legacy route", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_LEDGER_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "POST", "/api/ledger")).toBe(false);
    expect(isGoRouteRequest(flags, "DELETE", "/api/ledger")).toBe(false);
    expect(isGoRouteRequest(flags, "HEAD", "/api/ledger")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/ledger/extra")).toBe(false);
  });

  it("keeps SCIM read and write selectors independent", () => {
    const userPath = "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001";
    const readOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_READ_ROUTE: "1" });
    expect(isGoRouteRequest(readOnly, "GET", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", userPath)).toBe(true);
    expect(isGoRouteRequest(readOnly, "POST", "/api/scim/v2/Users")).toBe(false);
    expect(isGoRouteRequest(readOnly, "DELETE", userPath)).toBe(false);

    const writeOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(writeOnly, "GET", "/api/scim/v2/Users")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "GET", userPath)).toBe(false);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "DELETE", userPath)).toBe(true);
  });

  it("keeps team read and write selectors independent and exact", () => {
    const readOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_TEAM_READ_ROUTE: "1" });
    expect(isGoRouteRequest(readOnly, "GET", "/api/team")).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", "/api/team?view=members")).toBe(true);
    expect(isGoRouteRequest(readOnly, "POST", "/api/team")).toBe(false);
    expect(isGoRouteRequest(readOnly, "GET", "/api/team/invite")).toBe(false);

    const writeOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_TEAM_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(writeOnly, "POST", "/api/team")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "GET", "/api/team")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "PATCH", "/api/team")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/team/invite")).toBe(false);
  });

  it("keeps sessions and durable-runs selectors independent and exact", () => {
    const sessionItem = "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001";
    const runsItem = "/api/durable-runs/aaaaaaaa-0000-4000-8000-000000000001";
    const sessionsOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "1" });
    expect(isGoRouteRequest(sessionsOnly, "GET", "/api/sessions?limit=10")).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", `${sessionItem}?include=events`)).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", `${sessionItem}/replay`)).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", "/api/durable-runs")).toBe(false);
    expect(isGoRouteRequest(sessionsOnly, "GET", runsItem)).toBe(false);

    const durableRunsOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_DURABLE_RUNS_ROUTE: "1" });
    expect(isGoRouteRequest(durableRunsOnly, "GET", "/api/durable-runs?limit=10")).toBe(true);
    expect(isGoRouteRequest(durableRunsOnly, "GET", `${runsItem}?include=steps`)).toBe(true);
    expect(isGoRouteRequest(durableRunsOnly, "GET", "/api/sessions")).toBe(false);
    expect(isGoRouteRequest(durableRunsOnly, "GET", sessionItem)).toBe(false);

    for (const [flags, method, path] of [
      [sessionsOnly, "POST", "/api/sessions"],
      [sessionsOnly, "GET", "/api/sessions/not-a-uuid"],
      [sessionsOnly, "GET", `${sessionItem}/events`],
      [durableRunsOnly, "POST", "/api/durable-runs"],
      [durableRunsOnly, "GET", "/api/durable-runs/not-a-uuid"],
      [durableRunsOnly, "GET", `${runsItem}/steps`],
    ] as const) {
      expect(isGoRouteRequest(flags, method, path)).toBe(false);
    }
  });

  it("keeps the metrics selector GET-only and exact", () => {
    const metrics = goRouteProxyFlagsFromEnv({ CHASTE_GO_METRICS_ROUTE: "1" });
    expect(isGoRouteRequest(metrics, "GET", "/api/metrics")).toBe(true);
    expect(isGoRouteRequest(metrics, "POST", "/api/metrics")).toBe(false);
    expect(isGoRouteRequest(metrics, "HEAD", "/api/metrics")).toBe(false);
    expect(isGoRouteRequest(metrics, "GET", "/api/metrics/extra")).toBe(false);
  });

  it("preserves auth fallback, setup, method-specific, path-prefix, body, cookie, and streaming behavior", async () => {
    const go = requestRecorder("go", true);
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });

    const legacy = requestRecorder("legacy");
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve())) });

    const flags = goRouteProxyFlagsFromEnv({
      CHASTE_GO_SUPPORT_PUBLIC_ROUTE: "1",
      CHASTE_GO_SCIM_READ_ROUTE: "1",
      CHASTE_GO_SCIM_WRITE_ROUTE: "1",
      CHASTE_GO_PORTAL_INVOICE_ROUTE: "1",
      CHASTE_GO_MODULES_WRITE_ROUTE: "1",
      CHASTE_GO_TEAM_READ_ROUTE: "1",
      CHASTE_GO_TEAM_WRITE_ROUTE: "1",
      CHASTE_GO_SETUP_ROUTE: "1",
      CHASTE_GO_ANALYTICS_ROUTE: "1",
      CHASTE_GO_MY_WORK_ROUTE: "1",
      CHASTE_GO_MY_WORK_SUMMARY_ROUTE: "1",
      CHASTE_GO_SIGNALS_ROUTE: "1",
      CHASTE_GO_SCIM_TOKENS_ROUTE: "1",
      CHASTE_GO_SESSIONS_ROUTE: "1",
      CHASTE_GO_DURABLE_RUNS_ROUTE: "1",
      CHASTE_GO_NOTIFICATIONS_ROUTE: "1",
      CHASTE_GO_NOTIFICATIONS_WRITE_ROUTE: "1",
    });
    const vite: ViteDevServer = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(flags, goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: legacyOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    const selected = await fetch(`${origin}/api/auth/sign-in/email?intent=signup`, {
      method: "POST",
      headers: { cookie: "auth-session=browser", "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.test" }),
    });
    const selectedPayload = await selected.json() as { target: string; method: string; url: string; cookie: string; body: string };
    expect(selectedPayload).toEqual({
      target: "go",
      method: "POST",
      url: "/api/auth/sign-in/email?intent=signup",
      cookie: "auth-session=browser",
      body: JSON.stringify({ email: "person@example.test" }),
    });
    expect(selected.headers.get("set-cookie")).toContain("proxy-result=preserved");

    const unsupportedAuth = await fetch(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "unexpected" }),
    });
    expect(await unsupportedAuth.json()).toMatchObject({ target: "legacy", url: "/api/auth/sign-in/social" });

    const unsupportedAuthMethod = await fetch(`${origin}/api/auth/get-session`, { method: "DELETE" });
    expect(await unsupportedAuthMethod.json()).toMatchObject({ target: "legacy", method: "DELETE" });

    const setup = await fetch(`${origin}/api/setup?source=dashboard`);
    expect((await setup.json()).target).toBe("go");

    const teamRead = await fetch(`${origin}/api/team?view=members`);
    expect((await teamRead.json())).toMatchObject({ target: "go", method: "GET", url: "/api/team?view=members" });

    const teamWrite = await fetch(`${origin}/api/team`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "createRole", key: "finance-viewer", name: "Finance viewer", intentId: "team-role-intent" }),
    });
    expect((await teamWrite.json())).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/team",
      body: JSON.stringify({ action: "createRole", key: "finance-viewer", name: "Finance viewer", intentId: "team-role-intent" }),
    });

    const teamUnsupportedMethod = await fetch(`${origin}/api/team`, { method: "PATCH" });
    expect((await teamUnsupportedMethod.json())).toMatchObject({ target: "legacy", method: "PATCH" });

    const teamUnsupportedPath = await fetch(`${origin}/api/team/invitations`);
    expect((await teamUnsupportedPath.json())).toMatchObject({ target: "legacy", method: "GET" });

    const analyticsRead = await fetch(`${origin}/api/analytics?dataset=analytics.pipelineByStage`);
    expect((await analyticsRead.json()).target).toBe("go");

    const analyticsReport = await fetch(`${origin}/api/analytics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Quarterly report", sections: [] }),
    });
    expect(await analyticsReport.json()).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/analytics",
      body: JSON.stringify({ title: "Quarterly report", sections: [] }),
    });

    const myWork = await fetch(`${origin}/api/my-work?status=open`);
    expect((await myWork.json()).target).toBe("go");

    const myWorkSummary = await fetch(`${origin}/api/my-work/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "mine" }),
    });
    expect((await myWorkSummary.json())).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/my-work/summarize",
      body: JSON.stringify({ scope: "mine" }),
    });

    const signals = await fetch(`${origin}/api/signals?status=active`);
    expect((await signals.json())).toMatchObject({ target: "go", method: "GET", url: "/api/signals?status=active" });

    const sessions = await fetch(`${origin}/api/sessions?limit=10`);
    expect((await sessions.json())).toMatchObject({ target: "go", method: "GET", url: "/api/sessions?limit=10" });

    const sessionDetailPath = "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001?include=events";
    const sessionDetail = await fetch(`${origin}${sessionDetailPath}`);
    expect((await sessionDetail.json())).toMatchObject({ target: "go", method: "GET", url: sessionDetailPath });

    const sessionReplay = await fetch(`${origin}/api/sessions/aaaaaaaa-0000-4000-8000-000000000001/replay`);
    expect((await sessionReplay.json())).toMatchObject({ target: "go", method: "GET", url: "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001/replay" });

    const durableRuns = await fetch(`${origin}/api/durable-runs?limit=10`);
    expect((await durableRuns.json())).toMatchObject({ target: "go", method: "GET", url: "/api/durable-runs?limit=10" });

    const durableRunPath = "/api/durable-runs/aaaaaaaa-0000-4000-8000-000000000001?include=steps";
    const durableRun = await fetch(`${origin}${durableRunPath}`);
    expect((await durableRun.json())).toMatchObject({ target: "go", method: "GET", url: durableRunPath });

    const notificationPath = "/api/notifications?limit=10&cursor=next";
    const notifications = await fetch(`${origin}${notificationPath}`);
    expect((await notifications.json())).toMatchObject({ target: "go", method: "GET", url: notificationPath });

    const notificationRead = await fetch(`${origin}/api/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "aaaaaaaa-0000-4000-8000-000000000001" }),
    });
    expect((await notificationRead.json())).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/notifications",
      body: JSON.stringify({ id: "aaaaaaaa-0000-4000-8000-000000000001" }),
    });

    const scimTokenList = await fetch(`${origin}/api/scim/tokens`);
    expect((await scimTokenList.json())).toMatchObject({ target: "go", method: "GET", url: "/api/scim/tokens" });

    const scimTokenCreate = await fetch(`${origin}/api/scim/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "66666666-6666-4666-8666-666666666666" },
      body: JSON.stringify({ name: "automation" }),
    });
    expect((await scimTokenCreate.json())).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/scim/tokens",
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      body: JSON.stringify({ name: "automation" }),
    });

    const scimTokenDelete = await fetch(`${origin}/api/scim/tokens?id=token-id`, {
      method: "DELETE",
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777777" },
    });
    expect((await scimTokenDelete.json())).toMatchObject({ target: "go", method: "DELETE", url: "/api/scim/tokens?id=token-id", idempotencyKey: "77777777-7777-4777-8777-777777777777" });

    const unsupportedMethod = await fetch(`${origin}/api/portal/invoice/token`, { method: "POST" });
    expect((await unsupportedMethod.json()).target).toBe("legacy");

    const enabledMethod = await fetch(`${origin}/api/portal/invoice/token?download=1`);
    expect((await enabledMethod.json()).target).toBe("go");

    const modulesReadWithoutFlag = await fetch(`${origin}/api/modules`);
    expect((await modulesReadWithoutFlag.json()).target).toBe("legacy");

    const prefixFallback = await fetch(`${origin}/api/setup/extra`);
    expect((await prefixFallback.json()).target).toBe("legacy");

    const analyticsUnsupportedMethod = await fetch(`${origin}/api/analytics`, { method: "DELETE" });
    expect((await analyticsUnsupportedMethod.json()).target).toBe("legacy");

    const analyticsSuffixFallback = await fetch(`${origin}/api/analytics/extra`);
    expect((await analyticsSuffixFallback.json()).target).toBe("legacy");

    const myWorkUnsupportedMethod = await fetch(`${origin}/api/my-work`, { method: "POST" });
    expect((await myWorkUnsupportedMethod.json()).target).toBe("legacy");

    const myWorkSuffixFallback = await fetch(`${origin}/api/my-work/extra`);
    expect((await myWorkSuffixFallback.json()).target).toBe("legacy");

    for (const [method, path] of [
      ["GET", "/api/my-work/summarize"],
      ["DELETE", "/api/my-work/summarize"],
      ["POST", "/api/my-work/summarize/extra"],
      ["POST", "/api/signals"],
      ["DELETE", "/api/signals"],
      ["GET", "/api/signals/extra"],
      ["PATCH", "/api/scim/tokens"],
      ["PUT", "/api/scim/tokens"],
      ["GET", "/api/scim/tokens/extra"],
      ["POST", "/api/sessions"],
      ["GET", "/api/sessions/not-a-uuid"],
      ["GET", "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001/events"],
      ["POST", "/api/durable-runs"],
      ["GET", "/api/durable-runs/not-a-uuid"],
      ["GET", "/api/durable-runs/aaaaaaaa-0000-4000-8000-000000000001/steps"],
      ["PUT", "/api/notifications"],
      ["PATCH", "/api/notifications"],
      ["POST", "/api/notifications/extra"],
      ["GET", "/api/notifications/extra"],
    ] as const) {
      const fallback = await fetch(`${origin}${path}`, { method });
      expect((await fallback.json()).target).toBe("legacy");
    }

    const scimRead = await fetch(`${origin}/api/scim/v2/Users?startIndex=1`);
    expect((await scimRead.json()).target).toBe("go");

    const scimReadUser = await fetch(`${origin}/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001`);
    expect((await scimReadUser.json()).target).toBe("go");

    const scimCreate = await fetch(`${origin}/api/scim/v2/Users`, {
      method: "POST",
      headers: { "content-type": "application/scim+json" },
      body: JSON.stringify({ userName: "person@example.test" }),
    });
    expect((await scimCreate.json()).target).toBe("go");

    const scimDelete = await fetch(`${origin}/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001`, { method: "DELETE" });
    expect((await scimDelete.json()).target).toBe("go");

    for (const [method, path] of [
      ["DELETE", "/api/scim/v2/Users"],
      ["PATCH", "/api/scim/v2/Users"],
      ["PUT", "/api/scim/v2/Users"],
      ["POST", "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001"],
      ["PATCH", "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001"],
      ["PUT", "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001"],
      ["GET", "/api/scim/v2/Users/not-a-uuid"],
      ["GET", "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001/extra"],
    ] as const) {
      const fallback = await fetch(`${origin}${path}`, { method });
      expect((await fallback.json()).target).toBe("legacy");
    }

    const streamed = await fetch(`${origin}/api/support/public?widget=abc`, {
      method: "POST",
      headers: { cookie: "widget=opaque", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(streamed.status).toBe(202);
    const reader = streamed.body?.getReader();
    if (!reader) throw new Error("proxied response body was unavailable");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("accepted:");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("complete");
    expect((await reader.read()).done).toBe(true);

    const unsupportedSupportMethod = await fetch(`${origin}/api/support/public?widget=abc`, { method: "PATCH" });
    expect((await unsupportedSupportMethod.json()).target).toBe("legacy");
  }, 15_000);
});
