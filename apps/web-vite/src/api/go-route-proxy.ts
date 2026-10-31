import { request as requestHTTP, type IncomingMessage, type ServerResponse } from "node:http";
import { request as requestHTTPS } from "node:https";
import type { Plugin } from "vite";
import { isGoSetupRequest } from "./go-setup-proxy.ts";

export type GoRouteProxyFlags = {
  supportPublic: boolean;
  scimRead: boolean;
  scimWrite: boolean;
  salesOrders: boolean;
  modulesRead: boolean;
  modulesWrite: boolean;
  projects: boolean;
  routines: boolean;
  memory: boolean;
  moduleSettings: boolean;
  policy: boolean;
  teamRead: boolean;
  teamWrite: boolean;
  branding: boolean;
  analytics: boolean;
  analyticsReport: boolean;
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
  crmReads: boolean;
  crmFollowUpDraft: boolean;
  supportReplyDraft: boolean;
  posRead: boolean;
  posShiftSummary: boolean;
  onboarding: boolean;
  approvalsRead: boolean;
  approvalsDecision: boolean;
};

export function goProjectsWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PROJECTS_WRITES === "1";
}

export function goPurchasingPaymentRunsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_PAYMENT_RUNS === "1";
}

export function goRouteProxyFlagsFromEnv(env: Record<string, string | undefined>): GoRouteProxyFlags {
  return {
    supportPublic: true,
    scimRead: true,
    scimWrite: true,
    salesOrders: env.CHASTE_GO_SALES_ORDERS_ROUTE !== "0",
    modulesRead: env.CHASTE_GO_MODULES_ROUTE !== "0",
    modulesWrite: true,
    projects: env.CHASTE_GO_PROJECTS_ROUTE !== "0",
    routines: true,
    memory: env.CHASTE_GO_MEMORY_ROUTE !== "0",
    moduleSettings: env.CHASTE_GO_MODULE_SETTINGS_ROUTE !== "0",
    policy: env.CHASTE_GO_POLICY_ROUTE !== "0",
    teamRead: env.CHASTE_GO_TEAM_READ_ROUTE !== "0",
    teamWrite: env.CHASTE_GO_TEAM_WRITE_ROUTE !== "0",
    branding: true,
    analytics: env.CHASTE_GO_ANALYTICS_ROUTE !== "0",
    analyticsReport: env.CHASTE_GO_ANALYTICS_REPORT_ROUTE !== "0",
    myWork: env.CHASTE_GO_MY_WORK_ROUTE !== "0",
    dashboard: env.CHASTE_GO_DASHBOARD_ROUTE !== "0",
    setup: env.CHASTE_GO_SETUP_ROUTE !== "0",
    ledger: true,
    metrics: env.CHASTE_GO_METRICS_ROUTE !== "0",
    myWorkSummary: true,
    signals: env.CHASTE_GO_SIGNALS_ROUTE !== "0",
    scimTokens: true,
    sessions: env.CHASTE_GO_SESSIONS_ROUTE !== "0",
    durableRuns: env.CHASTE_GO_DURABLE_RUNS_ROUTE !== "0",
    notifications: true,
    notificationsWrite: true,
    crmReads: env.CHASTE_GO_CRM_READS !== "0",
    crmFollowUpDraft: env.CHASTE_GO_CRM_FOLLOW_UP_DRAFT_ROUTE !== "0",
    supportReplyDraft: env.CHASTE_GO_SUPPORT_REPLY_DRAFT_ROUTE !== "0",
    posRead: true,
    posShiftSummary: true,
    onboarding: true,
    approvalsRead: env.CHASTE_GO_APPROVALS_READ_ROUTE !== "0",
    approvalsDecision: env.CHASTE_GO_APPROVALS_DECISION_ROUTE !== "0",
  };
}

