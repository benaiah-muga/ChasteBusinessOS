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
  inventoryRead: boolean;
  crmReads: boolean;
  posRead: boolean;
  posShiftSummary: boolean;
  posCustomers: boolean;
  onboarding: boolean;
  messageAttachmentDownloads: boolean;
};

export function goPosOpenSessionSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_POS_OPEN_SESSION_SLICE !== "0";
}

export function goPosCloseSessionSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_POS_CLOSE_SESSION_SLICE !== "0";
}

export function goProjectsWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PROJECTS_WRITES === "1";
}

export function goMarketingCampaignWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MARKETING_CAMPAIGN_WRITES === "1";
}

export function goSessionCapabilityRouteFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
}

export function goInventoryTransferWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_INVENTORY_TRANSFER_WRITES !== "0";
}

export function goInventoryLocationReservationWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_INVENTORY_LOCATION_RESERVATION_WRITES !== "0";
}

export function goInventoryBarcodeLookupFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_INVENTORY_BARCODE_LOOKUP === "1";
}

export function goCrmDealStageMoveFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_DEAL_STAGE_MOVE === "1";
}

export function goCrmDealCreateFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_DEAL_CREATE === "1";
}

export function goCrmTaskWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_TASK_WRITES === "1";
}

export function goCrmCustomerCreateFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_CUSTOMER_CREATE === "1";
}

export function goCrmCustomerDeactivateFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_CUSTOMER_DEACTIVATE === "1";
}

export function goCrmCustomerMergeFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_CUSTOMER_MERGE === "1";
}

export function goCrmCustomerImportFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_CUSTOMER_IMPORT === "1";
}

export function goCrmCustomerProfileUpdateFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_CUSTOMER_PROFILE_UPDATE === "1";
}

export function goCrmViewWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_CRM_VIEW_WRITES === "1";
}

export function goPurchasingCreateOrderFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_CREATE_ORDER === "1";
}

export function goPurchasingReceiveGoodsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_RECEIVE_GOODS === "1";
}

export function goPurchasingReceiptHistoryReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_RECEIPT_HISTORY_READS === "1";
}

export function goPurchasingReturnCloseFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_RETURN_CLOSE === "1";
}

export function goPurchasingFinanceWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_FINANCE_WRITES === "1";
}

export function goPurchasingPaymentRunsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_PAYMENT_RUNS === "1";
}

export function goPurchasingSupplierStatementReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_SUPPLIER_STATEMENT_READS === "1";
}

export function goPurchasingWorkflowReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_WORKFLOW_READS === "1";
}

export function goPurchasingIntelReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_INTEL_READS === "1";
}

export function goPurchasingAPAgingReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_AP_AGING_READS === "1";
}

export function goDocumentsIngestedReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_DOCUMENT_INGESTED_READS === "1";
}

export function goDocumentsVersionReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_DOCUMENTS_VERSION_READS === "1";
}

export function goDocumentsEditorReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" &&
    env.CHASTE_GO_DOCUMENTS_EDITOR_READS === "1" &&
    env.CHASTE_GO_DOCUMENTS_VERSION_READS === "1";
}

export function goMessagingPeopleReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_PEOPLE_READS === "1";
}

export function goMessagingConversationListFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_CONVERSATION_LIST !== "0";
}

export function goMessagingThreadReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_THREAD_READ !== "0";
}

export function goMessagingReadCursorFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_READ_CURSOR !== "0";
}

export function goMessagingReactionsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_REACTIONS !== "0";
}

export function goMessagingPinsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_PINS !== "0";
}

export function goMessagingPresenceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_PRESENCE !== "0";
}

export function goMessagingAttachmentDownloadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_ATTACHMENT_DOWNLOAD !== "0";
}

export function goMessagingAttachmentDeleteFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_ATTACHMENT_DELETE !== "0";
}

export function goPurchasingSourcingWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_PURCHASING_SOURCING_WRITES === "1";
}

export function goManufacturingWorkOrderWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MANUFACTURING_WORK_ORDER_WRITES === "1";
}

export function goManufacturingDefineBomSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MANUFACTURING_DEFINE_BOM_SLICE === "1";
}

