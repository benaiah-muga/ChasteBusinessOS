import { request as requestHTTP, type IncomingMessage, type ServerResponse } from "node:http";
import { request as requestHTTPS } from "node:https";
import type { Plugin } from "vite";
import { isGoSetupRequest } from "./go-setup-proxy.ts";

export type GoRouteProxyFlags = {
  supportPublic: boolean;
  auth: boolean;
  authOidc: boolean;
  authSaml: boolean;
  supportChannelsRead: boolean;
  supportChannelsWrite: boolean;
  scimRead: boolean;
  scimWrite: boolean;
  portalInvoice: boolean;
  salesInvoice: boolean;
  salesOrders: boolean;
  modulesRead: boolean;
  modulesWrite: boolean;
  projects: boolean;
  routines: boolean;
  teamRead: boolean;
  teamWrite: boolean;
  branding: boolean;
  analytics: boolean;
  myWork: boolean;
  dashboard: boolean;
  setup: boolean;
  ledger: boolean;
  metrics: boolean;
  myWorkSummary: boolean;
  signals: boolean;
  scimTokens: boolean;
  sessions: boolean;
  durableRuns: boolean;
  notifications: boolean;
  notificationsWrite: boolean;
  inventoryRead: boolean;
  posRead: boolean;
  posShiftSummary: boolean;
  posCustomers: boolean;
};

export function goPosOpenSessionSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_POS_OPEN_SESSION_SLICE !== "0";
}

export function goPosCloseSessionSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_POS_CLOSE_SESSION_SLICE !== "0";
}

export function goInventoryTransferWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_INVENTORY_TRANSFER_WRITES !== "0";
}

export function goInventoryLocationReservationWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_INVENTORY_LOCATION_RESERVATION_WRITES !== "0";
}

export function goPosCustomersSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_POS_CUSTOMERS_SLICE !== "0";
}

export function goRouteProxyFlagsFromEnv(env: Record<string, string | undefined>): GoRouteProxyFlags {
  return {
    supportPublic: env.CHASTE_GO_SUPPORT_PUBLIC_ROUTE === "1",
    // Go owns its explicitly implemented auth endpoints by default. Other
    // Better Auth paths and methods continue through the legacy catch-all.
    auth: env.CHASTE_GO_AUTH_ROUTE !== "0" && env.GO_AUTH_ROUTE !== "0",
    authOidc: env.CHASTE_GO_AUTH_OIDC_ROUTE === "1",
    authSaml: env.CHASTE_GO_AUTH_SAML_ROUTE === "1",
    supportChannelsRead: env.CHASTE_GO_SUPPORT_CHANNELS_ROUTE === "1",
    supportChannelsWrite: env.CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE === "1",
    scimRead: env.CHASTE_GO_SCIM_READ_ROUTE === "1",
    scimWrite: env.CHASTE_GO_SCIM_WRITE_ROUTE === "1",
    portalInvoice: env.CHASTE_GO_PORTAL_INVOICE_ROUTE === "1",
    salesInvoice: env.CHASTE_GO_SALES_INVOICE_ROUTE === "1",
    salesOrders: env.CHASTE_GO_SALES_ORDERS_ROUTE !== "0",
    modulesRead: env.CHASTE_GO_MODULES_ROUTE !== "0",
    modulesWrite: env.CHASTE_GO_MODULES_WRITE_ROUTE === "1",
    projects: env.CHASTE_GO_PROJECTS_ROUTE !== "0",
    routines: env.CHASTE_GO_ROUTINES_ROUTE === "1",
    teamRead: env.CHASTE_GO_TEAM_READ_ROUTE !== "0",
    teamWrite: env.CHASTE_GO_TEAM_WRITE_ROUTE !== "0",
    branding: env.CHASTE_GO_BRANDING_ROUTE === "1",
    analytics: env.CHASTE_GO_ANALYTICS_ROUTE !== "0",
    myWork: env.CHASTE_GO_MY_WORK_ROUTE !== "0",
    dashboard: env.CHASTE_GO_DASHBOARD_ROUTE === "1",
    setup: env.CHASTE_GO_SETUP_ROUTE === "1",
    ledger: env.CHASTE_GO_LEDGER_ROUTE === "1",
    metrics: env.CHASTE_GO_METRICS_ROUTE !== "0",
    myWorkSummary: env.CHASTE_GO_MY_WORK_SUMMARY_ROUTE === "1",
    signals: env.CHASTE_GO_SIGNALS_ROUTE === "1",
    scimTokens: env.CHASTE_GO_SCIM_TOKENS_ROUTE === "1",
    sessions: env.CHASTE_GO_SESSIONS_ROUTE !== "0",
    durableRuns: env.CHASTE_GO_DURABLE_RUNS_ROUTE !== "0",
    notifications: env.CHASTE_GO_NOTIFICATIONS_ROUTE === "1",
    notificationsWrite: env.CHASTE_GO_NOTIFICATIONS_WRITE_ROUTE === "1",
    inventoryRead: env.CHASTE_GO_INVENTORY_READ_ROUTE === "1",
    posRead: env.CHASTE_GO_POS_READ_ROUTE !== "0",
    posShiftSummary: env.CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE !== "0",
    posCustomers: goPosCustomersSliceFromEnv(env),
  };
}