export function isGoRouteRequest(flags: GoRouteProxyFlags, method?: string, url?: string): boolean {
  const path = url ?? "";
  if (/^\/api\/ai-config(?:\/[^?]*)?(?:\?.*)?$/.test(path)) return true;
  if (flags.onboarding && ["GET", "POST", "PATCH"].includes(method ?? "") && /^\/api\/onboarding(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/banking(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/accounting\/budgets(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/accounting\/(?:tax|close)(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/expenses(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/time(?:\?.*)?$/.test(path)) return true;
  if (["GET", "POST"].includes(method ?? "") && /^\/api\/(?:accounting|hr|marketing)(?:\?.*)?$/.test(path)) return true;
  if (["GET", "POST"].includes(method ?? "") && /^\/api\/email(?:\?.*)?$/.test(path)) return true;
  if (["GET", "POST", "PUT", "PATCH"].includes(method ?? "") && /^\/api\/org(?:\?.*)?$/.test(path)) return true;
  if (flags.supportPublic && method === "POST" && /^\/api\/support\/public(?:\?.*)?$/.test(path)) return true;
  if (["GET", "POST"].includes(method ?? "") && /^\/api\/support\/channels(?:\?.*)?$/.test(path)) return true;
  // These namespaces have Go handlers for their active Vite flows. Keep malformed
  // paths and unsupported methods on Go so they cannot silently invoke Next.
  if (/^\/api\/(?:branding|ledger|notifications|onboarding|support\/public|my-work|modules|scim\/tokens|scim\/v2\/Users|sessions|durable-runs|search)(?:\/[^?]*)?(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/routines(?:\/[^?]*)?(?:\?.*)?$/.test(path)) return true;
  const attachmentID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (method === "GET" && new RegExp(`^/api/go/documents/${attachmentID}/content(?:\\?.*)?$`, "i").test(path)) return true;
  // Go owns the Documents namespace in Vite. Unknown paths and methods must
  // reach Go's 404/405 handling rather than fall through to the legacy app.
  if (/^\/api\/docs(?:\/[^?]*)?(?:\?.*)?$/.test(path)) return true;
  // These endpoint namespaces are owned by Go. Route invalid IDs and methods
  // there too, so Go can return its 404/405 instead of invoking Next handlers.
  const pathname = path.split("?", 1)[0] ?? "";
  if (pathname.startsWith("/api/conversations/") && /\/(?:presence|agent-reply)(?:\/|$)/.test(pathname)) return true;
  if (pathname === "/api/message-attachments" || pathname.startsWith("/api/message-attachments/")) return true;
  // Auth has one owner in the Vite application, including unsupported methods
  // and provider routes that are disabled in Go configuration.
  if (isGoAuthRequest(path)) return true;
  const scimUserPath = /^\/api\/scim\/v2\/Users(?:\?.*)?$/;
  const scimUserItemPath = /^\/api\/scim\/v2\/Users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?.*)?$/i;
  if (flags.scimRead && method === "GET" && (scimUserPath.test(path) || scimUserItemPath.test(path))) return true;
  if (flags.scimWrite && method === "POST" && scimUserPath.test(path)) return true;
  if (flags.scimWrite && method === "DELETE" && scimUserItemPath.test(path)) return true;
  if (method === "GET" && /^\/api\/portal\/invoice\/[^/?]+(?:\?.*)?$/.test(path)) return true;
  if (method === "GET" && /^\/api\/support\/customers(?:\?.*)?$/.test(path)) return true;
  if (method === "GET" && /^\/api\/sales\/customers(?:\?.*)?$/.test(path)) return true;
  if (flags.salesOrders && method === "GET" && /^\/api\/sales(?:\?.*)?$/.test(path)) return true;
  if (method === "GET" && /^\/api\/sales\/[^/?]+(?:\?.*)?$/.test(path)) return true;
  if (flags.modulesRead && method === "GET" && /^\/api\/modules(?:\?.*)?$/.test(path)) return true;
  if (flags.modulesWrite && method === "POST" && /^\/api\/modules(?:\?.*)?$/.test(path)) return true;
  if (flags.projects && ["GET", "POST"].includes(method ?? "") && /^\/api\/projects(?:\?.*)?$/.test(path)) return true;
  if (flags.routines && ["GET", "POST"].includes(method ?? "") && /^\/api\/routines(?:\?.*)?$/.test(path)) return true;
  if (flags.memory && ["GET", "POST"].includes(method ?? "") && /^\/api\/memory(?:\?.*)?$/.test(path)) return true;
  if (flags.moduleSettings && ["GET", "POST"].includes(method ?? "") && /^\/api\/module-settings(?:\?.*)?$/.test(path)) return true;
  if (flags.policy && ["GET", "POST"].includes(method ?? "") && /^\/api\/policy(?:\?.*)?$/.test(path)) return true;
  if (flags.teamRead && method === "GET" && /^\/api\/team(?:\?.*)?$/.test(path)) return true;
  if (flags.teamWrite && method === "POST" && /^\/api\/team(?:\?.*)?$/.test(path)) return true;
  if (flags.branding && ["GET", "POST"].includes(method ?? "") && /^\/api\/branding(?:\?.*)?$/.test(path)) return true;
  if (flags.analytics && method === "GET" && /^\/api\/analytics(?:\?.*)?$/.test(path)) return true;
  if (flags.analyticsReport && method === "POST" && /^\/api\/analytics(?:\?.*)?$/.test(path)) return true;
  if (flags.myWork && method === "GET" && /^\/api\/my-work(?:\?.*)?$/.test(path)) return true;
  if (flags.myWorkSummary && method === "POST" && /^\/api\/my-work\/summarize(?:\?.*)?$/.test(path)) return true;
  if (flags.signals && /^\/api\/signals(?:\?.*)?$/.test(path)) return true;
  if (flags.scimTokens && ["GET", "POST", "DELETE"].includes(method ?? "") && /^\/api\/scim\/tokens(?:\?.*)?$/.test(path)) return true;
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (flags.sessions && method === "GET" && new RegExp(`^/api/sessions(?:/${uuid}(?:/replay)?)?(?:\\?.*)?$`, "i").test(path)) return true;
  if (flags.durableRuns && method === "GET" && new RegExp(`^/api/durable-runs(?:/${uuid})?(?:\\?.*)?$`, "i").test(path)) return true;
  if (flags.notifications && method === "GET" && /^\/api\/notifications(?:\?.*)?$/.test(path)) return true;
  if (flags.notificationsWrite && method === "POST" && /^\/api\/notifications(?:\?.*)?$/.test(path)) return true;
  if (flags.approvalsRead && method === "GET" && /^\/api\/approvals(?:\?.*)?$/.test(path)) return true;
  if (flags.approvalsDecision && method === "POST" && /^\/api\/approvals(?:\?.*)?$/.test(path)) return true;
  if (method === "GET" && /^\/api\/inventory(?:\?.*)?$/.test(path)) return true;
  if (flags.crmReads && method === "GET" && /^\/api\/customers(?:\?.*)?$/.test(path)) return true;
  if (flags.crmReads && method === "GET" && isGoCrmReadRequest(path)) return true;
  if (flags.crmFollowUpDraft && method === "POST" && /^\/api\/crm\/follow-up-draft(?:\?.*)?$/.test(path)) return true;
  if (flags.supportReplyDraft && method === "POST" && /^\/api\/support\/draft(?:\?.*)?$/.test(path)) return true;
  if (/^\/api\/pos(?:\/[^?]*)?(?:\?.*)?$/.test(path)) return true;
  if (flags.dashboard && method === "GET" && /^\/api\/dashboard(?:\?.*)?$/.test(path)) return true;
  if (flags.setup && isGoSetupRequest(method, path)) return true;
  if (flags.ledger && method === "GET" && /^\/api\/ledger(?:\?.*)?$/.test(path)) return true;
  return flags.metrics && method === "GET" && /^\/api\/metrics(?:\?.*)?$/.test(path);
}

function isGoCrmReadRequest(path: string): boolean {
  let url: URL;
  try {
    url = new URL(path, "http://vite.local");
  } catch {
    return false;
  }
  if (url.origin !== "http://vite.local" || url.pathname !== "/api/crm" || url.hash) return false;

  const params = url.searchParams;
  const selectors = ["deals", "customers", "tasks", "views", "timeline"];
  const activeSelectors = selectors.filter((key) => params.has(key));
  if (activeSelectors.length !== 1) return false;

  const selector = activeSelectors[0];
  if (!selector) return false;
  if (selector === "timeline") {
    const timelineId = params.get("timeline");
    return params.getAll("timeline").length === 1 && timelineId !== null &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(timelineId) && params.size === 1;
  }
  if (selector === "tasks") {
    return params.getAll("tasks").length === 1 && params.get("tasks") === "1" &&
      params.size === (params.has("open") ? 2 : 1) &&
      (!params.has("open") || (params.getAll("open").length === 1 && (params.get("open") === "1" || params.get("open") === "0")));
  }
  return params.getAll(selector).length === 1 && params.get(selector) === "1" && params.size === 1;
}

function isGoAuthRequest(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
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
