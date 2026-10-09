import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { createGoRouteProxyPlugin, goAccountingCreateInvoiceFromEnv, goAccountingCreditNoteFromEnv, goAccountingCustomerStatementReadsFromEnv, goAccountingPeriodCloseReadsFromEnv, goAccountingRecordPaymentFromEnv, goAccountingReportsFromEnv, goAccountingReverseEntryFromEnv, goBankReconciliationWritesFromEnv, goCrmCustomerCreateFromEnv, goCrmCustomerDeactivateFromEnv, goCrmCustomerImportFromEnv, goCrmCustomerMergeFromEnv, goCrmCustomerProfileUpdateFromEnv, goCrmDealCreateFromEnv, goCrmDealStageMoveFromEnv, goCrmTaskWritesFromEnv, goCrmViewWritesFromEnv, goDocumentsEditorReadsFromEnv, goDocumentsIngestedReadsFromEnv, goDocumentsVersionReadsFromEnv, goHrEmployeeWritesFromEnv, goHrExpensesFromEnv, goHrHiringFromEnv, goHrLeaveFromEnv, goHrOverviewReportFromEnv, goHrPayrollFromEnv, goHrTimeFromEnv, goInventoryBarcodeLookupFromEnv, goInventoryLocationReservationWritesFromEnv, goInventoryTransferWritesFromEnv, goManufacturingDefineBomSliceFromEnv, goManufacturingPlanningReadsFromEnv, goManufacturingProductionWritesFromEnv, goManufacturingWorkOrderWritesFromEnv, goPosCloseSessionSliceFromEnv, goPosCustomersSliceFromEnv, goPosOpenSessionSliceFromEnv, goProjectsWritesFromEnv, goPurchasingAPAgingReadsFromEnv, goPurchasingCreateOrderFromEnv, goPurchasingFinanceWritesFromEnv, goPurchasingIntelReadsFromEnv, goPurchasingPaymentRunsFromEnv, goPurchasingReceiptHistoryReadsFromEnv, goPurchasingSupplierStatementReadsFromEnv, goPurchasingWorkflowReadsFromEnv, goPurchasingReceiveGoodsFromEnv, goPurchasingReturnCloseFromEnv, goPurchasingSourcingWritesFromEnv, goRouteProxyFlagsFromEnv, goSalesOrderReadsFromEnv, goSalesOrderWritesFromEnv, goSessionCapabilityRouteFromEnv, goMessagingPeopleReadsFromEnv, goMarketingCampaignWritesFromEnv } from "./src/api/go-route-proxy.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "CHASTE_");
  const legacyWebOrigin = env.CHASTE_LEGACY_WEB_ORIGIN || "http://localhost:3001";
  const goApiOrigin = env.CHASTE_GO_API_ORIGIN || "http://127.0.0.1:8080";
  const goRouteProxy = createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv(env), goApiOrigin);
  const goSessionCapabilityRoute = goSessionCapabilityRouteFromEnv(env);
  const goInventoryItemSlice = env.CHASTE_GO_INVENTORY_ITEM_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goInventoryImportSlice = env.CHASTE_GO_INVENTORY_IMPORT_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goInventoryCycleCountWrites = env.CHASTE_GO_INVENTORY_CYCLE_COUNT_WRITES === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goInventoryTransferWrites = goInventoryTransferWritesFromEnv(env);
  const goInventoryLocationReservationWrites = goInventoryLocationReservationWritesFromEnv(env);
  const goInventoryBarcodeLookup = goInventoryBarcodeLookupFromEnv(env);
  const goCrmDealStageMove = goCrmDealStageMoveFromEnv(env);
  const goCrmDealCreate = goCrmDealCreateFromEnv(env);
  const goCrmTaskWrites = goCrmTaskWritesFromEnv(env);
  const goCrmCustomerCreate = goCrmCustomerCreateFromEnv(env);
  const goCrmCustomerDeactivate = goCrmCustomerDeactivateFromEnv(env);
  const goCrmCustomerMerge = goCrmCustomerMergeFromEnv(env);
  const goCrmCustomerImport = goCrmCustomerImportFromEnv(env);
  const goCrmCustomerProfileUpdate = goCrmCustomerProfileUpdateFromEnv(env);
  const goCrmViewWrites = goCrmViewWritesFromEnv(env);
  const goPurchasingCreateOrder = goPurchasingCreateOrderFromEnv(env);
  const goPurchasingReceiveGoods = goPurchasingReceiveGoodsFromEnv(env);
  const goPurchasingReturnClose = goPurchasingReturnCloseFromEnv(env);
  const goPurchasingFinanceWrites = goPurchasingFinanceWritesFromEnv(env);
  const goPurchasingPaymentRuns = goPurchasingPaymentRunsFromEnv(env);
  const goPurchasingReceiptHistoryReads = goPurchasingReceiptHistoryReadsFromEnv(env);
  const goPurchasingSupplierStatementReads = goPurchasingSupplierStatementReadsFromEnv(env);
  const goPurchasingWorkflowReads = goPurchasingWorkflowReadsFromEnv(env);
  const goPurchasingIntelReads = goPurchasingIntelReadsFromEnv(env);
  const goPurchasingAPAgingReads = goPurchasingAPAgingReadsFromEnv(env);
  const goDocumentsIngestedReads = goDocumentsIngestedReadsFromEnv(env);
  const goDocumentsVersionReads = goDocumentsVersionReadsFromEnv(env);
  const goDocumentsEditorReads = goDocumentsEditorReadsFromEnv(env);
  const goPurchasingSourcingWrites = goPurchasingSourcingWritesFromEnv(env);
  const goPurchasingVendorSlice = env.CHASTE_GO_PURCHASING_VENDOR_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goMarketingSegmentSlice = env.CHASTE_GO_MARKETING_SEGMENT_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goMarketingCampaignWrites = goMarketingCampaignWritesFromEnv(env);
  const goManufacturingDefineBomSlice = goManufacturingDefineBomSliceFromEnv(env);
  const goManufacturingWorkOrderWrites = goManufacturingWorkOrderWritesFromEnv(env);
  const goManufacturingProductionWrites = goManufacturingProductionWritesFromEnv(env);
  const goManufacturingPlanningReads = goManufacturingPlanningReadsFromEnv(env);
  const goSalesOrderWrites = goSalesOrderWritesFromEnv(env);
  const goSalesOrderReads = goSalesOrderReadsFromEnv(env);
  const goHrExpenses = goHrExpensesFromEnv(env);
  const goHrLeave = goHrLeaveFromEnv(env);
  const goHrTime = goHrTimeFromEnv(env);
  const goHrPayroll = goHrPayrollFromEnv(env);
  const goProjectsWrites = goProjectsWritesFromEnv(env);
  const goHrHiring = goHrHiringFromEnv(env);
  const goHrOverviewReport = goHrOverviewReportFromEnv(env);
  const goHrEmployeeWrites = goHrEmployeeWritesFromEnv(env);
  const goAccountingRecordPayment = goAccountingRecordPaymentFromEnv(env);
  const goAccountingCreateInvoice = goAccountingCreateInvoiceFromEnv(env);
  const goAccountingCreditNote = goAccountingCreditNoteFromEnv(env);
  const goAccountingReverseEntry = goAccountingReverseEntryFromEnv(env);
  const goAccountingPeriodCloseReads = goAccountingPeriodCloseReadsFromEnv(env);
  const goAccountingReports = goAccountingReportsFromEnv(env);
  const goAccountingCustomerStatementReads = goAccountingCustomerStatementReadsFromEnv(env);
  const goBankReconciliationWrites = goBankReconciliationWritesFromEnv(env);
  const goMessagingSendSlice = env.CHASTE_GO_MESSAGING_SEND_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goMessagingEditSlice = env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_EDIT_SLICE !== "0";
  const goMessagingDeleteSlice = env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" && env.CHASTE_GO_MESSAGING_DELETE_SLICE !== "0";
  const goMessagingPeopleReads = goMessagingPeopleReadsFromEnv(env);
  const goPosOpenSessionSlice = goPosOpenSessionSliceFromEnv(env);
  const goPosCloseSessionSlice = goPosCloseSessionSliceFromEnv(env);
  const goPosCustomersSlice = goPosCustomersSliceFromEnv(env);
  const goPosCompleteSaleSlice = env.CHASTE_GO_POS_COMPLETE_SALE_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosReturnSaleSlice = env.CHASTE_GO_POS_RETURN_SALE_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosShiftSummaryRoute = env.CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE !== "0";

  return {
    plugins: [react(), goRouteProxy],
    define: {
      __LEGACY_WEB_ORIGIN__: JSON.stringify(legacyWebOrigin),
      __GO_INVENTORY_ITEM_SLICE__: JSON.stringify(goInventoryItemSlice),
      __GO_INVENTORY_IMPORT_SLICE__: JSON.stringify(goInventoryImportSlice),
      __GO_INVENTORY_CYCLE_COUNT_WRITES__: JSON.stringify(goInventoryCycleCountWrites),
      __GO_INVENTORY_TRANSFER_WRITES__: JSON.stringify(goInventoryTransferWrites),
      __GO_INVENTORY_LOCATION_RESERVATION_WRITES__: JSON.stringify(goInventoryLocationReservationWrites),
      __GO_INVENTORY_BARCODE_LOOKUP__: JSON.stringify(goInventoryBarcodeLookup),
      __GO_CRM_DEAL_STAGE_MOVE__: JSON.stringify(goCrmDealStageMove),
      __GO_CRM_READS__: JSON.stringify(env.CHASTE_GO_CRM_READS !== "0"),
      __GO_CRM_DEAL_CREATE__: JSON.stringify(goCrmDealCreate),
      __GO_CRM_TASK_WRITES__: JSON.stringify(goCrmTaskWrites),
      __GO_CRM_CUSTOMER_CREATE__: JSON.stringify(goCrmCustomerCreate),
      __GO_CRM_CUSTOMER_DEACTIVATE__: JSON.stringify(goCrmCustomerDeactivate),
      __GO_CRM_CUSTOMER_MERGE__: JSON.stringify(goCrmCustomerMerge),
      __GO_CRM_CUSTOMER_IMPORT__: JSON.stringify(goCrmCustomerImport),
      __GO_CRM_CUSTOMER_PROFILE_UPDATE__: JSON.stringify(goCrmCustomerProfileUpdate),
      __GO_CRM_VIEW_WRITES__: JSON.stringify(goCrmViewWrites),
      __GO_PURCHASING_CREATE_ORDER__: JSON.stringify(goPurchasingCreateOrder),
      __GO_PURCHASING_RECEIVE_GOODS__: JSON.stringify(goPurchasingReceiveGoods),
      __GO_PURCHASING_RETURN_CLOSE__: JSON.stringify(goPurchasingReturnClose),
      __GO_PURCHASING_FINANCE_WRITES__: JSON.stringify(goPurchasingFinanceWrites),
      __GO_PURCHASING_PAYMENT_RUNS__: JSON.stringify(goPurchasingPaymentRuns),
      __GO_PURCHASING_RECEIPT_HISTORY_READS__: JSON.stringify(goPurchasingReceiptHistoryReads),
      __GO_PURCHASING_SUPPLIER_STATEMENT_READS__: JSON.stringify(goPurchasingSupplierStatementReads),
      __GO_PURCHASING_WORKFLOW_READS__: JSON.stringify(goPurchasingWorkflowReads),
      __GO_PURCHASING_INTEL_READS__: JSON.stringify(goPurchasingIntelReads),
      __GO_PURCHASING_AP_AGING_READS__: JSON.stringify(goPurchasingAPAgingReads),
      __GO_DOCUMENT_INGESTED_READS__: JSON.stringify(goDocumentsIngestedReads),
      __GO_DOCUMENTS_VERSION_READS__: JSON.stringify(goDocumentsVersionReads),
      __GO_DOCUMENTS_EDITOR_READS__: JSON.stringify(goDocumentsEditorReads),
      __GO_PURCHASING_SOURCING_WRITES__: JSON.stringify(goPurchasingSourcingWrites),
      __GO_PURCHASING_VENDOR_SLICE__: JSON.stringify(goPurchasingVendorSlice),
      __GO_MARKETING_SEGMENT_SLICE__: JSON.stringify(goMarketingSegmentSlice),
      __GO_MARKETING_CAMPAIGN_WRITES__: JSON.stringify(goMarketingCampaignWrites),
      __GO_MANUFACTURING_DEFINE_BOM_SLICE__: JSON.stringify(goManufacturingDefineBomSlice),
      __GO_MANUFACTURING_WORK_ORDER_WRITES__: JSON.stringify(goManufacturingWorkOrderWrites),
      __GO_MANUFACTURING_PRODUCTION_WRITES__: JSON.stringify(goManufacturingProductionWrites),
      __GO_MANUFACTURING_PLANNING_READS__: JSON.stringify(goManufacturingPlanningReads),
      __GO_SALES_ORDER_WRITES__: JSON.stringify(goSalesOrderWrites),
      __GO_SALES_ORDER_READS__: JSON.stringify(goSalesOrderReads),
      __GO_HR_EXPENSES__: JSON.stringify(goHrExpenses),
      __GO_HR_LEAVE__: JSON.stringify(goHrLeave),
      __GO_HR_TIME__: JSON.stringify(goHrTime),
      __GO_HR_PAYROLL__: JSON.stringify(goHrPayroll),
      __GO_PROJECTS_WRITES__: JSON.stringify(goProjectsWrites),
      __GO_HR_HIRING__: JSON.stringify(goHrHiring),
      __GO_HR_OVERVIEW_REPORT_READS__: JSON.stringify(goHrOverviewReport),
      __GO_HR_EMPLOYEE_WRITES__: JSON.stringify(goHrEmployeeWrites),
      __GO_ACCOUNTING_RECORD_PAYMENT__: JSON.stringify(goAccountingRecordPayment),
      __GO_ACCOUNTING_CREATE_INVOICE__: JSON.stringify(goAccountingCreateInvoice),
      __GO_ACCOUNTING_CREDIT_NOTE__: JSON.stringify(goAccountingCreditNote),
      __GO_ACCOUNTING_REVERSE_ENTRY__: JSON.stringify(goAccountingReverseEntry),
      __GO_ACCOUNTING_PERIOD_CLOSE_READS__: JSON.stringify(goAccountingPeriodCloseReads),
      __GO_ACCOUNTING_REPORTS__: JSON.stringify(goAccountingReports),
      __GO_ACCOUNTING_CUSTOMER_STATEMENT_READS__: JSON.stringify(goAccountingCustomerStatementReads),
      __GO_BANK_RECONCILIATION_WRITES__: JSON.stringify(goBankReconciliationWrites),
      __GO_MESSAGING_SEND_SLICE__: JSON.stringify(goMessagingSendSlice),
      __GO_MESSAGING_EDIT_SLICE__: JSON.stringify(goMessagingEditSlice),
      __GO_MESSAGING_DELETE_SLICE__: JSON.stringify(goMessagingDeleteSlice),
      __GO_MESSAGING_PEOPLE_READS__: JSON.stringify(goMessagingPeopleReads),
      __GO_POS_OPEN_SESSION_SLICE__: JSON.stringify(goPosOpenSessionSlice),
      __GO_POS_CLOSE_SESSION_SLICE__: JSON.stringify(goPosCloseSessionSlice),
      __GO_POS_COMPLETE_SALE_SLICE__: JSON.stringify(goPosCompleteSaleSlice),
      __GO_POS_RETURN_SALE_SLICE__: JSON.stringify(goPosReturnSaleSlice),
      __GO_POS_SHIFT_SUMMARY_ROUTE__: JSON.stringify(goPosShiftSummaryRoute),
      __GO_POS_CUSTOMERS_SLICE__: JSON.stringify(goPosCustomersSlice),
    },
    server: {
      host: "localhost",
      port: 3000,
      strictPort: true,
      proxy: {
        // The catch-all keeps transitional routes on Next. Onboarding POST
        // reaches Go through Next unless the explicit Vite selector is enabled;
        // onboarding GET and PATCH remain on the legacy handlers for now.
        "/api/health": {
          target: goApiOrigin,
        },
        ...(goSessionCapabilityRoute ? {
          "/api/capabilities/execute": { target: goApiOrigin, changeOrigin: false },
        } : {}),
        "/api": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
