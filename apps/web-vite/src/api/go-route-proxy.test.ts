import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  createGoRouteProxyPlugin,
  goPosCloseSessionSliceFromEnv,
  goInventoryTransferWritesFromEnv,
  goInventoryLocationReservationWritesFromEnv,
  goInventoryBarcodeLookupFromEnv,
  goPosCustomersSliceFromEnv,
  goPosOpenSessionSliceFromEnv,
  goRouteProxyFlagsFromEnv,
  isGoRouteRequest,
  type GoRouteProxyFlags,
} from "./go-route-proxy";

const runningServers: Array<{ close: () => Promise<void> }> = [];

describe("POS register opening Go selector", () => {
  it("enables the existing Go capability with the session route and supports rollback", () => {
    expect(goPosOpenSessionSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goPosOpenSessionSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_POS_OPEN_SESSION_SLICE: "0" })).toBe(false);
    expect(goPosOpenSessionSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("POS register closing Go selector", () => {
  it("enables the existing Go capability with the session route and supports rollback", () => {
    expect(goPosCloseSessionSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goPosCloseSessionSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_POS_CLOSE_SESSION_SLICE: "0" })).toBe(false);
    expect(goPosCloseSessionSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("inventory transfer Go selector", () => {
  it("enables transfer capabilities with the session route and supports rollback", () => {
    expect(goInventoryTransferWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goInventoryTransferWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_TRANSFER_WRITES: "0" })).toBe(false);
    expect(goInventoryTransferWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("inventory location and reservation Go selector", () => {
  it("enables the capabilities with the session route and supports rollback", () => {
    expect(goInventoryLocationReservationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goInventoryLocationReservationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_LOCATION_RESERVATION_WRITES: "0" })).toBe(false);
    expect(goInventoryLocationReservationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("inventory barcode lookup Go selector", () => {
  it("requires both the barcode selector and session capability route", () => {
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_BARCODE_LOOKUP: "1" })).toBe(true);
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_INVENTORY_BARCODE_LOOKUP: "1" })).toBe(false);
  });
});

describe("POS customer lookup Go selector", () => {
  it("enables the direct Go reader independently and supports rollback", () => {
    expect(goPosCustomersSliceFromEnv({})).toBe(true);
    expect(goPosCustomersSliceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(true);
    expect(goPosCustomersSliceFromEnv({ CHASTE_GO_POS_CUSTOMERS_SLICE: "0" })).toBe(false);
  });
});

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
  { env: "CHASTE_GO_SUPPORT_CHANNELS_ROUTE", flag: "supportChannelsRead", method: "GET", url: "/api/support/channels?view=settings" },
  { env: "CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE", flag: "supportChannelsWrite", method: "POST", url: "/api/support/channels" },
  { env: "CHASTE_GO_SCIM_READ_ROUTE", flag: "scimRead", method: "GET", url: "/api/scim/v2/Users?startIndex=1" },
  { env: "CHASTE_GO_SCIM_READ_ROUTE", flag: "scimRead", method: "GET", url: "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001" },
  { env: "CHASTE_GO_SCIM_WRITE_ROUTE", flag: "scimWrite", method: "POST", url: "/api/scim/v2/Users" },
  { env: "CHASTE_GO_SCIM_WRITE_ROUTE", flag: "scimWrite", method: "DELETE", url: "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001" },
  { env: "CHASTE_GO_PORTAL_INVOICE_ROUTE", flag: "portalInvoice", method: "GET", url: "/api/portal/invoice/token?view=1" },
  { env: "CHASTE_GO_SALES_ORDERS_ROUTE", flag: "salesOrders", method: "GET", url: "/api/sales?status=draft" },
  { env: "CHASTE_GO_SALES_INVOICE_ROUTE", flag: "salesInvoice", method: "GET", url: "/api/sales/order-id" },
  { env: "CHASTE_GO_MODULES_ROUTE", flag: "modulesRead", method: "GET", url: "/api/modules" },
  { env: "CHASTE_GO_MODULES_WRITE_ROUTE", flag: "modulesWrite", method: "POST", url: "/api/modules" },
  { env: "CHASTE_GO_BRANDING_ROUTE", flag: "branding", method: "GET", url: "/api/branding" },
  { env: "CHASTE_GO_PROJECTS_ROUTE", flag: "projects", method: "POST", url: "/api/projects" },
  { env: "CHASTE_GO_ROUTINES_ROUTE", flag: "routines", method: "GET", url: "/api/routines" },
  { env: "CHASTE_GO_ROUTINES_ROUTE", flag: "routines", method: "POST", url: "/api/routines" },
  { env: "CHASTE_GO_TEAM_READ_ROUTE", flag: "teamRead", method: "GET", url: "/api/team" },
  { env: "CHASTE_GO_TEAM_WRITE_ROUTE", flag: "teamWrite", method: "POST", url: "/api/team" },
  { env: "CHASTE_GO_BRANDING_ROUTE", flag: "branding", method: "POST", url: "/api/branding" },
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
  { env: "CHASTE_GO_POS_READ_ROUTE", flag: "posRead", method: "GET", url: "/api/pos?status=open" },
  { env: "CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE", flag: "posShiftSummary", method: "POST", url: "/api/pos/shift-summary" },
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

  it("routes implemented Go auth, work queue, and analytics reads by default", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(flags.auth).toBe(true);
    expect(flags.analytics).toBe(true);
    expect(flags.myWork).toBe(true);
    expect(Object.entries(flags).filter(([key]) => !["auth", "analytics", "myWork", "metrics", "modulesRead", "projects", "teamRead", "teamWrite", "sessions", "durableRuns", "salesOrders", "posRead", "posShiftSummary", "posCustomers"].includes(key)).every(([, enabled]) => !enabled)).toBe(true);
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
    expect(isGoRouteRequest(flags, "GET", "/api/sessions")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/durable-runs")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/notifications")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics?dataset=analytics.invoiceAging")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(flags, "DELETE", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work?status=open")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work")).toBe(false);
  });

  it("allows the analytics read proxy to be disabled for rollback", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_ANALYTICS_ROUTE: "0" });
    expect(flags.analytics).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics")).toBe(false);
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

  it.each(selectorCases)("routes $flag requests when enabled", ({ env, flag, method, url }) => {
    const flags = goRouteProxyFlagsFromEnv({ [env]: "1" });
    expect(flags[flag]).toBe(true);
    expect(isGoRouteRequest(flags, method, url)).toBe(true);
  });

  it("keeps the modules write selector POST-only and exact", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_MODULES_ROUTE: "0", CHASTE_GO_MODULES_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "POST", "/api/modules")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/modules")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/modules/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/modules/")).toBe(false);
  });

  it("keeps support channel read and write selectors separate and exact", () => {
    const readFlags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SUPPORT_CHANNELS_ROUTE: "1" });
    expect(isGoRouteRequest(readFlags, "GET", "/api/support/channels?view=settings")).toBe(true);
    expect(isGoRouteRequest(readFlags, "POST", "/api/support/channels")).toBe(false);
    expect(isGoRouteRequest(readFlags, "GET", "/api/support/channels/extra")).toBe(false);
    expect(isGoRouteRequest(readFlags, "GET", "/api/support/channels/")).toBe(false);

    const writeFlags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(writeFlags, "POST", "/api/support/channels?source=settings")).toBe(true);
    expect(isGoRouteRequest(writeFlags, "GET", "/api/support/channels")).toBe(false);
    expect(isGoRouteRequest(writeFlags, "PUT", "/api/support/channels")).toBe(false);
    expect(isGoRouteRequest(writeFlags, "POST", "/api/support/channels/extra")).toBe(false);
    expect(isGoRouteRequest(writeFlags, "POST", "/api/support/channels/")).toBe(false);

    const rolledBack = goRouteProxyFlagsFromEnv({ CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE: "0" });
    expect(isGoRouteRequest(rolledBack, "POST", "/api/support/channels")).toBe(false);
  });

  it("keeps branding selection limited to exact GET and POST requests", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_BRANDING_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "GET", "/api/branding")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/branding")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/branding")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/branding/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/branding/")).toBe(false);
  });

  it("keeps the signals selector GET-only and exact", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SIGNALS_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "GET", "/api/signals?severity=orange&module=sales")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/signals")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/signals/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/signals/")).toBe(false);
  });

  it("routes My Work through Go by default, GET-only and exact, with a legacy opt-out", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/my-work?status=open")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/summarize")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/")).toBe(false);

    const legacyFlags = goRouteProxyFlagsFromEnv({ CHASTE_GO_MY_WORK_ROUTE: "0" });
    expect(isGoRouteRequest(legacyFlags, "GET", "/api/my-work")).toBe(false);
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

  it("routes only GET /api/inventory to Go and leaves writes and nested paths on legacy", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_INVENTORY_READ_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "GET", "/api/inventory")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/inventory?sku=MUG-1")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/inventory")).toBe(false);
    expect(isGoRouteRequest(flags, "PATCH", "/api/inventory")).toBe(false);
    expect(isGoRouteRequest(flags, "HEAD", "/api/inventory")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/inventory/history")).toBe(false);
    expect(isGoRouteRequest(goRouteProxyFlagsFromEnv({}), "GET", "/api/inventory")).toBe(false);
  });

  it("routes only exact GET /api/pos requests when the POS read selector is enabled", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_READ_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "GET", "/api/pos")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/pos?status=open")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/pos")).toBe(false);
    expect(isGoRouteRequest(flags, "PUT", "/api/pos")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_READ_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/pos")).toBe(false);
  });

  it("routes POS reads by default and allows explicit rollback", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.posRead).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/pos")).toBe(true);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_READ_ROUTE: "0" });
    expect(disabled.posRead).toBe(false);
    expect(isGoRouteRequest(disabled, "GET", "/api/pos")).toBe(false);
  });

  it("routes only the dedicated POS shift-summary POST under the Vite selector", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE: "1", GO_POS_SHIFT_SUMMARY_ROUTE: "1" });
    expect(flags.posShiftSummary).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/pos/shift-summary")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/shift-summary")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/pos/shift-summary/extra")).toBe(false);

    const viteDisabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE: "0", GO_POS_SHIFT_SUMMARY_ROUTE: "1" });
    expect(viteDisabled.posShiftSummary).toBe(false);
    const goUnmounted = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE: "1", GO_POS_SHIFT_SUMMARY_ROUTE: "0" });
    expect(goUnmounted.posShiftSummary).toBe(true);
  });

  it("routes only the exact POS customer GET independently of the generic capability route", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" });
    expect(flags.posCustomers).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/customers")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/customers?active=1")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/pos/customers")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/customers/extra")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_CUSTOMERS_SLICE: "0" });
    expect(disabled.posCustomers).toBe(false);
    expect(isGoRouteRequest(disabled, "GET", "/api/pos/customers")).toBe(false);
  });

  it("keeps SCIM read and write selectors independent", () => {
    const userPath = "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001";
    const readOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_READ_ROUTE: "1" });
    expect(isGoRouteRequest(readOnly, "GET", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", userPath)).toBe(true);
    expect(isGoRouteRequest(readOnly, "POST", "/api/scim/v2/Users")).toBe(false);
    expect(isGoRouteRequest(readOnly, "DELETE", userPath)).toBe(false);
    expect(isGoRouteRequest(readOnly, "GET", `${userPath}/extra`)).toBe(false);
    expect(isGoRouteRequest(readOnly, "GET", `${userPath}/`)).toBe(false);
    expect(isGoRouteRequest(readOnly, "GET", "/api/scim/v2/Users/not-a-uuid")).toBe(false);
    expect(isGoRouteRequest(readOnly, "PATCH", userPath)).toBe(false);
    expect(isGoRouteRequest(readOnly, "HEAD", "/api/scim/v2/Users")).toBe(false);

    const writeOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(writeOnly, "GET", "/api/scim/v2/Users")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "GET", userPath)).toBe(false);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "DELETE", userPath)).toBe(true);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users/extra")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users/")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "DELETE", `${userPath}/extra`)).toBe(false);
    expect(isGoRouteRequest(writeOnly, "DELETE", `${userPath}/`)).toBe(false);
    expect(isGoRouteRequest(writeOnly, "DELETE", "/api/scim/v2/Users/not-a-uuid")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "PUT", userPath)).toBe(false);
  });

  it("routes project operations and module switchboard reads to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(defaults, "GET", "/api/projects")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/projects")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/modules")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/modules")).toBe(false);
    expect(isGoRouteRequest(defaults, "HEAD", "/api/projects")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/projects/extra")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_PROJECTS_ROUTE: "0", CHASTE_GO_MODULES_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/projects")).toBe(false);
    expect(isGoRouteRequest(disabled, "POST", "/api/projects")).toBe(false);
    expect(isGoRouteRequest(disabled, "GET", "/api/modules")).toBe(false);
  });

  it("routes only the sales order collection GET to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.salesOrders).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales?status=draft")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/sales")).toBe(false);
    expect(isGoRouteRequest(defaults, "HEAD", "/api/sales")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/extra/parts")).toBe(false);

    const rolledBack = goRouteProxyFlagsFromEnv({ CHASTE_GO_SALES_ORDERS_ROUTE: "0" });
    expect(isGoRouteRequest(rolledBack, "GET", "/api/sales")).toBe(false);
    expect(isGoRouteRequest(rolledBack, "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001")).toBe(false);
  });

  it("keeps team read and write selectors independent and exact", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(defaults, "GET", "/api/team")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/team")).toBe(true);

    const readOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_TEAM_READ_ROUTE: "1", CHASTE_GO_TEAM_WRITE_ROUTE: "0" });
    expect(isGoRouteRequest(readOnly, "GET", "/api/team")).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", "/api/team?view=members")).toBe(true);
    expect(isGoRouteRequest(readOnly, "POST", "/api/team")).toBe(false);
    expect(isGoRouteRequest(readOnly, "GET", "/api/team/invite")).toBe(false);

    const writeOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_TEAM_READ_ROUTE: "0", CHASTE_GO_TEAM_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(writeOnly, "POST", "/api/team")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "GET", "/api/team")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "PATCH", "/api/team")).toBe(false);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/team/invite")).toBe(false);
  });

  it("keeps sessions and durable-runs selectors independent and exact", () => {
    const sessionItem = "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001";
    const runsItem = "/api/durable-runs/aaaaaaaa-0000-4000-8000-000000000001";
    const sessionsOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "1", CHASTE_GO_DURABLE_RUNS_ROUTE: "0" });
    expect(isGoRouteRequest(sessionsOnly, "GET", "/api/sessions?limit=10")).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", `${sessionItem}?include=events`)).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", `${sessionItem}/replay`)).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", "/api/durable-runs")).toBe(false);
    expect(isGoRouteRequest(sessionsOnly, "GET", runsItem)).toBe(false);

    const durableRunsOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "0", CHASTE_GO_DURABLE_RUNS_ROUTE: "1" });
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

  it("enables session and durable-run reads by default and allows explicit rollback", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(defaults, "GET", "/api/sessions")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/durable-runs")).toBe(true);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "0", CHASTE_GO_DURABLE_RUNS_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/sessions")).toBe(false);
    expect(isGoRouteRequest(disabled, "GET", "/api/durable-runs")).toBe(false);
  });

  it("routes metrics reads by default and allows rollback", () => {
    const metrics = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(metrics, "GET", "/api/metrics")).toBe(true);
    expect(isGoRouteRequest(metrics, "POST", "/api/metrics")).toBe(false);
    expect(isGoRouteRequest(metrics, "HEAD", "/api/metrics")).toBe(false);
    expect(isGoRouteRequest(metrics, "GET", "/api/metrics/extra")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_METRICS_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/metrics")).toBe(false);
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
      CHASTE_GO_SUPPORT_CHANNELS_ROUTE: "1",
      CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE: "1",
      CHASTE_GO_SCIM_READ_ROUTE: "1",
      CHASTE_GO_SCIM_WRITE_ROUTE: "1",
      CHASTE_GO_PORTAL_INVOICE_ROUTE: "1",
      CHASTE_GO_SALES_INVOICE_ROUTE: "1",
      CHASTE_GO_MODULES_ROUTE: "1",
      CHASTE_GO_MODULES_WRITE_ROUTE: "1",
      CHASTE_GO_BRANDING_ROUTE: "1",
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
      CHASTE_GO_POS_READ_ROUTE: "1",
      CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1",
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

    const supportChannels = await fetch(`${origin}/api/support/channels?view=settings`);
    expect((await supportChannels.json())).toMatchObject({ target: "go", method: "GET", url: "/api/support/channels?view=settings" });

    const supportChannelsWrite = await fetch(`${origin}/api/support/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ greeting: "Hello" }),
    });
    expect((await supportChannelsWrite.json())).toMatchObject({ target: "go", method: "POST", url: "/api/support/channels" });

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
      target: "legacy",
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

    const portalSuffixFallback = await fetch(`${origin}/api/portal/invoice/token/extra`);
    expect((await portalSuffixFallback.json()).target).toBe("legacy");

    const salesOrders = await fetch(`${origin}/api/sales?status=draft`);
    expect((await salesOrders.json())).toMatchObject({ target: "go", method: "GET", url: "/api/sales?status=draft" });

    const salesOrdersUnsupportedMethod = await fetch(`${origin}/api/sales`, { method: "POST" });
    expect((await salesOrdersUnsupportedMethod.json()).target).toBe("legacy");

    for (const path of ["/api/sales/", "/api/sales/extra/parts"]) {
      const fallback = await fetch(`${origin}${path}`);
      expect((await fallback.json()).target).toBe("legacy");
    }

    const salesInvoice = await fetch(`${origin}/api/sales/aaaaaaaa-0000-4000-8000-000000000001?print=1`);
    expect((await salesInvoice.json()).target).toBe("go");

    for (const path of [
      "/api/sales/aaaaaaaa-0000-4000-8000-000000000001/extra",
      "/api/sales/aaaaaaaa-0000-4000-8000-000000000001/",
    ]) {
      const fallback = await fetch(`${origin}${path}`);
      expect((await fallback.json()).target).toBe("legacy");
    }

    const salesInvoiceUnsupportedMethod = await fetch(`${origin}/api/sales/aaaaaaaa-0000-4000-8000-000000000001`, { method: "POST" });
    expect((await salesInvoiceUnsupportedMethod.json()).target).toBe("legacy");

    const posRead = await fetch(`${origin}/api/pos?status=open`, { headers: { cookie: "auth-session=browser" } });
    expect((await posRead.json())).toMatchObject({ target: "go", method: "GET", url: "/api/pos?status=open", cookie: "auth-session=browser" });

    const posCustomers = await fetch(`${origin}/api/pos/customers?active=1`, { headers: { cookie: "auth-session=browser" } });
    expect((await posCustomers.json())).toMatchObject({ target: "go", method: "GET", url: "/api/pos/customers?active=1", cookie: "auth-session=browser" });

    const posCustomersUnsupportedMethod = await fetch(`${origin}/api/pos/customers`, { method: "POST" });
    expect((await posCustomersUnsupportedMethod.json())).toMatchObject({ target: "legacy", method: "POST" });

    const posUnsupportedMethod = await fetch(`${origin}/api/pos`, { method: "POST" });
    expect((await posUnsupportedMethod.json())).toMatchObject({ target: "legacy", method: "POST" });

    const posSuffixFallback = await fetch(`${origin}/api/pos/extra`);
    expect((await posSuffixFallback.json())).toMatchObject({ target: "legacy", method: "GET" });

    const modulesRead = await fetch(`${origin}/api/modules`);
    expect((await modulesRead.json()).target).toBe("go");

    const modulesWrite = await fetch(`${origin}/api/modules`, { method: "POST" });
    expect((await modulesWrite.json()).target).toBe("go");

    const modulesWriteSuffix = await fetch(`${origin}/api/modules/extra`, { method: "POST" });
    expect((await modulesWriteSuffix.json()).target).toBe("legacy");

    const brandingRead = await fetch(`${origin}/api/branding`);
    expect((await brandingRead.json()).target).toBe("go");

    const brandingWrite = await fetch(`${origin}/api/branding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accentColor: "#AABBCC", layout: "modern" }),
    });
    expect((await brandingWrite.json()).target).toBe("go");

    for (const path of ["/api/branding/extra", "/api/branding/"]) {
      const fallback = await fetch(`${origin}${path}`);
      expect((await fallback.json()).target).toBe("legacy");
    }

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
      ["GET", "/api/my-work/"],
      ["DELETE", "/api/my-work/summarize"],
      ["POST", "/api/my-work/summarize/extra"],
      ["POST", "/api/signals"],
      ["DELETE", "/api/signals"],
      ["GET", "/api/signals/extra"],
      ["GET", "/api/signals/"],
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

    const supportSuffixFallback = await fetch(`${origin}/api/support/public/extra`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", token: "test-token" }),
    });
    expect((await supportSuffixFallback.json()).target).toBe("legacy");
  }, 15_000);
});
