import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createViteServer, loadConfigFromFile, type ViteDevServer } from "vite";
import {
  createGoRouteProxyPlugin,
  goSupportInboxReadsFromEnv,
  goSupportLibraryReadsFromEnv,
  goSupportCannedResponseWriteFromEnv,
  goSupportKbArticleWriteFromEnv,
  goSupportConversationWritesFromEnv,
  goSupportTicketWritesFromEnv,
  goMarketingCampaignWritesFromEnv,
  goMarketingOverviewReadsFromEnv,
  goProjectsWritesFromEnv,
  goInventoryTransferWritesFromEnv,
  goInventoryLocationReservationWritesFromEnv,
  goInventoryBarcodeLookupFromEnv,
  goCrmDealStageMoveFromEnv,
  goCrmLeadConversionFromEnv,
  goCrmDealCreateFromEnv,
  goCrmCustomerCreateFromEnv,
  goCrmCustomerDeactivateFromEnv,
  goCrmCustomerImportFromEnv,
  goCrmCustomerMergeFromEnv,
  goCrmCustomerProfileUpdateFromEnv,
  goPurchasingCreateOrderFromEnv,
  goPurchasingReceiveGoodsFromEnv,
  goPurchasingReturnCloseFromEnv,
  goPurchasingFinanceWritesFromEnv,
  goPurchasingPaymentRunsFromEnv,
  goPurchasingAPAgingReadsFromEnv,
  goMessagingConversationListFromEnv,
  goMessagingConversationCreateFromEnv,
  goMessagingConversationUpdateFromEnv,
  goMessagingConversationArchiveFromEnv,
  goMessagingConversationLeaveFromEnv,
  goMessagingConversationAddMemberFromEnv,
  goMessagingConversationDeleteFromEnv,
  goMessagingThreadReadsFromEnv,
  goMessagingReadCursorFromEnv,
  goMessagingReactionsFromEnv,
  goMessagingPinsFromEnv,
  goMessagingAttachmentUploadFromEnv,
  goMessagingAttachmentDeleteFromEnv,
  goPurchasingSupplierStatementReadsFromEnv,
  goPurchasingWorkflowReadsFromEnv,
  goPurchasingIntelReadsFromEnv,
  goPurchasingSourcingWritesFromEnv,
  goSalesOrderReadsFromEnv,
  goSalesOrderWritesFromEnv,
  goHrExpensesFromEnv,
  goHrHiringFromEnv,
  goHrEmployeeWritesFromEnv,
  goHrPayrollFromEnv,
  goAccountingRecordPaymentFromEnv,
  goAccountingCreateInvoiceFromEnv,
  goAccountingCreditNoteFromEnv,
  goAccountingReverseEntryFromEnv,
  goBankReconciliationWritesFromEnv,
  goRouteProxyFlagsFromEnv,
  isGoRouteRequest,
  type GoRouteProxyFlags,
} from "./go-route-proxy";

const runningServers: Array<{ close: () => Promise<void> }> = [];

describe("Projects write selector", () => {
  it("requires both the Projects write selector and the session capability route", () => {
    expect(goProjectsWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PROJECTS_WRITES: "1" })).toBe(true);
    expect(goProjectsWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PROJECTS_WRITES: "1" })).toBe(false);
    expect(goProjectsWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PROJECTS_WRITES: "0" })).toBe(false);
  });
});

describe("Marketing campaign Go selector", () => {
  it("requires both campaign writes and the session capability route, with proxy selector opt-out", () => {
    expect(goMarketingCampaignWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MARKETING_CAMPAIGN_WRITES: "1" })).toBe(true);
    expect(goMarketingCampaignWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MARKETING_CAMPAIGN_WRITES: "0" })).toBe(false);
    expect(goMarketingCampaignWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MARKETING_CAMPAIGN_WRITES: "1" })).toBe(false);
    expect(goMarketingCampaignWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
  });
});

describe("Marketing overview Go selector", () => {
  it("defaults to Go with the session route and allows an explicit proxy selector opt-out", () => {
    expect(goMarketingOverviewReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MARKETING_OVERVIEW_READS: "1" })).toBe(true);
    expect(goMarketingOverviewReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MARKETING_OVERVIEW_READS: "0" })).toBe(false);
    expect(goMarketingOverviewReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MARKETING_OVERVIEW_READS: "1" })).toBe(false);
    expect(goMarketingOverviewReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
  });
});

describe("inventory transfer Go selector", () => {
  it("enables transfer capabilities with the session route and supports selector opt-out", () => {
    expect(goInventoryTransferWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goInventoryTransferWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_TRANSFER_WRITES: "0" })).toBe(false);
    expect(goInventoryTransferWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("inventory location and reservation Go selector", () => {
  it("enables the capabilities with the session route and supports selector opt-out", () => {
    expect(goInventoryLocationReservationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goInventoryLocationReservationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_LOCATION_RESERVATION_WRITES: "0" })).toBe(false);
    expect(goInventoryLocationReservationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("inventory barcode lookup Go selector", () => {
  it("uses Go by default when the session capability route is enabled", () => {
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_BARCODE_LOOKUP: "1" })).toBe(true);
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_INVENTORY_BARCODE_LOOKUP: "0" })).toBe(false);
    expect(goInventoryBarcodeLookupFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_INVENTORY_BARCODE_LOOKUP: "1" })).toBe(false);
  });
});

describe("CRM deal stage Go selector", () => {
  it("requires both the deal-stage selector and session capability route", () => {
    expect(goCrmDealStageMoveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_DEAL_STAGE_MOVE: "1" })).toBe(true);
    expect(goCrmDealStageMoveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmDealStageMoveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_DEAL_STAGE_MOVE: "1" })).toBe(false);
  });
});

describe("CRM lead conversion Go selector", () => {
  it("defaults on with the session capability route and supports explicit proxy selector opt-out", () => {
    expect(goCrmLeadConversionFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goCrmLeadConversionFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_LEAD_CONVERSION: "1" })).toBe(true);
    expect(goCrmLeadConversionFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_LEAD_CONVERSION: "0" })).toBe(false);
    expect(goCrmLeadConversionFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("CRM deal create Go selector", () => {
  it("requires both the deal-create selector and session capability route", () => {
    expect(goCrmDealCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_DEAL_CREATE: "1" })).toBe(true);
    expect(goCrmDealCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmDealCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_DEAL_CREATE: "1" })).toBe(false);
  });
});

describe("CRM customer create Go selector", () => {
  it("requires both the customer create selector and session capability route", () => {
    expect(goCrmCustomerCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_CUSTOMER_CREATE: "1" })).toBe(true);
    expect(goCrmCustomerCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmCustomerCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_CUSTOMER_CREATE: "1" })).toBe(false);
  });
});

describe("CRM customer deactivation Go selector", () => {
  it("requires both the deactivation selector and session capability route", () => {
    expect(goCrmCustomerDeactivateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_CUSTOMER_DEACTIVATE: "1" })).toBe(true);
    expect(goCrmCustomerDeactivateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmCustomerDeactivateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_CUSTOMER_DEACTIVATE: "1" })).toBe(false);
  });
});

describe("CRM customer merge Go selector", () => {
  it("requires both the merge selector and session capability route", () => {
    expect(goCrmCustomerMergeFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_CUSTOMER_MERGE: "1" })).toBe(true);
    expect(goCrmCustomerMergeFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmCustomerMergeFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_CUSTOMER_MERGE: "1" })).toBe(false);
  });
});

describe("CRM customer import Go selector", () => {
  it("requires both the import selector and session capability route", () => {
    expect(goCrmCustomerImportFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_CUSTOMER_IMPORT: "1" })).toBe(true);
    expect(goCrmCustomerImportFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmCustomerImportFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_CUSTOMER_IMPORT: "1" })).toBe(false);
  });
});

describe("CRM customer profile update Go selector", () => {
  it("requires both the profile selector and session capability route", () => {
    expect(goCrmCustomerProfileUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_CRM_CUSTOMER_PROFILE_UPDATE: "1" })).toBe(true);
    expect(goCrmCustomerProfileUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goCrmCustomerProfileUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_CRM_CUSTOMER_PROFILE_UPDATE: "1" })).toBe(false);
  });
});

describe("HR expenses Go selector", () => {
  it("requires the paired session capability route and explicit expenses selector", () => {
    expect(goHrExpensesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_EXPENSES: "1" })).toBe(true);
    expect(goHrExpensesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goHrExpensesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_EXPENSES: "0" })).toBe(false);
    expect(goHrExpensesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_HR_EXPENSES: "1" })).toBe(false);
  });
});

describe("HR Payroll Go selector", () => {
  it("requires the payroll selector and session capability route", () => {
    expect(goHrPayrollFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_PAYROLL: "1" })).toBe(true);
    expect(goHrPayrollFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goHrPayrollFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_PAYROLL: "0" })).toBe(false);
    expect(goHrPayrollFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_HR_PAYROLL: "1" })).toBe(false);
  });
});

describe("HR Hiring Go selector", () => {
  it("requires the Hiring selector and session capability route", () => {
    expect(goHrHiringFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_HIRING: "1" })).toBe(true);
    expect(goHrHiringFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goHrHiringFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_HIRING: "0" })).toBe(false);
    expect(goHrHiringFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_HR_HIRING: "1" })).toBe(false);
  });
});

describe("HR employee write Go selector", () => {
  it("requires both the employee write selector and session capability route", () => {
    expect(goHrEmployeeWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_EMPLOYEE_WRITES: "1" })).toBe(true);
    expect(goHrEmployeeWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goHrEmployeeWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_HR_EMPLOYEE_WRITES: "0" })).toBe(false);
    expect(goHrEmployeeWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_HR_EMPLOYEE_WRITES: "1" })).toBe(false);
  });
});

describe("accounting invoice payment Go selector", () => {
  it("requires both the payment selector and session capability route", () => {
    expect(goAccountingRecordPaymentFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_RECORD_PAYMENT: "1" })).toBe(true);
    expect(goAccountingRecordPaymentFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goAccountingRecordPaymentFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_RECORD_PAYMENT: "0" })).toBe(false);
    expect(goAccountingRecordPaymentFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_ACCOUNTING_RECORD_PAYMENT: "1" })).toBe(false);
  });
});

describe("accounting invoice creation Go selector", () => {
  it("requires both the create invoice selector and session capability route", () => {
    expect(goAccountingCreateInvoiceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_CREATE_INVOICE: "1" })).toBe(true);
    expect(goAccountingCreateInvoiceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goAccountingCreateInvoiceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_CREATE_INVOICE: "0" })).toBe(false);
    expect(goAccountingCreateInvoiceFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_ACCOUNTING_CREATE_INVOICE: "1" })).toBe(false);
  });
});