export function isGoRouteRequest(flags: GoRouteProxyFlags, method?: string, url?: string): boolean {
  const path = url ?? "";
  if (flags.supportPublic && method === "POST" && /^\/api\/support\/public(?:\?.*)?$/.test(path)) return true;
  if (flags.supportChannelsRead && method === "GET" && /^\/api\/support\/channels(?:\?.*)?$/.test(path)) return true;
  if (flags.supportChannelsWrite && method === "POST" && /^\/api\/support\/channels(?:\?.*)?$/.test(path)) return true;
  if (flags.auth && isGoAuthRequest(flags, method, path)) return true;
  const scimUserPath = /^\/api\/scim\/v2\/Users(?:\?.*)?$/;
  const scimUserItemPath = /^\/api\/scim\/v2\/Users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?.*)?$/i;
  if (flags.scimRead && method === "GET" && (scimUserPath.test(path) || scimUserItemPath.test(path))) return true;
  if (flags.scimWrite && method === "POST" && scimUserPath.test(path)) return true;
  if (flags.scimWrite && method === "DELETE" && scimUserItemPath.test(path)) return true;
  if (flags.portalInvoice && method === "GET" && /^\/api\/portal\/invoice\/[^/?]+(?:\?.*)?$/.test(path)) return true;
  if (flags.salesOrders && method === "GET" && /^\/api\/sales(?:\?.*)?$/.test(path)) return true;
  if (flags.salesInvoice && method === "GET" && /^\/api\/sales\/[^/?]+(?:\?.*)?$/.test(path)) return true;
  if (flags.modulesRead && method === "GET" && /^\/api\/modules(?:\?.*)?$/.test(path)) return true;
  if (flags.modulesWrite && method === "POST" && /^\/api\/modules(?:\?.*)?$/.test(path)) return true;
  if (flags.projects && ["GET", "POST"].includes(method ?? "") && /^\/api\/projects(?:\?.*)?$/.test(path)) return true;
  if (flags.routines && ["GET", "POST"].includes(method ?? "") && /^\/api\/routines(?:\?.*)?$/.test(path)) return true;
  if (flags.teamRead && method === "GET" && /^\/api\/team(?:\?.*)?$/.test(path)) return true;
  if (flags.teamWrite && method === "POST" && /^\/api\/team(?:\?.*)?$/.test(path)) return true;
  if (flags.branding && ["GET", "POST"].includes(method ?? "") && /^\/api\/branding(?:\?.*)?$/.test(path)) return true;
  if (flags.analytics && method === "GET" && /^\/api\/analytics(?:\?.*)?$/.test(path)) return true;
  if (flags.myWork && method === "GET" && /^\/api\/my-work(?:\?.*)?$/.test(path)) return true;
  if (flags.myWorkSummary && method === "POST" && /^\/api\/my-work\/summarize(?:\?.*)?$/.test(path)) return true;
  if (flags.signals && method === "GET" && /^\/api\/signals(?:\?.*)?$/.test(path)) return true;
  if (flags.scimTokens && ["GET", "POST", "DELETE"].includes(method ?? "") && /^\/api\/scim\/tokens(?:\?.*)?$/.test(path)) return true;
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (flags.sessions && method === "GET" && new RegExp(`^/api/sessions(?:/${uuid}(?:/replay)?)?(?:\\?.*)?$`, "i").test(path)) return true;
  if (flags.durableRuns && method === "GET" && new RegExp(`^/api/durable-runs(?:/${uuid})?(?:\\?.*)?$`, "i").test(path)) return true;
  if (flags.notifications && method === "GET" && /^\/api\/notifications(?:\?.*)?$/.test(path)) return true;
  if (flags.notificationsWrite && method === "POST" && /^\/api\/notifications(?:\?.*)?$/.test(path)) return true;
  if (flags.inventoryRead && method === "GET" && /^\/api\/inventory(?:\?.*)?$/.test(path)) return true;
  if (flags.posRead && method === "GET" && /^\/api\/pos(?:\?.*)?$/.test(path)) return true;
  if (flags.posCustomers && method === "GET" && /^\/api\/pos\/customers(?:\?.*)?$/.test(path)) return true;
  if (flags.posShiftSummary && method === "POST" && /^\/api\/pos\/shift-summary(?:\?.*)?$/.test(path)) return true;
  if (flags.dashboard && method === "GET" && /^\/api\/dashboard(?:\?.*)?$/.test(path)) return true;
  if (flags.setup && isGoSetupRequest(method, path)) return true;
  if (flags.ledger && method === "GET" && /^\/api\/ledger(?:\?.*)?$/.test(path)) return true;
  return flags.metrics && method === "GET" && /^\/api\/metrics(?:\?.*)?$/.test(path);
}