export function goManufacturingProductionWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MANUFACTURING_PRODUCTION_WRITES === "1";
}

export function goManufacturingPlanningReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MANUFACTURING_PLANNING_READS === "1";
}

export function goSalesOrderWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_SALES_ORDER_WRITES === "1";
}

export function goSalesOrderReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_SALES_ORDER_READS === "1";
}

export function goHrExpensesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_EXPENSES === "1";
}

export function goHrLeaveFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_LEAVE === "1";
}

export function goHrTimeFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_TIME === "1";
}

export function goHrPayrollFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_PAYROLL === "1";
}

export function goHrHiringFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_HIRING === "1";
}

export function goHrOverviewReportFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_OVERVIEW_REPORT_READS === "1";
}

export function goHrEmployeeWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_HR_EMPLOYEE_WRITES === "1";
}

export function goAccountingRecordPaymentFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_RECORD_PAYMENT === "1";
}

export function goAccountingCreateInvoiceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_CREATE_INVOICE === "1";
}

export function goAccountingCreditNoteFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_CREDIT_NOTE === "1";
}

export function goAccountingReverseEntryFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_REVERSE_ENTRY === "1";
}

export function goAccountingPeriodCloseReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_PERIOD_CLOSE_READS === "1";
}

export function goAccountingReportsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_REPORTS === "1";
}

export function goAccountingCustomerStatementReadsFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_ACCOUNTING_CUSTOMER_STATEMENT_READS === "1";
}

export function goBankReconciliationWritesFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_BANK_RECONCILIATION_WRITES === "1";
}

export function goPosCustomersSliceFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CHASTE_GO_POS_CUSTOMERS_SLICE !== "0";
}

export function goRouteProxyFlagsFromEnv(env: Record<string, string | undefined>): GoRouteProxyFlags {
  return {
    supportPublic: env.CHASTE_GO_SUPPORT_PUBLIC_ROUTE === "1",
    // Go owns the auth namespace by default and returns 404 or 405 for unsupported routes.
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
    analyticsReport: env.CHASTE_GO_ANALYTICS_REPORT_ROUTE === "1",
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
    crmReads: env.CHASTE_GO_CRM_READS !== "0",
    posRead: env.CHASTE_GO_POS_READ_ROUTE !== "0",
    posShiftSummary: env.CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE !== "0",
    posCustomers: goPosCustomersSliceFromEnv(env),
    onboarding: env.CHASTE_GO_ONBOARDING_ROUTE === "1",
    messageAttachmentDownloads: goMessagingAttachmentDownloadsFromEnv(env),
  };
}

export function isGoRouteRequest(flags: GoRouteProxyFlags, method?: string, url?: string): boolean {
  const path = url ?? "";
  if (flags.onboarding && method === "POST" && /^\/api\/onboarding(?:\?.*)?$/.test(path)) return true;
  if (flags.supportPublic && method === "POST" && /^\/api\/support\/public(?:\?.*)?$/.test(path)) return true;
  if (flags.supportChannelsRead && method === "GET" && /^\/api\/support\/channels(?:\?.*)?$/.test(path)) return true;
  if (flags.supportChannelsWrite && method === "POST" && /^\/api\/support\/channels(?:\?.*)?$/.test(path)) return true;
  const attachmentID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (flags.messageAttachmentDownloads && method === "GET" && new RegExp(`^/api/message-attachments/${attachmentID}(?:\\?.*)?$`, "i").test(path)) return true;
  if (flags.auth && isGoAuthRequest(path)) return true;
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
  if (flags.analyticsReport && method === "POST" && /^\/api\/analytics(?:\?.*)?$/.test(path)) return true;
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
  if (flags.crmReads && method === "GET" && isGoCrmReadRequest(path)) return true;
  if (flags.posRead && method === "GET" && /^\/api\/pos(?:\?.*)?$/.test(path)) return true;
  if (flags.posCustomers && method === "GET" && /^\/api\/pos\/customers(?:\?.*)?$/.test(path)) return true;
  if (flags.posShiftSummary && method === "POST" && /^\/api\/pos\/shift-summary(?:\?.*)?$/.test(path)) return true;
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