describe("accounting credit note Go selector", () => {
  it("requires both the credit note selector and session capability route", () => {
    expect(goAccountingCreditNoteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_CREDIT_NOTE: "1" })).toBe(true);
    expect(goAccountingCreditNoteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goAccountingCreditNoteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_CREDIT_NOTE: "0" })).toBe(false);
    expect(goAccountingCreditNoteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_ACCOUNTING_CREDIT_NOTE: "1" })).toBe(false);
  });
});

describe("accounting reverse entry Go selector", () => {
  it("requires both the reversal selector and session capability route", () => {
    expect(goAccountingReverseEntryFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_REVERSE_ENTRY: "1" })).toBe(true);
    expect(goAccountingReverseEntryFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goAccountingReverseEntryFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_ACCOUNTING_REVERSE_ENTRY: "0" })).toBe(false);
    expect(goAccountingReverseEntryFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_ACCOUNTING_REVERSE_ENTRY: "1" })).toBe(false);
  });
});

describe("bank reconciliation Go selector", () => {
  it("requires both bank reconciliation writes and the session capability route", () => {
    expect(goBankReconciliationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_BANK_RECONCILIATION_WRITES: "1" })).toBe(true);
    expect(goBankReconciliationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goBankReconciliationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_BANK_RECONCILIATION_WRITES: "0" })).toBe(false);
    expect(goBankReconciliationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_BANK_RECONCILIATION_WRITES: "1" })).toBe(false);
  });
});

describe("purchase order creation Go selector", () => {
  it("requires both the PO selector and session capability route", () => {
    expect(goPurchasingCreateOrderFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_CREATE_ORDER: "1" })).toBe(true);
    expect(goPurchasingCreateOrderFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingCreateOrderFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_CREATE_ORDER: "1" })).toBe(false);
  });
});

describe("purchase receipt Go selector", () => {
  it("requires both the receiving selector and session capability route", () => {
    expect(goPurchasingReceiveGoodsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_RECEIVE_GOODS: "1" })).toBe(true);
    expect(goPurchasingReceiveGoodsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingReceiveGoodsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_RECEIVE_GOODS: "1" })).toBe(false);
  });
});

describe("purchase return and close Go selector", () => {
  it("requires the paired selector and session capability route", () => {
    expect(goPurchasingReturnCloseFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_RETURN_CLOSE: "1" })).toBe(true);
    expect(goPurchasingReturnCloseFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingReturnCloseFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_RETURN_CLOSE: "1" })).toBe(false);
  });
});

describe("purchase finance Go selector", () => {
  it("requires the finance selector and session capability route", () => {
    expect(goPurchasingFinanceWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_FINANCE_WRITES: "1" })).toBe(true);
    expect(goPurchasingFinanceWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingFinanceWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_FINANCE_WRITES: "1" })).toBe(false);
  });
});

describe("purchase payment run Go selector", () => {
  it("requires the payment run selector and session capability route", () => {
    expect(goPurchasingPaymentRunsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_PAYMENT_RUNS: "1" })).toBe(true);
    expect(goPurchasingPaymentRunsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingPaymentRunsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_PAYMENT_RUNS: "1" })).toBe(false);
  });
});

describe("Purchasing A/P aging Go selector", () => {
  it("requires the A/P aging selector and session capability route", () => {
    expect(goPurchasingAPAgingReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_AP_AGING_READS: "1" })).toBe(true);
    expect(goPurchasingAPAgingReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingAPAgingReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_AP_AGING_READS: "1" })).toBe(false);
  });
});

describe("authored document assist Go route", () => {
  it("keeps the entire Documents namespace inside Go, including unsupported paths", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "POST", "/api/docs/assist")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/docs/assist?mode=chat")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/docs/assist")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/docs/assist/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/docs/assistant")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/docs")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/docs/invalid/path")).toBe(true);
    expect(isGoRouteRequest(flags, "PUT", "/api/docs/not-a-uuid/workspace/")).toBe(true);
    expect(isGoRouteRequest(flags, "OPTIONS", "/api/docs/anything")).toBe(true);
  });
});

describe("authored document editor workspace Go route", () => {
  it("always routes workspace POST and DELETE requests so Go can validate document IDs", () => {
    const documentId = "6f1b2c3d-0000-4000-8000-000000000001";
    const enabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_DOCUMENTS_EDITOR_WORKSPACE: "0" });
    const path = `/api/docs/${documentId}/workspace`;
    expect(isGoRouteRequest(enabled, "POST", path)).toBe(true);
    expect(isGoRouteRequest(enabled, "DELETE", path)).toBe(true);
    for (const [method, url] of [
      ["GET", path], ["PUT", path], ["POST", `/api/docs/${documentId}/versions`],
    ]) expect(isGoRouteRequest(enabled, method, url)).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", `${path}?draft=1`)).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", `${path}/`)).toBe(true);
    expect(isGoRouteRequest(enabled, "DELETE", `${path}/unexpected/segment`)).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", `/api/docs/invalid/path/${documentId}/workspace/`)).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", "/api/docs/not-a-uuid/workspace")).toBe(true);
  });
});

describe("messaging conversation-list Go selector", () => {
  it("requires session capability routing and defaults on with an explicit selector opt-out", () => {
    expect(goMessagingConversationListFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationListFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_LIST: "0" })).toBe(false);
    expect(goMessagingConversationListFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("messaging conversation-create Go selector", () => {
  it("requires session capability routing, defaults on, and supports its own explicit selector opt-out", () => {
    expect(goMessagingConversationCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_CREATE: "0" })).toBe(false);
    expect(goMessagingConversationCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_CONVERSATION_CREATE: "1" })).toBe(false);
    expect(goMessagingConversationCreateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_LIST: "0" })).toBe(true);
  });
});

describe("messaging conversation-update Go selector", () => {
  it("requires session capability routing, defaults on, and supports its own selector opt-out", () => {
    expect(goMessagingConversationUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_UPDATE: "0" })).toBe(false);
    expect(goMessagingConversationUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_CONVERSATION_UPDATE: "1" })).toBe(false);
    expect(goMessagingConversationUpdateFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_CREATE: "0" })).toBe(true);
  });
});

describe("messaging conversation-archive Go selector", () => {
  it("requires session capability routing, defaults on, and supports its own selector opt-out", () => {
    expect(goMessagingConversationArchiveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationArchiveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_ARCHIVE: "0" })).toBe(false);
    expect(goMessagingConversationArchiveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_CONVERSATION_ARCHIVE: "1" })).toBe(false);
    expect(goMessagingConversationArchiveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_UPDATE: "0" })).toBe(true);
  });
});

describe("messaging conversation-leave Go selector", () => {
  it("requires session capability routing, defaults on, and supports its own selector opt-out", () => {
    expect(goMessagingConversationLeaveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationLeaveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_LEAVE: "0" })).toBe(false);
    expect(goMessagingConversationLeaveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_CONVERSATION_LEAVE: "1" })).toBe(false);
    expect(goMessagingConversationLeaveFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_ARCHIVE: "0" })).toBe(true);
  });
});

describe("messaging conversation-add-member Go selector", () => {
  it("requires session capability routing, defaults on, and supports its own selector opt-out", () => {
    expect(goMessagingConversationAddMemberFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationAddMemberFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_ADD_MEMBER: "0" })).toBe(false);
    expect(goMessagingConversationAddMemberFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_CONVERSATION_ADD_MEMBER: "1" })).toBe(false);
    expect(goMessagingConversationAddMemberFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_LEAVE: "0" })).toBe(true);
  });
});

describe("messaging conversation-delete Go selector", () => {
  it("requires session capability routing, defaults on, and supports its own selector opt-out", () => {
    expect(goMessagingConversationDeleteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingConversationDeleteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_CONVERSATION_DELETE: "0" })).toBe(false);
    expect(goMessagingConversationDeleteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_CONVERSATION_DELETE: "1" })).toBe(false);
  });
});

describe("messaging thread-read Go selector", () => {
  it("requires session capability routing and defaults on with an explicit selector opt-out", () => {
    expect(goMessagingThreadReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingThreadReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_THREAD_READ: "0" })).toBe(false);
    expect(goMessagingThreadReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" })).toBe(false);
  });
});

describe("messaging read-cursor Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goMessagingReadCursorFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingReadCursorFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_READ_CURSOR: "0" })).toBe(false);
    expect(goMessagingReadCursorFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_READ_CURSOR: "1" })).toBe(false);
  });
});

describe("messaging reaction Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goMessagingReactionsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingReactionsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_REACTIONS: "0" })).toBe(false);
    expect(goMessagingReactionsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_REACTIONS: "1" })).toBe(false);
  });
});

describe("messaging pin Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goMessagingPinsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingPinsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_PINS: "0" })).toBe(false);
    expect(goMessagingPinsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_PINS: "1" })).toBe(false);
  });
});

describe("messaging session routes", () => {
  it("keeps Go ownership of conversation presence and agent reply paths for invalid IDs and methods", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" });
    const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(isGoRouteRequest(flags, "GET", `/api/conversations/${conversationId}/presence`)).toBe(true);
    expect(isGoRouteRequest(flags, "GET", `/api/conversations/${conversationId}/presence?refresh=1`)).toBe(true);
    expect(isGoRouteRequest(flags, "POST", `/api/conversations/${conversationId}/presence`)).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", `/api/conversations/${conversationId}/presence`)).toBe(true);
    expect(isGoRouteRequest(flags, "PUT", `/api/conversations/${conversationId}/presence`)).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/conversations/not-a-uuid/presence")).toBe(true);
    expect(isGoRouteRequest(flags, "PATCH", "/api/conversations/not-a-uuid/agent-reply")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/conversations/" + conversationId + "/presence/")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/conversations/" + conversationId + "/presence/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/conversations/" + conversationId + "/agent-reply/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/conversations//presence")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", `/api/conversations/${conversationId}/messages`)).toBe(false);
    expect(isGoRouteRequest(flags, "POST", `/api/conversations/${conversationId}/agent-reply`)).toBe(true);
    expect(isGoRouteRequest(flags, "GET", `/api/conversations/${conversationId}/agent-reply`)).toBe(true);
  });
});

describe("messaging attachment upload Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goMessagingAttachmentUploadFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingAttachmentUploadFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_ATTACHMENT_UPLOAD: "0" })).toBe(false);
    expect(goMessagingAttachmentUploadFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_ATTACHMENT_UPLOAD: "1" })).toBe(false);
  });
});

describe("Support inbox Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goSupportInboxReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goSupportInboxReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SUPPORT_INBOX_READS: "0" })).toBe(false);
    expect(goSupportInboxReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SUPPORT_INBOX_READS: "1" })).toBe(false);
  });
});

describe("Support library Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goSupportLibraryReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goSupportLibraryReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SUPPORT_LIBRARY_READS: "0" })).toBe(false);
    expect(goSupportLibraryReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SUPPORT_LIBRARY_READS: "1" })).toBe(false);
  });
});

describe("Support canned-response write Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goSupportCannedResponseWriteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goSupportCannedResponseWriteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SUPPORT_CANNED_RESPONSE_WRITE: "0" })).toBe(false);
    expect(goSupportCannedResponseWriteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SUPPORT_CANNED_RESPONSE_WRITE: "1" })).toBe(false);
  });
});