function isGoAuthRequest(flags: GoRouteProxyFlags, method = "", url = ""): boolean {
  const pathname = url.split("?", 1)[0] ?? "";
  if (
    (method === "POST" && [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/api/auth/send-verification-email",
      "/api/auth/request-password-reset",
      "/api/auth/reset-password",
      "/api/auth/sign-out",
      "/api/auth/revoke-session",
      "/api/auth/revoke-sessions",
    ].includes(pathname)) ||
    ((method === "GET" || method === "POST") && pathname === "/api/auth/get-session") ||
    (method === "GET" && (
      pathname === "/api/auth/verify-email" ||
      /^\/api\/auth\/reset-password\/[^/]+$/.test(pathname)
    ))
  ) {
    return true;
  }

  if (flags.authOidc && (
    (method === "GET" && ["/api/auth/sign-in/oidc", "/api/auth/callback/oidc"].includes(pathname)) ||
    (method === "POST" && pathname === "/api/auth/native/exchange")
  )) {
    return true;
  }

  return flags.authSaml && (
    (method === "GET" && pathname === "/api/auth/sign-in/saml") ||
    (method === "POST" && pathname === "/api/auth/callback/saml")
  );
}

function sendProxyError(response: ServerResponse, error: Error): void {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  response.end("Go API proxy unavailable");
}

function forwardRequest(request: IncomingMessage, response: ServerResponse, target: URL): void {
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: request.url ?? "/",
    headers: request.headers,
  };
  const outgoing = (target.protocol === "https:" ? requestHTTPS : requestHTTP)(requestOptions, (upstream) => {
    upstream.on("error", (error) => sendProxyError(response, error));
    const status = upstream.statusCode ?? 502;
    if (upstream.statusMessage) {
      response.writeHead(status, upstream.statusMessage, upstream.headers);
    } else {
      response.writeHead(status, upstream.headers);
    }
    upstream.pipe(response);
  });
  outgoing.on("error", (error) => sendProxyError(response, error));
  request.on("aborted", () => outgoing.destroy());
  response.on("close", () => {
    if (!response.writableEnded) outgoing.destroy();
  });
  request.pipe(outgoing);
}

export function createGoRouteProxyPlugin(flags: GoRouteProxyFlags, goApiOrigin: string): Plugin {
  const target = new URL(goApiOrigin);
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) {
    throw new Error("CHASTE_GO_API_ORIGIN must be an HTTP or HTTPS origin without credentials or a path");
  }

  return {
    name: "chaste-go-route-proxy",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!isGoRouteRequest(flags, request.method, request.url)) {
          next();
          return;
        }
        forwardRequest(request, response, target);
      });
    },
  };
}