describe("Support knowledge article Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goSupportKbArticleWriteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goSupportKbArticleWriteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SUPPORT_KB_ARTICLE_WRITE: "0" })).toBe(false);
    expect(goSupportKbArticleWriteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SUPPORT_KB_ARTICLE_WRITE: "1" })).toBe(false);
  });
});

describe("Support conversation writes Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goSupportConversationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goSupportConversationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SUPPORT_CONVERSATION_WRITES: "0" })).toBe(false);
    expect(goSupportConversationWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SUPPORT_CONVERSATION_WRITES: "1" })).toBe(false);
  });
});

describe("Support ticket writes Go selector", () => {
  it("requires session capability routing, defaults on, and supports an explicit selector opt-out", () => {
    expect(goSupportTicketWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goSupportTicketWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SUPPORT_TICKET_WRITES: "0" })).toBe(false);
    expect(goSupportTicketWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SUPPORT_TICKET_WRITES: "1" })).toBe(false);
  });
});

describe("messaging pending attachment delete Go selector", () => {
  it("requires session capability routing, defaults on, and supports explicit selector opt-out", () => {
    expect(goMessagingAttachmentDeleteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(true);
    expect(goMessagingAttachmentDeleteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_MESSAGING_ATTACHMENT_DELETE: "0" })).toBe(false);
    expect(goMessagingAttachmentDeleteFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_MESSAGING_ATTACHMENT_DELETE: "1" })).toBe(false);
  });
});

describe("purchasing supplier statement read Go selector", () => {
  it("requires the supplier statement selector and session capability route", () => {
    expect(goPurchasingSupplierStatementReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_SUPPLIER_STATEMENT_READS: "1" })).toBe(true);
    expect(goPurchasingSupplierStatementReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingSupplierStatementReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_SUPPLIER_STATEMENT_READS: "0" })).toBe(false);
    expect(goPurchasingSupplierStatementReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_SUPPLIER_STATEMENT_READS: "1" })).toBe(false);
  });
});

describe("purchasing workflow read Go selector", () => {
  it("requires both the workflow selector and the session capability route", () => {
    expect(goPurchasingWorkflowReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_WORKFLOW_READS: "1" })).toBe(true);
    expect(goPurchasingWorkflowReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingWorkflowReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_WORKFLOW_READS: "0" })).toBe(false);
    expect(goPurchasingWorkflowReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_WORKFLOW_READS: "1" })).toBe(false);
  });
});

describe("purchasing intel read Go selector", () => {
  it("requires the Intel selector and session capability route", () => {
    expect(goPurchasingIntelReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_INTEL_READS: "1" })).toBe(true);
    expect(goPurchasingIntelReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingIntelReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_INTEL_READS: "0" })).toBe(false);
    expect(goPurchasingIntelReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_INTEL_READS: "1" })).toBe(false);
  });
});

describe("purchase sourcing Go selector", () => {
  it("requires the sourcing selector and session capability route", () => {
    expect(goPurchasingSourcingWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_PURCHASING_SOURCING_WRITES: "1" })).toBe(true);
    expect(goPurchasingSourcingWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goPurchasingSourcingWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_PURCHASING_SOURCING_WRITES: "1" })).toBe(false);
  });
});

describe("sales order write Go selector", () => {
  it("requires both the sales write selector and session capability route", () => {
    expect(goSalesOrderWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SALES_ORDER_WRITES: "1" })).toBe(true);
    expect(goSalesOrderWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goSalesOrderWritesFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SALES_ORDER_WRITES: "1" })).toBe(false);
  });
});

describe("sales order read Go selector", () => {
  it("requires both the sales read selector and session capability route", () => {
    expect(goSalesOrderReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1", CHASTE_GO_SALES_ORDER_READS: "1" })).toBe(true);
    expect(goSalesOrderReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" })).toBe(false);
    expect(goSalesOrderReadsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0", CHASTE_GO_SALES_ORDER_READS: "1" })).toBe(false);
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
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        host: request.headers.host,
        range: request.headers.range,
        ifRange: request.headers["if-range"],
        idempotencyKey: request.headers["idempotency-key"],
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
  });
}

const selectorCases: Array<{ env: string; flag: keyof GoRouteProxyFlags; method: string; url: string }> = [
  { env: "CHASTE_GO_SUPPORT_PUBLIC_ROUTE", flag: "supportPublic", method: "POST", url: "/api/support/public?widget=1" },
  { env: "CHASTE_GO_APPROVALS_DECISION_ROUTE", flag: "approvalsDecision", method: "POST", url: "/api/approvals?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  { env: "CHASTE_GO_AUTH_ROUTE", flag: "auth", method: "POST", url: "/api/auth/sign-in/email" },
  { env: "CHASTE_GO_SCIM_READ_ROUTE", flag: "scimRead", method: "GET", url: "/api/scim/v2/Users?startIndex=1" },
  { env: "CHASTE_GO_SCIM_READ_ROUTE", flag: "scimRead", method: "GET", url: "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001" },
  { env: "CHASTE_GO_SCIM_WRITE_ROUTE", flag: "scimWrite", method: "POST", url: "/api/scim/v2/Users" },
  { env: "CHASTE_GO_SCIM_WRITE_ROUTE", flag: "scimWrite", method: "DELETE", url: "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001" },
  { env: "CHASTE_GO_SALES_ORDERS_ROUTE", flag: "salesOrders", method: "GET", url: "/api/sales?status=draft" },
  { env: "CHASTE_GO_MODULES_ROUTE", flag: "modulesRead", method: "GET", url: "/api/modules" },
  { env: "CHASTE_GO_MODULES_WRITE_ROUTE", flag: "modulesWrite", method: "POST", url: "/api/modules" },
  { env: "CHASTE_GO_BRANDING_ROUTE", flag: "branding", method: "GET", url: "/api/branding" },
  { env: "CHASTE_GO_PROJECTS_ROUTE", flag: "projects", method: "POST", url: "/api/projects" },
  { env: "CHASTE_GO_ROUTINES_ROUTE", flag: "routines", method: "GET", url: "/api/routines" },
  { env: "CHASTE_GO_ROUTINES_ROUTE", flag: "routines", method: "POST", url: "/api/routines" },
  { env: "CHASTE_GO_MEMORY_ROUTE", flag: "memory", method: "GET", url: "/api/memory?q=ledger" },
  { env: "CHASTE_GO_MEMORY_ROUTE", flag: "memory", method: "POST", url: "/api/memory" },
  { env: "CHASTE_GO_MODULE_SETTINGS_ROUTE", flag: "moduleSettings", method: "GET", url: "/api/module-settings?module=inventory" },
  { env: "CHASTE_GO_MODULE_SETTINGS_ROUTE", flag: "moduleSettings", method: "POST", url: "/api/module-settings" },
  { env: "CHASTE_GO_POLICY_ROUTE", flag: "policy", method: "GET", url: "/api/policy" },
  { env: "CHASTE_GO_POLICY_ROUTE", flag: "policy", method: "POST", url: "/api/policy" },
  { env: "CHASTE_GO_TEAM_READ_ROUTE", flag: "teamRead", method: "GET", url: "/api/team" },
  { env: "CHASTE_GO_TEAM_WRITE_ROUTE", flag: "teamWrite", method: "POST", url: "/api/team" },
  { env: "CHASTE_GO_BRANDING_ROUTE", flag: "branding", method: "POST", url: "/api/branding" },
  { env: "CHASTE_GO_MY_WORK_ROUTE", flag: "myWork", method: "GET", url: "/api/my-work?status=open" },
  { env: "CHASTE_GO_DASHBOARD_ROUTE", flag: "dashboard", method: "GET", url: "/api/dashboard" },
  { env: "CHASTE_GO_SETUP_ROUTE", flag: "setup", method: "GET", url: "/api/setup?source=dashboard" },
  { env: "CHASTE_GO_LEDGER_ROUTE", flag: "ledger", method: "GET", url: "/api/ledger" },
  { env: "CHASTE_GO_METRICS_ROUTE", flag: "metrics", method: "GET", url: "/api/metrics" },
  { env: "CHASTE_GO_MY_WORK_SUMMARY_ROUTE", flag: "myWorkSummary", method: "POST", url: "/api/my-work/summarize?scope=mine" },
  { env: "CHASTE_GO_CRM_FOLLOW_UP_DRAFT_ROUTE", flag: "crmFollowUpDraft", method: "POST", url: "/api/crm/follow-up-draft?source=customer" },
  { env: "CHASTE_GO_SUPPORT_REPLY_DRAFT_ROUTE", flag: "supportReplyDraft", method: "POST", url: "/api/support/draft" },
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
  { env: "CHASTE_GO_ONBOARDING_ROUTE", flag: "onboarding", method: "POST", url: "/api/onboarding" },
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
  it("routes the Banking REST contract to Go for every method on its exact path", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(isGoRouteRequest(defaults, method, "/api/banking")).toBe(true);
    }
    expect(isGoRouteRequest(defaults, "GET", "/api/banking?view=workspace")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/banking/extra")).toBe(false);
  });

  it("routes the migrated accounting, expenses, and time APIs to Go", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    for (const [path, methods] of [
      ["/api/accounting/budgets", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
      ["/api/accounting/tax", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
      ["/api/accounting/close", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
      ["/api/expenses", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
      ["/api/time", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
    ] as const) {
      for (const method of methods) {
        expect(isGoRouteRequest(defaults, method, path)).toBe(true);
      }
      expect(isGoRouteRequest(defaults, "GET", `${path}?probe=1`)).toBe(true);
      expect(isGoRouteRequest(defaults, "GET", `${path}/extra`)).toBe(false);
    }
  });

  it("always routes email status and sends to Go", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    for (const method of ["GET", "POST"]) {
      expect(isGoRouteRequest(defaults, method, "/api/email")).toBe(true);
    }

    const configured = goRouteProxyFlagsFromEnv({ GO_EMAIL_ROUTE: "0" });
    expect(isGoRouteRequest(configured, "GET", "/api/email?view=settings")).toBe(true);
    expect(isGoRouteRequest(configured, "POST", "/api/email")).toBe(true);
    expect(isGoRouteRequest(configured, "HEAD", "/api/email")).toBe(false);
    expect(isGoRouteRequest(configured, "PUT", "/api/email")).toBe(false);
    expect(isGoRouteRequest(configured, "GET", "/api/email/test")).toBe(false);
  });

  it.each(["http://127.0.0.1:8080/api", "http://user:secret@127.0.0.1:8080", "http://127.0.0.1:8080/?tenant=one"])(
    "rejects a non-origin Go API target: %s",
    (target) => {
      expect(() => createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), target))
        .toThrow("CHASTE_GO_API_ORIGIN must be an HTTP or HTTPS origin without credentials or a path");
    },
  );

  it("sends Vite's catch-all API proxy to the same Go origin as health and capabilities", async () => {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "test" },
      resolve(process.cwd(), "vite.config.ts"),
    );
    expect(loaded).not.toBeNull();
    const proxy = loaded?.config.server?.proxy as Record<string, { target?: string }>;
    expect(proxy["/api"]?.target).toBe(proxy["/api/health"]?.target);
    expect(proxy["/api"]?.target).toBe(proxy["/api/capabilities/execute"]?.target);
  });

  it("routes unknown API paths to Go without contacting the legacy recorder", async () => {
    let goCalls = 0;
    let legacyCalls = 0;
    const go = createHttpServer((request, response) => {
      goCalls += 1;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ target: "go", method: request.method, url: request.url }));
    });
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });
    const legacy = createHttpServer((_request, response) => {
      legacyCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ target: "legacy" }));
    });
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve())) });

    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/not-a-real-route?probe=catch-all`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      target: "go",
      method: "GET",
      url: "/api/not-a-real-route?probe=catch-all",
    });
    expect(goCalls).toBe(1);
    expect(legacyCalls).toBe(0);
    expect(legacyOrigin).not.toBe(goOrigin);
  });

  it("preserves email request and response data on Go even when a stale rollback env var is set", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });

    const createEmailServer = async (env: Record<string, string | undefined>) => {
      const vite: ViteDevServer = await createViteServer({
        configFile: false,
        appType: "custom",
        plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv(env), goOrigin)],
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          proxy: { "/api": { target: goOrigin, changeOrigin: false } },
        },
      });
      await vite.listen();
      runningServers.push({ close: () => vite.close() });
      const address = vite.httpServer?.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}`;
    };

    const defaultOrigin = await createEmailServer({});
    const read = await fetch(`${defaultOrigin}/api/email?view=status`);
    expect(await read.json()).toMatchObject({ target: "go", method: "GET", url: "/api/email?view=status", body: "" });
    expect(read.headers.get("set-cookie")).toContain("proxy-result=preserved");

    const body = JSON.stringify({ action: "test", recipient: "person@example.test" });
    const write = await fetch(`${defaultOrigin}/api/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(await write.json()).toMatchObject({ target: "go", method: "POST", url: "/api/email", body });

    const configuredOrigin = await createEmailServer({ GO_EMAIL_ROUTE: "0" });
    for (const method of ["GET", "POST"] as const) {
      const response = await fetch(`${configuredOrigin}/api/email`, method === "POST" ? { method, body: "{}" } : { method });
      expect(await response.json()).toMatchObject({ target: "go", method, url: "/api/email" });
    }
  });

  it("routes implemented Go auth, dashboard, work queue, and analytics requests by default", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(flags.auth).toBe(true);
    expect(flags.analytics).toBe(true);
    expect(flags.analyticsReport).toBe(true);
    expect(flags.myWork).toBe(true);
    expect(flags.dashboard).toBe(true);
    expect(flags.setup).toBe(true);
    expect(flags.routines).toBe(true);
    expect(flags.memory).toBe(true);
    expect(flags.moduleSettings).toBe(true);
    expect(flags.onboarding).toBe(true);
    expect(Object.entries(flags).filter(([key]) => !["auth", "analytics", "analyticsReport", "myWork", "dashboard", "metrics", "modulesRead", "modulesWrite", "projects", "routines", "memory", "moduleSettings", "policy", "teamRead", "teamWrite", "sessions", "durableRuns", "salesOrders", "crmReads", "crmFollowUpDraft", "supportReplyDraft", "posRead", "posShiftSummary", "setup", "approvalsRead", "approvalsDecision", "supportPublic", "branding", "ledger", "myWorkSummary", "signals", "notifications", "notificationsWrite", "onboarding", "scimRead", "scimWrite", "scimTokens"].includes(key)).every(([, enabled]) => !enabled)).toBe(true);
    for (const { method, url } of supportedGoAuthRoutes) {
      expect(isGoRouteRequest(flags, method, url), `${method} ${url}`).toBe(true);
    }
    expect(isGoRouteRequest(flags, "POST", "/api/auth/sign-in/social")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/change-password")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/auth/get-session")).toBe(true);
    expect(isGoRouteRequest(flags, "OPTIONS", "/api/auth/get-session")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/reset-password")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/reset-password/token/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/auth/sign-in/oidc")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/auth/callback/saml")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/auth")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/authentication/get-session")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/setup")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/setup?source=dashboard")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/setup")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/setup/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/dashboard")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/dashboard?range=year")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/routines")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/routines")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/memory?q=ledger")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/memory")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/module-settings?module=inventory")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/module-settings")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/ai-config")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/ai-config?source=workspace")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/ai-config")).toBe(true);
    expect(isGoRouteRequest(flags, "PUT", "/api/ai-config")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/ai-config")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/ai-config/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/policy")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/policy?source=settings")).toBe(true);
    expect(isGoRouteRequest(flags, "PUT", "/api/policy")).toBe(false);
    expect(isGoRouteRequest(flags, "DELETE", "/api/policy")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/policy/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/support/public")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/sessions")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/durable-runs")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/notifications")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/notifications")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics?dataset=analytics.invoiceAging")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/analytics")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work?status=open")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work")).toBe(true);
  });

  it("routes only the setup checklist GET to Go by default and supports selector opt-out", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.setup).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/setup")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/setup?source=dashboard")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/setup")).toBe(false);
    expect(isGoRouteRequest(defaults, "PATCH", "/api/setup")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/setup/extra")).toBe(false);

    const rolledBack = goRouteProxyFlagsFromEnv({ CHASTE_GO_SETUP_ROUTE: "0" });
    expect(rolledBack.setup).toBe(false);
    expect(isGoRouteRequest(rolledBack, "GET", "/api/setup")).toBe(false);
  });

  it("routes only the dashboard GET to Go by default and supports selector opt-out", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.dashboard).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/dashboard")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/dashboard?range=year")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/dashboard")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/dashboard/extra")).toBe(false);

    const rolledBack = goRouteProxyFlagsFromEnv({ CHASTE_GO_DASHBOARD_ROUTE: "0" });
    expect(rolledBack.dashboard).toBe(false);
    expect(isGoRouteRequest(rolledBack, "GET", "/api/dashboard")).toBe(false);
  });

  it("routes the entire AI config namespace to Go without a Next fallback selector", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(isGoRouteRequest(defaults, method, "/api/ai-config")).toBe(true);
      expect(isGoRouteRequest(defaults, method, "/api/ai-config/extra")).toBe(true);
    }
    const formerOptOut = goRouteProxyFlagsFromEnv({ CHASTE_GO_AI_CONFIG_ROUTE: "0" });
    expect(isGoRouteRequest(formerOptOut, "GET", "/api/ai-config")).toBe(true);
    expect(isGoRouteRequest(formerOptOut, "POST", "/api/ai-config")).toBe(true);
  });

  it("forwards AI config reads and credential writes to Go without hitting the legacy proxy", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });
    const legacy = requestRecorder("legacy");
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve())) });

    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({ CHASTE_GO_AI_CONFIG_ROUTE: "0" }), goOrigin)],
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
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = "auth.session=verified-browser-session; chaste.active-org=organization-id";

    const read = await fetch(`${baseUrl}/api/ai-config?source=workspace`, { headers: { cookie } });
    expect(await read.json()).toMatchObject({
      target: "go",
      method: "GET",
      url: "/api/ai-config?source=workspace",
      cookie,
    });

    const intentId = "aaaaaaaa-0000-4000-8000-000000000001";
    const write = await fetch(`${baseUrl}/api/ai-config`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "nvidia", apiKey: "proof-only-key", intentId }),
    });
    expect(await write.json()).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/ai-config",
      cookie,
      body: JSON.stringify({ provider: "nvidia", apiKey: "proof-only-key", intentId }),
    });

    const unsupported = await fetch(`${baseUrl}/api/ai-config`, { method: "DELETE", headers: { cookie } });
    expect(await unsupported.json()).toMatchObject({ target: "go", method: "DELETE", url: "/api/ai-config" });
  });

  it("allows explicit proxy selector opt-out for analytics discovery, preview, and report generation", () => {
    const flags = goRouteProxyFlagsFromEnv({
      CHASTE_GO_ANALYTICS_ROUTE: "0",
      CHASTE_GO_ANALYTICS_REPORT_ROUTE: "0",
    });
    expect(isGoRouteRequest(flags, "GET", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics?dataset=analytics.pipelineByStage")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/analytics")).toBe(false);
  });

  it("keeps Go ownership of message attachment paths for invalid IDs and methods", () => {
    const defaults = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" });
    const href = "/api/message-attachments/aaaaaaaa-0000-4000-8000-000000000001";
    expect(isGoRouteRequest(defaults, "GET", href)).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", `${href}?download=1`)).toBe(true);
    for (const [method, path] of [
      ["HEAD", href],
      ["POST", href],
      ["GET", "/api/message-attachments/not-a-uuid"],
    ]) {
      expect(isGoRouteRequest(defaults, method, path)).toBe(true);
    }
    expect(isGoRouteRequest(defaults, "GET", `${href}/extra`)).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", `${href}/`)).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/message-attachments/")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/message-attachments")).toBe(true);
    expect(isGoRouteRequest(goRouteProxyFlagsFromEnv({}), "GET", href)).toBe(true);
  });

  it("routes uploaded document content GETs to Go without a legacy selector", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    const contentPath = "/api/go/documents/aaaaaaaa-0000-4000-8000-000000000001/content";
    expect(isGoRouteRequest(flags, "GET", contentPath)).toBe(true);
    expect(isGoRouteRequest(flags, "GET", `${contentPath}?download=1`)).toBe(true);
    for (const [method, path] of [
      ["HEAD", contentPath],
      ["POST", contentPath],
      ["GET", "/api/go/documents/not-a-uuid/content"],
      ["GET", `${contentPath}/extra`],
      ["GET", "/api/go/documents/aaaaaaaa-0000-4000-8000-000000000001/content/"],
    ]) {
      expect(isGoRouteRequest(flags, method, path)).toBe(false);
    }
  });

  it("routes exact approvals GET and POST requests through Go with independent selector opt-outs", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.approvalsRead).toBe(true);
    expect(defaults.approvalsDecision).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/approvals")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/approvals?state=pending")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/approvals?id=approval-id")).toBe(true);
    expect(isGoRouteRequest(defaults, "HEAD", "/api/approvals")).toBe(false);
    expect(isGoRouteRequest(defaults, "PUT", "/api/approvals?id=approval-id")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/approvals/extra")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/approvals/")).toBe(false);
    expect(isGoRouteRequest(defaults, "POST", "/api/approvals/extra?id=approval-id")).toBe(false);

    const readRollback = goRouteProxyFlagsFromEnv({ CHASTE_GO_APPROVALS_READ_ROUTE: "0" });
    expect(isGoRouteRequest(readRollback, "GET", "/api/approvals")).toBe(false);
    expect(isGoRouteRequest(readRollback, "POST", "/api/approvals?id=approval-id")).toBe(true);
    const decisionRollback = goRouteProxyFlagsFromEnv({ CHASTE_GO_APPROVALS_DECISION_ROUTE: "0" });
    expect(isGoRouteRequest(decisionRollback, "GET", "/api/approvals")).toBe(true);
    expect(isGoRouteRequest(decisionRollback, "POST", "/api/approvals?id=approval-id")).toBe(false);
  });

  it("preserves the approvals GET and POST session, query, and decision body through Go", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });


    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;

    const read = await fetch(`http://127.0.0.1:${address.port}/api/approvals?state=pending`, {
      headers: { cookie: "auth.session=verified-browser-session; chaste.active-org=organization-id" },
    });
    expect(await read.json()).toMatchObject({
      target: "go",
      method: "GET",
      url: "/api/approvals?state=pending",
      cookie: "auth.session=verified-browser-session; chaste.active-org=organization-id",
    });

    const decision = await fetch(`http://127.0.0.1:${address.port}/api/approvals?id=approval-id`, {
      method: "POST",
      headers: { cookie: "auth.session=verified-browser-session", "content-type": "application/json", origin: `http://127.0.0.1:${address.port}` },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(await decision.json()).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/approvals?id=approval-id",
      cookie: "auth.session=verified-browser-session",
      origin: `http://127.0.0.1:${address.port}`,
      body: JSON.stringify({ decision: "approve" }),
    });

    const selectorOptOutVite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({ CHASTE_GO_APPROVALS_DECISION_ROUTE: "0" }), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await selectorOptOutVite.listen();
    runningServers.push({ close: () => selectorOptOutVite.close() });
    const selectorOptOutAddress = selectorOptOutVite.httpServer?.address() as AddressInfo;
    const selectorOptOutResponse = await fetch(`http://127.0.0.1:${selectorOptOutAddress.port}/api/approvals?id=approval-id`, {
      method: "POST",
      headers: { cookie: "auth.session=verified-browser-session", "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(await selectorOptOutResponse.json()).toMatchObject({ target: "go", method: "POST", url: "/api/approvals?id=approval-id" });
  });

  it("sends exact authored-document workspace POST and DELETE requests to Go before the legacy API proxy", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });


    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const documentId = "6f1b2c3d-0000-4000-8000-000000000001";
    const path = `/api/docs/${documentId}/workspace`;
    const cookie = "auth.session=verified-browser-session; chaste.active-org=organization-id";
    const tick = JSON.stringify({
      content: { type: "doc", content: [] },
      pageSettings: { size: "A4", orientation: "portrait", margin: "normal" },
      rev: 3,
      intentId: "workspace-tick-id",
    });

    const save = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { cookie, origin: `http://127.0.0.1:${address.port}`, "content-type": "application/json" },
      body: tick,
    });
    expect(await save.json()).toMatchObject({ target: "go", method: "POST", url: path, cookie, origin: `http://127.0.0.1:${address.port}`, body: tick });

    const release = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "DELETE",
      headers: { cookie, origin: `http://127.0.0.1:${address.port}` },
    });
    expect(await release.json()).toMatchObject({ target: "go", method: "DELETE", url: path, cookie, origin: `http://127.0.0.1:${address.port}` });

    const unsupported = await fetch(`http://127.0.0.1:${address.port}/api/docs/not-a-uuid/workspace`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: tick,
    });
    expect(await unsupported.json()).toMatchObject({ target: "go", method: "POST", url: "/api/docs/not-a-uuid/workspace" });

    const unsupportedMethod = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { cookie } });
    expect(await unsupportedMethod.json()).toMatchObject({ target: "go", method: "GET", url: path });
  });

  it("preserves the attachment href, session identity, and range headers when proxying to Go", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });


    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "1" }), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const href = "/api/message-attachments/aaaaaaaa-0000-4000-8000-000000000001";

    const response = await fetch(`http://127.0.0.1:${address.port}${href}`, {
      headers: {
        cookie: "session=authenticated-user",
        authorization: "Bearer caller-token",
        range: "bytes=0-31",
        "if-range": '"attachment-etag"',
      },
    });
    const payload = await response.json() as {
      target: string;
      method: string;
      url: string;
      cookie: string;
      authorization: string;
      range: string;
      ifRange: string;
    };
    expect(payload).toMatchObject({
      target: "go",
      method: "GET",
      url: href,
      cookie: "session=authenticated-user",
      authorization: "Bearer caller-token",
      range: "bytes=0-31",
      ifRange: '"attachment-etag"',
    });
  });

  it("proxies uploaded document content directly to Go, never the legacy API", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });


    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const href = "/api/go/documents/aaaaaaaa-0000-4000-8000-000000000001/content";
    const cookie = "better-auth.session_token=verified-session";
    const response = await fetch(`http://127.0.0.1:${address.port}${href}`, { headers: { cookie } });

    expect(await response.json()).toMatchObject({ target: "go", method: "GET", url: href, cookie });
  });

  it("routes onboarding reads and writes to Go regardless of the retired selector", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.onboarding).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/onboarding")).toBe(true);

    const enabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_ONBOARDING_ROUTE: "1" });
    expect(isGoRouteRequest(enabled, "GET", "/api/onboarding")).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", "/api/onboarding?source=wizard")).toBe(true);
    expect(isGoRouteRequest(enabled, "PATCH", "/api/onboarding")).toBe(true);
    expect(isGoRouteRequest(enabled, "PUT", "/api/onboarding")).toBe(true);
    expect(isGoRouteRequest(enabled, "DELETE", "/api/onboarding")).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", "/api/onboarding/extra")).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", "/api/onboarding/")).toBe(true);
    const staleRollback = goRouteProxyFlagsFromEnv({ CHASTE_GO_ONBOARDING_ROUTE: "0" });
    expect(isGoRouteRequest(staleRollback, "GET", "/api/onboarding")).toBe(true);
    expect(isGoRouteRequest(staleRollback, "POST", "/api/onboarding")).toBe(true);
    expect(isGoRouteRequest(staleRollback, "PATCH", "/api/onboarding")).toBe(true);
  });

  it("routes exact organization GET, POST, PUT, and PATCH requests to Go regardless of environment flags", () => {
    for (const env of [{}, { CHASTE_GO_ORG_ROUTE: "1" }, { CHASTE_GO_ORG_ROUTE: "0" }]) {
      const flags = goRouteProxyFlagsFromEnv(env);
      expect(isGoRouteRequest(flags, "GET", "/api/org")).toBe(true);
      expect(isGoRouteRequest(flags, "GET", "/api/org?source=workspace")).toBe(true);
      expect(isGoRouteRequest(flags, "POST", "/api/org")).toBe(true);
      expect(isGoRouteRequest(flags, "PATCH", "/api/org")).toBe(true);
      expect(isGoRouteRequest(flags, "PATCH", "/api/org?tab=persona")).toBe(true);
      expect(isGoRouteRequest(flags, "PUT", "/api/org")).toBe(true);
      expect(isGoRouteRequest(flags, "DELETE", "/api/org")).toBe(false);
      expect(isGoRouteRequest(flags, "GET", "/api/org/extra")).toBe(false);
      expect(isGoRouteRequest(flags, "POST", "/api/org/extra")).toBe(false);
      expect(isGoRouteRequest(flags, "PUT", "/api/org/extra")).toBe(false);
      expect(isGoRouteRequest(flags, "PATCH", "/api/org/extra")).toBe(false);
    }
  });

  it("preserves browser cookies and origin for Go-owned organization requests", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });


    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({}), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/org`, {
      headers: {
        cookie: "auth.session=authenticated-user; chaste.active-org=organization-id",
        origin: "http://127.0.0.1:3000",
      },
    });
    const payload = await response.json() as {
      target: string;
      method: string;
      url: string;
      cookie: string;
      origin: string;
    };
    expect(payload).toMatchObject({
      target: "go",
      method: "GET",
      url: "/api/org",
      cookie: "auth.session=authenticated-user; chaste.active-org=organization-id",
      origin: "http://127.0.0.1:3000",
    });

    const switched = await fetch(`http://127.0.0.1:${address.port}/api/org`, {
      method: "POST",
      headers: {
        cookie: "auth.session=authenticated-user",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ orgId: "organization-id" }),
    });
    const switchedPayload = await switched.json() as {
      target: string;
      method: string;
      cookie: string;
      origin: string;
      body: string;
    };
    expect(switchedPayload).toMatchObject({
      target: "go",
      method: "POST",
      cookie: "auth.session=authenticated-user",
      origin: "http://127.0.0.1:3000",
      body: JSON.stringify({ orgId: "organization-id" }),
    });
    expect(switched.headers.get("set-cookie")).toContain("proxy-result=preserved");

    for (const request of [
      { method: "PUT", path: "/api/org", target: "go" },
      { method: "PATCH", path: "/api/org", target: "go" },
      { method: "DELETE", path: "/api/org", target: "go" },
      { method: "PATCH", path: "/api/org/extra", target: "go" },
      { method: "GET", path: "/api/org/extra", target: "go" },
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, { method: request.method });
      const payload = await response.json() as { target: string; method: string; url: string };
      expect(payload).toMatchObject({ target: request.target, method: request.method, url: request.path });
    }
  });

  it("allows the analytics read selector to be disabled independently of the Go catch-all", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_ANALYTICS_ROUTE: "0" });
    expect(flags.analytics).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/analytics")).toBe(false);
  });

  it("routes exact analytics report POSTs by default and allows explicit selector opt-out", () => {
    const disabled = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(disabled, "POST", "/api/analytics")).toBe(true);

    const enabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_ANALYTICS_REPORT_ROUTE: "1" });
    expect(isGoRouteRequest(enabled, "POST", "/api/analytics")).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", "/api/analytics?format=html")).toBe(true);
    expect(isGoRouteRequest(enabled, "GET", "/api/analytics")).toBe(true);
    expect(isGoRouteRequest(enabled, "DELETE", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(enabled, "POST", "/api/analytics/extra")).toBe(false);

    const readDisabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_ANALYTICS_ROUTE: "0", CHASTE_GO_ANALYTICS_REPORT_ROUTE: "1" });
    expect(isGoRouteRequest(readDisabled, "GET", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(readDisabled, "POST", "/api/analytics")).toBe(true);

    const rollback = goRouteProxyFlagsFromEnv({ CHASTE_GO_ANALYTICS_REPORT_ROUTE: "0" });
    expect(isGoRouteRequest(rollback, "POST", "/api/analytics")).toBe(false);
    expect(isGoRouteRequest(rollback, "GET", "/api/analytics")).toBe(true);
  });

  it("keeps the whole auth namespace on Go when auth is enabled", () => {
    const oidc = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_OIDC_ROUTE: "1" });
    expect(isGoRouteRequest(oidc, "GET", "/api/auth/sign-in/oidc")).toBe(true);
    expect(isGoRouteRequest(oidc, "GET", "/api/auth/callback/oidc?code=one")).toBe(true);
    expect(isGoRouteRequest(oidc, "POST", "/api/auth/native/exchange")).toBe(true);
    expect(isGoRouteRequest(oidc, "GET", "/api/auth/sign-in/saml")).toBe(true);

    const saml = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_SAML_ROUTE: "1" });
    expect(isGoRouteRequest(saml, "GET", "/api/auth/sign-in/saml")).toBe(true);
    expect(isGoRouteRequest(saml, "POST", "/api/auth/callback/saml")).toBe(true);
    expect(isGoRouteRequest(saml, "GET", "/api/auth/sign-in/oidc")).toBe(true);
  });

  it("allows an explicit legacy-auth compatibility opt-out", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_ROUTE: "0" });
    expect(flags.auth).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/auth/sign-in/email")).toBe(false);
  });

  it("leaves auth unselected when the Go API explicitly disables its auth mount", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_AUTH_ROUTE: "1", GO_AUTH_ROUTE: "0" });
    expect(flags.auth).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/auth/sign-in/email")).toBe(false);
  });

  it.each(selectorCases)("routes $flag requests when enabled", ({ env, flag, method, url }) => {
    const flags = goRouteProxyFlagsFromEnv({ [env]: "1" });
    expect(flags[flag]).toBe(true);
    expect(isGoRouteRequest(flags, method, url)).toBe(true);
  });

  it("keeps the modules namespace on Go regardless of method and stale selectors", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_MODULES_ROUTE: "0", CHASTE_GO_MODULES_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "POST", "/api/modules")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/modules")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/modules/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/modules/")).toBe(true);
  });

  it("routes only exact support channel GET and POST requests to Go regardless of old selectors", () => {
    for (const env of [
      {},
      { CHASTE_GO_SUPPORT_CHANNELS_ROUTE: "0", CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE: "0" },
      { CHASTE_GO_SUPPORT_CHANNELS_ROUTE: "1", CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE: "1" },
    ]) {
      const flags = goRouteProxyFlagsFromEnv(env);
      expect(isGoRouteRequest(flags, "GET", "/api/support/channels?view=settings")).toBe(true);
      expect(isGoRouteRequest(flags, "POST", "/api/support/channels?source=settings")).toBe(true);
      expect(isGoRouteRequest(flags, "PUT", "/api/support/channels")).toBe(false);
      expect(isGoRouteRequest(flags, "GET", "/api/support/channels/extra")).toBe(false);
      expect(isGoRouteRequest(flags, "POST", "/api/support/channels/")).toBe(false);
    }
  });

  it("keeps the branding namespace on Go for unsupported methods and paths", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_BRANDING_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "GET", "/api/branding")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/branding")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/branding")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/branding/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/branding/")).toBe(true);
  });

  it("keeps the signals namespace on Go for unsupported methods and paths", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SIGNALS_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "GET", "/api/signals?severity=orange&module=sales")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/signals")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/signals/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/signals/")).toBe(true);
  });

  it("keeps the My Work namespace on Go regardless of route flags", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/my-work?status=open")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/summarize")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/")).toBe(true);

    const legacyFlags = goRouteProxyFlagsFromEnv({ CHASTE_GO_MY_WORK_ROUTE: "0" });
    expect(isGoRouteRequest(legacyFlags, "GET", "/api/my-work")).toBe(true);
  });

  it("keeps the My Work summary namespace on Go for its handler and invalid requests", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_MY_WORK_SUMMARY_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "POST", "/api/my-work/summarize?scope=mine")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/my-work/summarize")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/my-work/summarize")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work/summarize/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work/summarize/")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/my-work")).toBe(true);

    const staleRollbackFlags = goRouteProxyFlagsFromEnv({ CHASTE_GO_MY_WORK_SUMMARY_ROUTE: "0" });
    expect(isGoRouteRequest(staleRollbackFlags, "POST", "/api/my-work/summarize")).toBe(true);
  });

  it("keeps the routines namespace and external webhook endpoint on Go", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/routines")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/routines")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/routines")).toBe(true);
    expect(isGoRouteRequest(flags, "HEAD", "/api/routines")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/routines/webhook/secret-token")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/routines/webhook/not-a-token/extra")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/routines/unknown")).toBe(true);
    expect(isGoRouteRequest(goRouteProxyFlagsFromEnv({ CHASTE_GO_ROUTINES_ROUTE: "0" }), "GET", "/api/routines")).toBe(true);
  });

  it("leaves unsupported memory paths unselected for the Go catch-all", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/memory?q=ledger")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/memory")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/memory")).toBe(false);
    expect(isGoRouteRequest(flags, "HEAD", "/api/memory")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/memory/extra")).toBe(false);
    expect(isGoRouteRequest(goRouteProxyFlagsFromEnv({ CHASTE_GO_MEMORY_ROUTE: "0" }), "GET", "/api/memory")).toBe(false);
  });

  it("leaves unsupported module settings paths unselected for the Go catch-all", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/module-settings?module=inventory")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/module-settings")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/module-settings")).toBe(false);
    expect(isGoRouteRequest(flags, "HEAD", "/api/module-settings")).toBe(false);
    expect(isGoRouteRequest(flags, "POST", "/api/module-settings/inventory")).toBe(false);
    expect(isGoRouteRequest(goRouteProxyFlagsFromEnv({ CHASTE_GO_MODULE_SETTINGS_ROUTE: "0" }), "GET", "/api/module-settings?module=inventory")).toBe(false);
  });

  it("leaves unsupported policy paths unselected for the Go catch-all", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/policy")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/policy?source=settings")).toBe(true);
    expect(isGoRouteRequest(flags, "PUT", "/api/policy")).toBe(false);
    expect(isGoRouteRequest(flags, "DELETE", "/api/policy")).toBe(false);
    expect(isGoRouteRequest(flags, "HEAD", "/api/policy")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/policy/extra")).toBe(false);
    expect(isGoRouteRequest(goRouteProxyFlagsFromEnv({ CHASTE_GO_POLICY_ROUTE: "0" }), "GET", "/api/policy")).toBe(false);
  });

  it("keeps the ledger namespace on Go for unsupported methods and paths", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_LEDGER_ROUTE: "1" });
    expect(isGoRouteRequest(flags, "POST", "/api/ledger")).toBe(true);
    expect(isGoRouteRequest(flags, "DELETE", "/api/ledger")).toBe(true);
    expect(isGoRouteRequest(flags, "HEAD", "/api/ledger")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/ledger/extra")).toBe(true);
  });

  it("routes exact inventory GETs to Go regardless of the removed Vite selector", () => {
    for (const env of [
      {},
      { CHASTE_GO_INVENTORY_READ_ROUTE: "0" },
      { CHASTE_GO_INVENTORY_READ_ROUTE: "1" },
    ]) {
      const flags = goRouteProxyFlagsFromEnv(env);
      expect(isGoRouteRequest(flags, "GET", "/api/inventory")).toBe(true);
      expect(isGoRouteRequest(flags, "GET", "/api/inventory?sku=MUG-1")).toBe(true);
      expect(isGoRouteRequest(flags, "POST", "/api/inventory")).toBe(false);
      expect(isGoRouteRequest(flags, "PATCH", "/api/inventory")).toBe(false);
      expect(isGoRouteRequest(flags, "HEAD", "/api/inventory")).toBe(false);
      expect(isGoRouteRequest(flags, "GET", "/api/inventory/history")).toBe(false);
    }
  });

  it("keeps a selected inventory history 404 on Go without retrying legacy", async () => {
    let goCalls = 0;
    let legacyCalls = 0;
    const go = createHttpServer((request, response) => {
      goCalls += 1;
      expect(request.url).toBe("/api/inventory?sku=MUG-404");
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Item not found." }));
    });
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });

    const legacy = createHttpServer((_request, response) => {
      legacyCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ movements: [] }));
    });
    await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve())) });

    const vite = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({ CHASTE_GO_INVENTORY_READ_ROUTE: "0" }), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/inventory?sku=MUG-404`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Item not found." });
    expect(goCalls).toBe(1);
    expect(legacyCalls).toBe(0);
  });

  it("routes supported CRM reads to Go by default and allows a proxy selector opt-out", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.crmReads).toBe(true);
    for (const query of [
      "deals=1",
      "customers=1",
      "tasks=1",
      "tasks=1&open=1",
      "tasks=1&open=0",
      "views=1",
      "timeline=aaaaaaaa-0000-4000-8000-000000000001",
    ]) {
      expect(isGoRouteRequest(defaults, "GET", `/api/crm?${query}`), query).toBe(true);
    }
    for (const [method, url] of [
      ["POST", "/api/crm?deals=1"],
      ["GET", "/api/crm"],
      ["GET", "/api/crm?unknown=1"],
      ["GET", "/api/crm?deals=1&tasks=1"],
      ["GET", "/api/crm?deals=1&deals=1"],
      ["GET", "/api/crm?tasks=anything"],
      ["GET", "/api/crm?tasks=0"],
      ["GET", "/api/crm?tasks=1&open=true"],
      ["GET", "/api/crm?tasks=1&open=1&open=1"],
      ["GET", "/api/crm?timeline=not-a-uuid"],
      ["GET", "/api/crm?timeline=aaaaaaaa-0000-4000-8000"],
      ["GET", "/api/crm?views=1&extra=1"],
      ["GET", "/api/crm/views"],
      ["GET", "/api/crm/extra?deals=1"],
    ]) {
      expect(isGoRouteRequest(defaults, method, url), `${method} ${url}`).toBe(false);
    }

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_CRM_READS: "0" });
    expect(disabled.crmReads).toBe(false);
    expect(isGoRouteRequest(disabled, "GET", "/api/crm?deals=1")).toBe(false);
  });

  it("routes only GET /api/customers to Go under the CRM read selector", () => {
    const enabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_CRM_READS: "1" });
    expect(isGoRouteRequest(enabled, "GET", "/api/customers")).toBe(true);
    expect(isGoRouteRequest(enabled, "GET", "/api/customers?active=1")).toBe(true);
    expect(isGoRouteRequest(enabled, "POST", "/api/customers")).toBe(false);
    expect(isGoRouteRequest(enabled, "GET", "/api/customers/extra")).toBe(false);

    const crmRollback = goRouteProxyFlagsFromEnv({ CHASTE_GO_CRM_READS: "0" });
    expect(isGoRouteRequest(crmRollback, "GET", "/api/customers")).toBe(false);
  });

  it("proxies only the selected customer-directory GET to Go", async () => {
    const go = requestRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });
    const vite: ViteDevServer = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv({ CHASTE_GO_CRM_READS: "1" }), goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
    runningServers.push({ close: () => vite.close() });
    const address = vite.httpServer?.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    const directory = await fetch(`${origin}/api/customers`);
    expect(await directory.json()).toMatchObject({ target: "go", method: "GET", url: "/api/customers" });
    const create = await fetch(`${origin}/api/customers`, { method: "POST", body: "{}" });
    expect(await create.json()).toMatchObject({ target: "go", method: "POST", url: "/api/customers" });
    const suffix = await fetch(`${origin}/api/customers/extra`);
    expect(await suffix.json()).toMatchObject({ target: "go", method: "GET", url: "/api/customers/extra" });
  });

  it("keeps the POS namespace on Go for supported and unsupported requests", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_POS_READ_ROUTE: "0", CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE: "0" });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(isGoRouteRequest(flags, method, "/api/pos")).toBe(true);
      expect(isGoRouteRequest(flags, method, "/api/pos/shift-summary")).toBe(true);
      expect(isGoRouteRequest(flags, method, "/api/pos/unknown")).toBe(true);
    }
  });

  it("keeps POS customer requests on Go independently of the generic capability route", () => {
    const flags = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSION_CAPABILITY_ROUTE: "0" });
    expect(isGoRouteRequest(flags, "GET", "/api/pos/customers")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/customers?active=1")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/pos/customers")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/pos/customers/extra")).toBe(true);
  });

  it("routes only the Support customer picker GET to Go", () => {
    const flags = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(flags, "GET", "/api/support/customers")).toBe(true);
    expect(isGoRouteRequest(flags, "GET", "/api/support/customers?active=1")).toBe(true);
    expect(isGoRouteRequest(flags, "POST", "/api/support/customers")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/support/customers/extra")).toBe(false);
    expect(isGoRouteRequest(flags, "GET", "/api/customers")).toBe(true);
  });

  it("keeps the SCIM Users and token namespaces on Go for active and invalid requests", () => {
    const userPath = "/api/scim/v2/Users/aaaaaaaa-0000-4000-8000-000000000001";
    const readOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_READ_ROUTE: "1" });
    expect(isGoRouteRequest(readOnly, "GET", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", userPath)).toBe(true);
    expect(isGoRouteRequest(readOnly, "POST", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(readOnly, "DELETE", userPath)).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", `${userPath}/extra`)).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", `${userPath}/`)).toBe(true);
    expect(isGoRouteRequest(readOnly, "GET", "/api/scim/v2/Users/not-a-uuid")).toBe(true);
    expect(isGoRouteRequest(readOnly, "PATCH", userPath)).toBe(true);
    expect(isGoRouteRequest(readOnly, "HEAD", "/api/scim/v2/Users")).toBe(true);

    const writeOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_WRITE_ROUTE: "1" });
    expect(isGoRouteRequest(writeOnly, "GET", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "GET", userPath)).toBe(true);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "DELETE", userPath)).toBe(true);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users/extra")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "POST", "/api/scim/v2/Users/")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "DELETE", `${userPath}/extra`)).toBe(true);
    expect(isGoRouteRequest(writeOnly, "DELETE", `${userPath}/`)).toBe(true);
    expect(isGoRouteRequest(writeOnly, "DELETE", "/api/scim/v2/Users/not-a-uuid")).toBe(true);
    expect(isGoRouteRequest(writeOnly, "PUT", userPath)).toBe(true);
    const staleRollback = goRouteProxyFlagsFromEnv({ CHASTE_GO_SCIM_READ_ROUTE: "0", CHASTE_GO_SCIM_WRITE_ROUTE: "0" });
    expect(isGoRouteRequest(staleRollback, "GET", "/api/scim/v2/Users")).toBe(true);
    expect(isGoRouteRequest(staleRollback, "DELETE", userPath)).toBe(true);
  });

  it("routes the migrated accounting, HR, and marketing collections to Go", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    for (const path of ["/api/accounting", "/api/hr", "/api/marketing"]) {
      expect(isGoRouteRequest(defaults, "GET", path)).toBe(true);
      expect(isGoRouteRequest(defaults, "POST", `${path}?source=vite`)).toBe(true);
      expect(isGoRouteRequest(defaults, "HEAD", path)).toBe(false);
      expect(isGoRouteRequest(defaults, "GET", `${path}/extra`)).toBe(false);
    }
  });

  it("routes project operations and module switchboard reads to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(defaults, "GET", "/api/projects")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/projects")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/modules")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/modules")).toBe(true);
    expect(isGoRouteRequest(defaults, "HEAD", "/api/projects")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/projects/extra")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_PROJECTS_ROUTE: "0", CHASTE_GO_MODULES_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/projects")).toBe(false);
    expect(isGoRouteRequest(disabled, "POST", "/api/projects")).toBe(false);
    expect(isGoRouteRequest(disabled, "GET", "/api/modules")).toBe(true);
  });

  it("routes only the sales order collection GET to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.salesOrders).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales?status=draft")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/customers")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/customers?active=1")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/sales")).toBe(false);
    expect(isGoRouteRequest(defaults, "HEAD", "/api/sales")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/extra/parts")).toBe(false);

    const rolledBack = goRouteProxyFlagsFromEnv({ CHASTE_GO_SALES_ORDERS_ROUTE: "0" });
    expect(isGoRouteRequest(rolledBack, "GET", "/api/sales")).toBe(false);
    expect(isGoRouteRequest(rolledBack, "GET", "/api/sales/customers")).toBe(true);
    expect(isGoRouteRequest(rolledBack, "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
  });

  it("routes only the exact CRM follow-up draft POST to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.crmFollowUpDraft).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/crm/follow-up-draft")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/crm/follow-up-draft?source=customer")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/crm/follow-up-draft")).toBe(false);
    expect(isGoRouteRequest(defaults, "POST", "/api/crm/follow-up-draft/extra")).toBe(false);
    expect(isGoRouteRequest(defaults, "POST", "/api/crm/follow-up-draft/")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_CRM_FOLLOW_UP_DRAFT_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "POST", "/api/crm/follow-up-draft")).toBe(false);
  });

  it("routes only the exact support reply draft POST to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(defaults.supportReplyDraft).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/support/draft")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/support/draft?source=thread")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/support/draft")).toBe(false);
    expect(isGoRouteRequest(defaults, "POST", "/api/support/draft/extra")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_SUPPORT_REPLY_DRAFT_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "POST", "/api/support/draft")).toBe(false);
  });

  it("routes only exact sales invoice GET paths to Go by default", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001?print=1")).toBe(true);
    expect(isGoRouteRequest(defaults, "POST", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001")).toBe(false);
    expect(isGoRouteRequest(defaults, "HEAD", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001/")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001/extra")).toBe(false);
    expect(isGoRouteRequest(defaults, "GET", "/api/sales/")).toBe(false);

    for (const env of [{ CHASTE_GO_SALES_INVOICE_ROUTE: "0" }, { CHASTE_GO_SALES_INVOICE_ROUTE: "1" }]) {
      expect(isGoRouteRequest(goRouteProxyFlagsFromEnv(env), "GET", "/api/sales/aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    }
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

  it("keeps sessions and durable-runs namespaces on Go regardless of selectors", () => {
    const sessionItem = "/api/sessions/aaaaaaaa-0000-4000-8000-000000000001";
    const runsItem = "/api/durable-runs/aaaaaaaa-0000-4000-8000-000000000001";
    const sessionsOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "1", CHASTE_GO_DURABLE_RUNS_ROUTE: "0" });
    expect(isGoRouteRequest(sessionsOnly, "GET", "/api/sessions?limit=10")).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", `${sessionItem}?include=events`)).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", `${sessionItem}/replay`)).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", "/api/durable-runs")).toBe(true);
    expect(isGoRouteRequest(sessionsOnly, "GET", runsItem)).toBe(true);

    const durableRunsOnly = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "0", CHASTE_GO_DURABLE_RUNS_ROUTE: "1" });
    expect(isGoRouteRequest(durableRunsOnly, "GET", "/api/durable-runs?limit=10")).toBe(true);
    expect(isGoRouteRequest(durableRunsOnly, "GET", `${runsItem}?include=steps`)).toBe(true);
    expect(isGoRouteRequest(durableRunsOnly, "GET", "/api/sessions")).toBe(true);
    expect(isGoRouteRequest(durableRunsOnly, "GET", sessionItem)).toBe(true);

    for (const [flags, method, path] of [
      [sessionsOnly, "POST", "/api/sessions"],
      [sessionsOnly, "GET", "/api/sessions/not-a-uuid"],
      [sessionsOnly, "GET", `${sessionItem}/events`],
      [durableRunsOnly, "POST", "/api/durable-runs"],
      [durableRunsOnly, "GET", "/api/durable-runs/not-a-uuid"],
      [durableRunsOnly, "GET", `${runsItem}/steps`],
    ] as const) {
      expect(isGoRouteRequest(flags, method, path)).toBe(true);
    }
  });

  it("keeps session and durable-run reads on Go with stale selector opt-outs", () => {
    const defaults = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(defaults, "GET", "/api/sessions")).toBe(true);
    expect(isGoRouteRequest(defaults, "GET", "/api/durable-runs")).toBe(true);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_SESSIONS_ROUTE: "0", CHASTE_GO_DURABLE_RUNS_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/sessions")).toBe(true);
    expect(isGoRouteRequest(disabled, "GET", "/api/durable-runs")).toBe(true);
  });

  it("routes metrics reads by default and allows selector opt-out", () => {
    const metrics = goRouteProxyFlagsFromEnv({});
    expect(isGoRouteRequest(metrics, "GET", "/api/metrics")).toBe(true);
    expect(isGoRouteRequest(metrics, "POST", "/api/metrics")).toBe(false);
    expect(isGoRouteRequest(metrics, "HEAD", "/api/metrics")).toBe(false);
    expect(isGoRouteRequest(metrics, "GET", "/api/metrics/extra")).toBe(false);

    const disabled = goRouteProxyFlagsFromEnv({ CHASTE_GO_METRICS_ROUTE: "0" });
    expect(isGoRouteRequest(disabled, "GET", "/api/metrics")).toBe(false);
  });

  it("keeps the selected auth namespace on Go while preserving other proxy behavior", async () => {
    const go = requestRecorder("go", true);
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });


    const flags = goRouteProxyFlagsFromEnv({
      CHASTE_GO_SUPPORT_PUBLIC_ROUTE: "1",
      CHASTE_GO_SCIM_READ_ROUTE: "1",
      CHASTE_GO_SCIM_WRITE_ROUTE: "1",
      CHASTE_GO_MODULES_ROUTE: "1",
      CHASTE_GO_MODULES_WRITE_ROUTE: "1",
      CHASTE_GO_BRANDING_ROUTE: "1",
      CHASTE_GO_TEAM_READ_ROUTE: "1",
      CHASTE_GO_TEAM_WRITE_ROUTE: "1",
      CHASTE_GO_SETUP_ROUTE: "1",
      CHASTE_GO_ANALYTICS_ROUTE: "1",
      CHASTE_GO_ANALYTICS_REPORT_ROUTE: "1",
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
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
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
    expect(selectedPayload).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/auth/sign-in/email?intent=signup",
      cookie: "auth-session=browser",
      body: JSON.stringify({ email: "person@example.test" }),
    });
    expect(selected.headers.get("set-cookie")).toContain("proxy-result=preserved");

    const onboardingFlags = goRouteProxyFlagsFromEnv({ CHASTE_GO_ONBOARDING_ROUTE: "1", CHASTE_GO_ANALYTICS_REPORT_ROUTE: "0" });
    const onboardingVite: ViteDevServer = await createViteServer({
      configFile: false,
      appType: "custom",
      plugins: [createGoRouteProxyPlugin(onboardingFlags, goOrigin)],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api": { target: goOrigin, changeOrigin: false } },
      },
    });
    await onboardingVite.listen();
    runningServers.push({ close: () => onboardingVite.close() });
    const onboardingAddress = onboardingVite.httpServer?.address() as AddressInfo;
    const onboardingOrigin = `http://127.0.0.1:${onboardingAddress.port}`;
    const reportRouteDisabled = await fetch(`${onboardingOrigin}/api/analytics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Report", sections: [] }),
    });
    expect(await reportRouteDisabled.json()).toMatchObject({ target: "go", method: "POST", url: "/api/analytics" });
    const analyticsGetUnaffected = await fetch(`${onboardingOrigin}/api/analytics?dataset=analytics.pipelineByStage`);
    expect(await analyticsGetUnaffected.json()).toMatchObject({ target: "go", method: "GET" });
    const onboardingBody = JSON.stringify({
      orgName: "Vite Go Workspace",
      businessDescription: "A workspace bootstrap request sent through the Vite Go route.",
      intentId: "vite-go-onboarding-intent",
    });
    const onboardingPost = await fetch(`${onboardingOrigin}/api/onboarding?flow=wizard`, {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=browser-session",
        authorization: "Bearer browser-bearer-token",
        origin: onboardingOrigin,
        "content-type": "application/json",
      },
      body: onboardingBody,
    });
    const onboardingPostPayload = await onboardingPost.json() as Record<string, string>;
    expect(onboardingPostPayload).toMatchObject({
      target: "go",
      method: "POST",
      url: "/api/onboarding?flow=wizard",
      cookie: "better-auth.session_token=browser-session",
      authorization: "Bearer browser-bearer-token",
      origin: onboardingOrigin,
      host: new URL(onboardingOrigin).host,
      body: onboardingBody,
    });

    for (const method of ["GET", "PATCH"] as const) {
      const transitionRequest = await fetch(`${onboardingOrigin}/api/onboarding`, {
        method,
        headers: {
          cookie: "better-auth.session_token=browser-session",
          authorization: "Bearer browser-bearer-token",
          ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "PATCH" ? { body: JSON.stringify({ complete: true }) } : {}),
      });
      expect(await transitionRequest.json()).toMatchObject({
        target: "go",
        method,
        url: "/api/onboarding",
        cookie: "better-auth.session_token=browser-session",
        authorization: "Bearer browser-bearer-token",
      });
    }

    const unsupportedAuth = await fetch(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "unexpected" }),
    });
    expect(await unsupportedAuth.json()).toMatchObject({ target: "go", url: "/api/auth/sign-in/social" });

    const unsupportedAuthMethod = await fetch(`${origin}/api/auth/get-session`, { method: "DELETE" });
    expect(await unsupportedAuthMethod.json()).toMatchObject({ target: "go", method: "DELETE" });

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
    const unsupportedSupportChannelsMethod = await fetch(`${origin}/api/support/channels`, { method: "PUT" });
    expect((await unsupportedSupportChannelsMethod.json()).target).toBe("go");
    const supportChannelsSuffix = await fetch(`${origin}/api/support/channels/extra`);
    expect((await supportChannelsSuffix.json()).target).toBe("go");

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
    expect((await teamUnsupportedMethod.json())).toMatchObject({ target: "go", method: "PATCH" });

    const teamUnsupportedPath = await fetch(`${origin}/api/team/invitations`);
    expect((await teamUnsupportedPath.json())).toMatchObject({ target: "go", method: "GET" });

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

    const inventoryHistory = await fetch(`${origin}/api/inventory?sku=MUG-1`, {
      headers: { cookie: "auth-session=browser" },
    });
    expect(await inventoryHistory.json()).toMatchObject({
      target: "go",
      method: "GET",
      url: "/api/inventory?sku=MUG-1",
      cookie: "auth-session=browser",
    });
    const inventoryWrite = await fetch(`${origin}/api/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "createItem" }),
    });
    expect((await inventoryWrite.json())).toMatchObject({ target: "go", method: "POST", url: "/api/inventory" });
    const inventoryNested = await fetch(`${origin}/api/inventory/history`);
    expect((await inventoryNested.json())).toMatchObject({ target: "go", method: "GET", url: "/api/inventory/history" });

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

    const portalInvoice = await fetch(`${origin}/api/portal/invoice/token`);
    expect((await portalInvoice.json())).toMatchObject({ target: "go", method: "GET", url: "/api/portal/invoice/token" });

    const portalInvoiceWithQuery = await fetch(`${origin}/api/portal/invoice/token?download=1`);
    expect((await portalInvoiceWithQuery.json())).toMatchObject({ target: "go", method: "GET", url: "/api/portal/invoice/token?download=1" });

    const unsupportedMethod = await fetch(`${origin}/api/portal/invoice/token`, { method: "POST" });
    expect((await unsupportedMethod.json()).target).toBe("go");

    const portalSuffixFallback = await fetch(`${origin}/api/portal/invoice/token/extra`);
    expect((await portalSuffixFallback.json()).target).toBe("go");

    const salesOrders = await fetch(`${origin}/api/sales?status=draft`);
    expect((await salesOrders.json())).toMatchObject({ target: "go", method: "GET", url: "/api/sales?status=draft" });

    const salesOrdersUnsupportedMethod = await fetch(`${origin}/api/sales`, { method: "POST" });
    expect((await salesOrdersUnsupportedMethod.json()).target).toBe("go");

    for (const path of ["/api/sales/", "/api/sales/extra/parts"]) {
      const fallback = await fetch(`${origin}${path}`);
      expect((await fallback.json()).target).toBe("go");
    }

    const salesInvoice = await fetch(`${origin}/api/sales/aaaaaaaa-0000-4000-8000-000000000001?print=1`);
    expect((await salesInvoice.json()).target).toBe("go");

    for (const path of [
      "/api/sales/aaaaaaaa-0000-4000-8000-000000000001/extra",
      "/api/sales/aaaaaaaa-0000-4000-8000-000000000001/",
    ]) {
      const fallback = await fetch(`${origin}${path}`);
      expect((await fallback.json()).target).toBe("go");
    }

    const salesInvoiceUnsupportedMethod = await fetch(`${origin}/api/sales/aaaaaaaa-0000-4000-8000-000000000001`, { method: "POST" });
    expect((await salesInvoiceUnsupportedMethod.json()).target).toBe("go");

    const posRead = await fetch(`${origin}/api/pos?status=open`, { headers: { cookie: "auth-session=browser" } });
    expect((await posRead.json())).toMatchObject({ target: "go", method: "GET", url: "/api/pos?status=open", cookie: "auth-session=browser" });

    for (const path of ["/api/accounting", "/api/hr", "/api/marketing"]) {
      const read = await fetch(`${origin}${path}?source=vite`);
      expect((await read.json())).toMatchObject({ target: "go", method: "GET", url: `${path}?source=vite` });
      const write = await fetch(`${origin}${path}`, { method: "POST" });
      expect((await write.json())).toMatchObject({ target: "go", method: "POST", url: path });
    }

    const posCustomers = await fetch(`${origin}/api/pos/customers?active=1`, { headers: { cookie: "auth-session=browser" } });
    expect((await posCustomers.json())).toMatchObject({ target: "go", method: "GET", url: "/api/pos/customers?active=1", cookie: "auth-session=browser" });

    const posCustomersUnsupportedMethod = await fetch(`${origin}/api/pos/customers`, { method: "POST" });
    expect((await posCustomersUnsupportedMethod.json())).toMatchObject({ target: "go", method: "POST" });

    const posUnsupportedMethod = await fetch(`${origin}/api/pos`, { method: "POST" });
    expect((await posUnsupportedMethod.json())).toMatchObject({ target: "go", method: "POST" });

    const posSuffixFallback = await fetch(`${origin}/api/pos/extra`);
    expect((await posSuffixFallback.json())).toMatchObject({ target: "go", method: "GET" });

    const modulesRead = await fetch(`${origin}/api/modules`);
    expect((await modulesRead.json()).target).toBe("go");

    const modulesWrite = await fetch(`${origin}/api/modules`, { method: "POST" });
    expect((await modulesWrite.json()).target).toBe("go");

    const modulesWriteSuffix = await fetch(`${origin}/api/modules/extra`, { method: "POST" });
    expect((await modulesWriteSuffix.json()).target).toBe("go");

    const brandingRead = await fetch(`${origin}/api/branding`);
    expect((await brandingRead.json()).target).toBe("go");

    const brandingWrite = await fetch(`${origin}/api/branding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accentColor: "#AABBCC", layout: "modern" }),
    });
    expect((await brandingWrite.json()).target).toBe("go");

    for (const path of ["/api/branding/extra", "/api/branding/"]) {
      const goOwned = await fetch(`${origin}${path}`);
      expect((await goOwned.json()).target).toBe("go");
    }

    const prefixFallback = await fetch(`${origin}/api/setup/extra`);
    expect((await prefixFallback.json()).target).toBe("go");

    const analyticsUnsupportedMethod = await fetch(`${origin}/api/analytics`, { method: "DELETE" });
    expect((await analyticsUnsupportedMethod.json()).target).toBe("go");

    const analyticsSuffixFallback = await fetch(`${origin}/api/analytics/extra`);
    expect((await analyticsSuffixFallback.json()).target).toBe("go");

    const myWorkUnsupportedMethod = await fetch(`${origin}/api/my-work`, { method: "POST" });
    expect((await myWorkUnsupportedMethod.json()).target).toBe("go");

    const myWorkSuffixFallback = await fetch(`${origin}/api/my-work/extra`);
    expect((await myWorkSuffixFallback.json()).target).toBe("go");

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
      const goOwned = await fetch(`${origin}${path}`, { method });
      expect((await goOwned.json()).target, `${method} ${path}`).toBe("go");
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
      const goOwned = await fetch(`${origin}${path}`, { method });
      expect((await goOwned.json()).target).toBe("go");
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
    expect(unsupportedSupportMethod.status).toBe(202);
    expect(await unsupportedSupportMethod.text()).toContain("accepted:complete");

    const supportSuffixFallback = await fetch(`${origin}/api/support/public/extra`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", token: "test-token" }),
    });
    expect(supportSuffixFallback.status).toBe(202);
    expect(await supportSuffixFallback.text()).toContain("accepted:complete");
  }, 15_000);
});
