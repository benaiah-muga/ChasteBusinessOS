package capability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/crm"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/jackc/pgx/v5"
)

const (
	createCustomerCapabilityID           = "crm.createCustomer"
	saveCustomerViewCapabilityID         = "crm.saveCustomerView"
	restoreCustomerViewCapabilityID      = "crm.restoreCustomerView"
	deactivateCustomerCapabilityID       = "crm.deactivateCustomer"
	mergeCustomersCapabilityID           = "crm.mergeCustomers"
	restoreCustomerMergeCapabilityID     = "crm.restoreCustomerMerge"
	importCustomersCapabilityID          = "crm.importCustomers"
	undoCustomerImportCapabilityID       = "crm.undoCustomerImport"
	restoreImportedCustomersCapabilityID = "crm.restoreImportedCustomers"
	updateCustomerProfilesCapabilityID   = "crm.updateCustomerProfiles"
	restoreCustomerProfilesCapabilityID  = "crm.restoreCustomerProfiles"
	reapplyCustomerProfilesCapabilityID  = "crm.reapplyCustomerProfiles"
	listCustomersCapabilityID            = "crm.listCustomers"
	listCustomerViewsCapabilityID        = "crm.listCustomerViews"
	listDealsCapabilityID                = "crm.listDeals"
	pipelineReportCapabilityID           = "crm.pipelineReport"
	listTasksCapabilityID                = "crm.listTasks"
	customerTimelineCapabilityID         = "crm.customerTimeline"
	createInvoiceCapabilityID            = "accounting.createInvoice"
	recordFxRateCapabilityID             = "accounting.recordFxRate"
	recordPaymentCapabilityID            = "accounting.recordPayment"
	reversePaymentCapabilityID           = "accounting.reversePayment"
	trialBalanceCapabilityID             = "accounting.trialBalance"
	createProjectCapabilityID            = "projects.createProject"
	archiveProjectCapabilityID           = "projects.archiveProject"
	createProjectTaskCapabilityID        = "projects.createTask"
	moveProjectTaskCapabilityID          = "projects.moveTask"
	assignProjectTaskCapabilityID        = "projects.assignTask"
	iamListMembersCapabilityID           = "iam.listMembers"
	iamCreateRoleCapabilityID            = "iam.createRole"
	iamUpdateRolePermissionsCapabilityID = "iam.updateRolePermissions"
	iamAssignRoleCapabilityID            = "iam.assignRole"
	iamInviteMemberCapabilityID          = "iam.inviteMember"
)
const approvalTTL = 7 * 24 * time.Hour

type capabilitySpec struct {
	module              string
	permission          string
	risk                string
	moneyThresholdMinor int64
}

var capabilitySpecs = map[string]capabilitySpec{
	createCustomerCapabilityID:                   {module: "crm", permission: "crm.write", risk: "write"},
	saveCustomerViewCapabilityID:                 {module: "crm", permission: "crm.write", risk: "write"},
	restoreCustomerViewCapabilityID:              {module: "crm", permission: "crm.write", risk: "write"},
	deactivateCustomerCapabilityID:               {module: "crm", permission: "crm.write", risk: "write"},
	mergeCustomersCapabilityID:                   {module: "crm", permission: "crm.write", risk: "write"},
	restoreCustomerMergeCapabilityID:             {module: "crm", permission: "crm.write", risk: "write"},
	importCustomersCapabilityID:                  {module: "crm", permission: "crm.write", risk: "write"},
	undoCustomerImportCapabilityID:               {module: "crm", permission: "crm.write", risk: "write"},
	restoreImportedCustomersCapabilityID:         {module: "crm", permission: "crm.write", risk: "write"},
	updateCustomerProfilesCapabilityID:           {module: "crm", permission: "crm.write", risk: "write"},
	restoreCustomerProfilesCapabilityID:          {module: "crm", permission: "crm.write", risk: "write"},
	reapplyCustomerProfilesCapabilityID:          {module: "crm", permission: "crm.write", risk: "write"},
	listCustomersCapabilityID:                    {module: "crm", permission: "crm.read", risk: "read"},
	listCustomerViewsCapabilityID:                {module: "crm", permission: "crm.read", risk: "read"},
	listDealsCapabilityID:                        {module: "crm", permission: "crm.read", risk: "read"},
	documentsListDocsCapabilityID:                {module: "documents", permission: "documents.read", risk: "read"},
	pipelineReportCapabilityID:                   {module: "crm", permission: "crm.read", risk: "read"},
	listTasksCapabilityID:                        {module: "crm", permission: "crm.read", risk: "read"},
	customerTimelineCapabilityID:                 {module: "crm", permission: "crm.read", risk: "read"},
	createDealCapabilityID:                       {module: "crm", permission: "crm.write", risk: "write"},
	moveDealStageCapabilityID:                    {module: "crm", permission: "crm.write", risk: "write"},
	convertLeadCapabilityID:                      {module: "crm", permission: "crm.write", risk: "write"},
	createTaskCapabilityID:                       {module: "crm", permission: "crm.write", risk: "write"},
	completeTaskCapabilityID:                     {module: "crm", permission: "crm.write", risk: "write"},
	updateTaskDetailsCapabilityID:                {module: "crm", permission: "crm.write", risk: "write"},
	restoreTaskDetailsCapabilityID:               {module: "crm", permission: "crm.write", risk: "write"},
	createQuoteCapabilityID:                      {module: "accounting", permission: "accounting.write", risk: "write"},
	acceptQuoteCapabilityID:                      {module: "accounting", permission: "accounting.write", risk: "write"},
	declineQuoteCapabilityID:                     {module: "accounting", permission: "accounting.write", risk: "write"},
	expireQuoteCapabilityID:                      {module: "accounting", permission: "accounting.write", risk: "write"},
	listQuotesCapabilityID:                       {module: "accounting", permission: "accounting.read", risk: "read"},
	createRecurringTemplateCapabilityID:          {module: "accounting", permission: "accounting.write", risk: "write"},
	pauseRecurringTemplateCapabilityID:           {module: "accounting", permission: "accounting.write", risk: "write"},
	resumeRecurringTemplateCapabilityID:          {module: "accounting", permission: "accounting.write", risk: "write"},
	listRecurringTemplatesCapabilityID:           {module: "accounting", permission: "accounting.read", risk: "read"},
	hrHireEmployeeCapabilityID:                   {module: "hr", permission: "hr.write", risk: "write"},
	hrDeactivateEmployeeCapabilityID:             {module: "hr", permission: "hr.write", risk: "write"},
	hrListEmployeesCapabilityID:                  {module: "hr", permission: "hr.read", risk: "read"},
	hrUpdateEmployeeStructureCapabilityID:        {module: "hr", permission: "hr.write", risk: "write"},
	salesCreateOrderCapabilityID:                 {module: "sales", permission: "sales.write", risk: "write"},
	salesConfirmOrderCapabilityID:                {module: "sales", permission: "sales.write", risk: "write"},
	salesDeliverOrderCapabilityID:                {module: "sales", permission: "sales.write", risk: "write"},
	salesCancelOrderCapabilityID:                 {module: "sales", permission: "sales.write", risk: "write"},
	salesListOrdersCapabilityID:                  {module: "sales", permission: "sales.read", risk: "read"},
	createInvoiceCapabilityID:                    {module: "accounting", permission: "accounting.write", risk: "write"},
	recordFxRateCapabilityID:                     {module: "accounting", permission: "accounting.post", risk: "write"},
	recordPaymentCapabilityID:                    {module: "accounting", permission: "accounting.post", risk: "money", moneyThresholdMinor: 50_000},
	reversePaymentCapabilityID:                   {module: "accounting", permission: "accounting.post", risk: "money"},
	trialBalanceCapabilityID:                     {module: "accounting", permission: "accounting.read", risk: "read"},
	submitExpenseClaimCapabilityID:               {module: "accounting", permission: "expenses.submit", risk: "write"},
	decideExpenseClaimCapabilityID:               {module: "accounting", permission: "expenses.decide", risk: "write"},
	payExpenseClaimCapabilityID:                  {module: "accounting", permission: "accounting.post", risk: "money", moneyThresholdMinor: 50_000},
	listExpenseClaimsCapabilityID:                {module: "accounting", permission: "expenses.decide", risk: "read"},
	listExpensePoliciesCapabilityID:              {module: "accounting", permission: "expenses.decide", risk: "read"},
	setExpensePolicyCapabilityID:                 {module: "accounting", permission: "expenses.decide", risk: "write"},
	createVendorCapabilityID:                     {module: "purchasing", permission: "purchasing.write", risk: "write"},
	createPurchaseOrderCapabilityID:              {module: "purchasing", permission: "purchasing.write", risk: "write"},
	receiveGoodsCapabilityID:                     {module: "purchasing", permission: "purchasing.write", risk: "write"},
	returnGoodsCapabilityID:                      {module: "purchasing", permission: "purchasing.write", risk: "write"},
	createBillCapabilityID:                       {module: "purchasing", permission: "purchasing.write", risk: "write"},
	payBillCapabilityID:                          {module: "purchasing", permission: "purchasing.post", risk: "money", moneyThresholdMinor: 50_000},
	reverseVendorPaymentCapabilityID:             {module: "purchasing", permission: "purchasing.post", risk: "money"},
	inventoryAdjustStockCapabilityID:             {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryCreateCycleCountCapabilityID:        {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryRecordCycleCountsCapabilityID:       {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryPostCycleCountCapabilityID:          {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryCancelCycleCountCapabilityID:        {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryCreateTransferCapabilityID:          {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryConfirmTransferCapabilityID:         {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryCancelTransferCapabilityID:          {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryReverseTransferCapabilityID:         {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryListTransfersCapabilityID:           {module: "inventory", permission: "inventory.read", risk: "read"},
	posOpenSessionCapabilityID:                   {module: "pos", permission: "pos.write", risk: "write"},
	posCompleteSaleCapabilityID:                  {module: "pos", permission: "pos.sell", risk: "money", moneyThresholdMinor: 100_000},
	posCloseSessionCapabilityID:                  {module: "pos", permission: "pos.write", risk: "write"},
	posReturnSaleCapabilityID:                    {module: "pos", permission: "pos.sell", risk: "money"},
	posShiftSummaryCapabilityID:                  {module: "pos", permission: "pos.read", risk: "read"},
	creditNoteCapabilityID:                       {module: "accounting", permission: "accounting.post", risk: "money"},
	shareInvoiceCapabilityID:                     {module: "accounting", permission: "accounting.write", risk: "write"},
	generateDueInvoicesCapabilityID:              {module: "accounting", permission: "accounting.write", risk: "write"},
	reverseEntryCapabilityID:                     {module: "accounting", permission: "accounting.post", risk: "money"},
	addBankAccountCapabilityID:                   {module: "accounting", permission: "accounting.write", risk: "write"},
	importBankFeedCapabilityID:                   {module: "accounting", permission: "accounting.write", risk: "write"},
	deleteBankTransactionCapabilityID:            {module: "accounting", permission: "accounting.write", risk: "write"},
	matchBankTransactionCapabilityID:             {module: "accounting", permission: "accounting.write", risk: "write"},
	unmatchBankTransactionCapabilityID:           {module: "accounting", permission: "accounting.write", risk: "write"},
	bankReconciliationCapabilityID:               {module: "accounting", permission: "accounting.read", risk: "read"},
	excludeBankTransactionCapabilityID:           {module: "accounting", permission: "accounting.write", risk: "write"},
	unexcludeBankTransactionCapabilityID:         {module: "accounting", permission: "accounting.write", risk: "write"},
	bankSummaryCapabilityID:                      {module: "accounting", permission: "accounting.read", risk: "read"},
	createPurchaseRequestCapabilityID:            {module: "purchasing", permission: "purchasing.write", risk: "write"},
	decidePurchaseRequestCapabilityID:            {module: "purchasing", permission: "purchasing.write", risk: "write"},
	createRfqCapabilityID:                        {module: "purchasing", permission: "purchasing.write", risk: "write"},
	recordQuoteCapabilityID:                      {module: "purchasing", permission: "purchasing.write", risk: "write"},
	selectWinningQuoteCapabilityID:               {module: "purchasing", permission: "purchasing.write", risk: "write"},
	listPurchaseWorkflowCapabilityID:             {module: "purchasing", permission: "purchasing.read", risk: "read"},
	inventoryCreateItemCapabilityID:              {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryUpdateItemCapabilityID:              {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryRestoreItemCapabilityID:             {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryArchiveItemCapabilityID:             {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryCreateLocationCapabilityID:          {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryListLocationsCapabilityID:           {module: "inventory", permission: "inventory.read", risk: "read"},
	inventoryLookupByBarcodeCapabilityID:         {module: "inventory", permission: "inventory.read", risk: "read"},
	inventoryImportItemsCapabilityID:             {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryUndoItemImportCapabilityID:          {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryRestoreItemImportCapabilityID:       {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryReserveStockCapabilityID:            {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryReleaseReservationCapabilityID:      {module: "inventory", permission: "inventory.write", risk: "write"},
	inventoryListReservationsCapabilityID:        {module: "inventory", permission: "inventory.read", risk: "read"},
	createPaymentRunCapabilityID:                 {module: "purchasing", permission: "purchasing.write", risk: "write"},
	cancelPaymentRunDraftCapabilityID:            {module: "purchasing", permission: "purchasing.write", risk: "write"},
	restorePaymentRunDraftCapabilityID:           {module: "purchasing", permission: "purchasing.write", risk: "write"},
	instructPaymentRunCapabilityID:               {module: "purchasing", permission: "purchasing.post", risk: "money"},
	reversePaymentRunCapabilityID:                {module: "purchasing", permission: "purchasing.post", risk: "money"},
	listPaymentRunsCapabilityID:                  {module: "purchasing", permission: "purchasing.read", risk: "read"},
	periodCloseWorkbenchCapabilityID:             {module: "accounting", permission: "accounting.read", risk: "read"},
	updatePeriodCloseCheckCapabilityID:           {module: "accounting", permission: "accounting.write", risk: "write"},
	restorePeriodCloseCheckCapabilityID:          {module: "accounting", permission: "accounting.write", risk: "write"},
	closePeriodCapabilityID:                      {module: "accounting", permission: "accounting.admin", risk: "destructive"},
	reopenPeriodCapabilityID:                     {module: "accounting", permission: "accounting.admin", risk: "destructive"},
	closeYearCapabilityID:                        {module: "accounting", permission: "accounting.admin", risk: "destructive"},
	saveBudgetScenarioCapabilityID:               {module: "accounting", permission: "accounting.write", risk: "write"},
	undoBudgetScenarioVersionCapabilityID:        {module: "accounting", permission: "accounting.write", risk: "write"},
	restoreBudgetScenarioVersionCapabilityID:     {module: "accounting", permission: "accounting.write", risk: "write"},
	listBudgetScenariosCapabilityID:              {module: "accounting", permission: "accounting.read", risk: "read"},
	budgetActualVsPlanCapabilityID:               {module: "accounting", permission: "accounting.read", risk: "read"},
	createTaxProfileCapabilityID:                 {module: "accounting", permission: "accounting.admin", risk: "write"},
	removeTaxProfileCapabilityID:                 {module: "accounting", permission: "accounting.admin", risk: "write"},
	createTaxCodeCapabilityID:                    {module: "accounting", permission: "accounting.admin", risk: "write"},
	archiveTaxCodeCapabilityID:                   {module: "accounting", permission: "accounting.admin", risk: "write"},
	activateTaxCodeCapabilityID:                  {module: "accounting", permission: "accounting.admin", risk: "write"},
	createTaxReturnCapabilityID:                  {module: "accounting", permission: "accounting.write", risk: "write"},
	cancelTaxReturnDraftCapabilityID:             {module: "accounting", permission: "accounting.write", risk: "write"},
	restoreTaxReturnDraftCapabilityID:            {module: "accounting", permission: "accounting.write", risk: "write"},
	recordTaxReturnSubmissionCapabilityID:        {module: "accounting", permission: "accounting.post", risk: "money"},
	createTaxReturnAmendmentCapabilityID:         {module: "accounting", permission: "accounting.write", risk: "write"},
	recordTaxReturnAcknowledgmentCapabilityID:    {module: "accounting", permission: "accounting.admin", risk: "write"},
	fileSalesTaxReturnCapabilityID:               {module: "accounting", permission: "accounting.post", risk: "money"},
	hrRequestLeaveCapabilityID:                   {module: "hr", permission: "hr.write", risk: "write"},
	hrCancelLeaveCapabilityID:                    {module: "hr", permission: "hr.write", risk: "write"},
	hrDecideLeaveCapabilityID:                    {module: "hr", permission: "hr.write", risk: "write"},
	hrLogTimeCapabilityID:                        {module: "hr", permission: "hr.write", risk: "write"},
	hrDecideTimeEntryCapabilityID:                {module: "hr", permission: "hr.write", risk: "write"},
	hrClockInCapabilityID:                        {module: "hr", permission: "hr.write", risk: "write"},
	hrClockOutCapabilityID:                       {module: "hr", permission: "hr.write", risk: "write"},
	hrLeaveBalanceCapabilityID:                   {module: "hr", permission: "hr.read", risk: "read"},
	hrLeaveCalendarCapabilityID:                  {module: "hr", permission: "hr.read", risk: "read"},
	hrTimeReportCapabilityID:                     {module: "hr", permission: "hr.read", risk: "read"},
	hrCreatePayrollRunCapabilityID:               {module: "hr", permission: "hr.write", risk: "write"},
	hrExecutePayrollRunCapabilityID:              {module: "hr", permission: "hr.write", risk: "money", moneyThresholdMinor: 0},
	hrVoidPayrollRunCapabilityID:                 {module: "hr", permission: "hr.write", risk: "destructive"},
	hrReversePayrollPostingCapabilityID:          {module: "hr", permission: "hr.write", risk: "destructive"},
	hrAddApplicantCapabilityID:                   {module: "hr", permission: "hr.write", risk: "write"},
	hrMoveApplicantCapabilityID:                  {module: "hr", permission: "hr.write", risk: "write"},
	hrHireApplicantCapabilityID:                  {module: "hr", permission: "hr.write", risk: "write"},
	hrListApplicantsCapabilityID:                 {module: "hr", permission: "hr.read", risk: "read"},
	billCreditNoteCapabilityID:                   {module: "purchasing", permission: "purchasing.write", risk: "money"},
	closePurchaseOrderCapabilityID:               {module: "purchasing", permission: "purchasing.write", risk: "write"},
	listReceiptsCapabilityID:                     {module: "purchasing", permission: "purchasing.read", risk: "read"},
	inventoryPostValuationSummaryCapabilityID:    {module: "inventory", permission: "inventory.write", risk: "money"},
	inventoryReverseValuationSummaryCapabilityID: {module: "inventory", permission: "inventory.write", risk: "money"},
	inventoryStockReportCapabilityID:             {module: "inventory", permission: "inventory.read", risk: "read"},
	inventoryItemHistoryCapabilityID:             {module: "inventory", permission: "inventory.read", risk: "read"},
	inventoryListLotsCapabilityID:                {module: "inventory", permission: "inventory.read", risk: "read"},
	inventoryRebuildStockProjectionsCapabilityID: {module: "inventory", permission: "inventory.admin", risk: "write"},
	incomeStatementCapabilityID:                  {module: "accounting", permission: "accounting.read", risk: "read"},
	balanceSheetCapabilityID:                     {module: "accounting", permission: "accounting.read", risk: "read"},
	listInvoicesCapabilityID:                     {module: "accounting", permission: "accounting.read", risk: "read"},
	arAgingCapabilityID:                          {module: "accounting", permission: "accounting.read", risk: "read"},
	cashBasisReportCapabilityID:                  {module: "accounting", permission: "accounting.read", risk: "read"},
	customerStatementCapabilityID:                {module: "accounting", permission: "accounting.read", risk: "read"},
	salesTaxReportCapabilityID:                   {module: "accounting", permission: "accounting.read", risk: "read"},
	cashFlowCapabilityID:                         {module: "accounting", permission: "accounting.read", risk: "read"},
	cashForecastCapabilityID:                     {module: "accounting", permission: "accounting.read", risk: "read"},
	unrealizedFxExposureCapabilityID:             {module: "accounting", permission: "accounting.read", risk: "read"},
	revalueForeignReceivablesCapabilityID:        {module: "accounting", permission: "accounting.post", risk: "money"},
	reversePeriodFxRevaluationCapabilityID:       {module: "accounting", permission: "accounting.post", risk: "money"},
	createProjectCapabilityID:                    {module: "projects", permission: "projects.write", risk: "write"},
	ProjectBoardReadCapabilityID:                 {module: "projects", permission: "projects.read", risk: "read"},
	archiveProjectCapabilityID:                   {module: "projects", permission: "projects.write", risk: "write"},
	createProjectTaskCapabilityID:                {module: "projects", permission: "projects.write", risk: "write"},
	moveProjectTaskCapabilityID:                  {module: "projects", permission: "projects.write", risk: "write"},
	assignProjectTaskCapabilityID:                {module: "projects", permission: "projects.write", risk: "write"},
	iamListMembersCapabilityID:                   {module: "iam", permission: "iam.read", risk: "read"},
	iamCreateRoleCapabilityID:                    {module: "iam", permission: "iam.admin", risk: "identity"},
	iamUpdateRolePermissionsCapabilityID:         {module: "iam", permission: "iam.admin", risk: "identity"},
	iamAssignRoleCapabilityID:                    {module: "iam", permission: "iam.admin", risk: "identity"},
	iamInviteMemberCapabilityID:                  {module: "iam", permission: "iam.admin", risk: "write"},
}

func supportedCapability(capabilityID string) bool {
	switch capabilityID {
	case createCustomerCapabilityID, deactivateCustomerCapabilityID, saveCustomerViewCapabilityID, restoreCustomerViewCapabilityID,
		mergeCustomersCapabilityID, restoreCustomerMergeCapabilityID, importCustomersCapabilityID,
		undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID,
		updateCustomerProfilesCapabilityID, restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID,
		listCustomersCapabilityID, listCustomerViewsCapabilityID, listDealsCapabilityID, documentsListDocsCapabilityID, pipelineReportCapabilityID, listTasksCapabilityID, customerTimelineCapabilityID,
		createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID,
		createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID,
		createQuoteCapabilityID, acceptQuoteCapabilityID, declineQuoteCapabilityID, expireQuoteCapabilityID, listQuotesCapabilityID,
		createRecurringTemplateCapabilityID, pauseRecurringTemplateCapabilityID, resumeRecurringTemplateCapabilityID, listRecurringTemplatesCapabilityID,
		hrHireEmployeeCapabilityID, hrDeactivateEmployeeCapabilityID, hrListEmployeesCapabilityID, hrUpdateEmployeeStructureCapabilityID,
		salesCreateOrderCapabilityID, salesConfirmOrderCapabilityID, salesDeliverOrderCapabilityID, salesCancelOrderCapabilityID, salesListOrdersCapabilityID,
		createInvoiceCapabilityID, recordFxRateCapabilityID, recordPaymentCapabilityID, reversePaymentCapabilityID, trialBalanceCapabilityID,
		submitExpenseClaimCapabilityID, decideExpenseClaimCapabilityID, payExpenseClaimCapabilityID, listExpenseClaimsCapabilityID, listExpensePoliciesCapabilityID, setExpensePolicyCapabilityID,
		createVendorCapabilityID, createPurchaseOrderCapabilityID, receiveGoodsCapabilityID, returnGoodsCapabilityID, createBillCapabilityID, payBillCapabilityID, reverseVendorPaymentCapabilityID,
		inventoryAdjustStockCapabilityID, inventoryCreateTransferCapabilityID, inventoryConfirmTransferCapabilityID,
		inventoryCancelTransferCapabilityID, inventoryReverseTransferCapabilityID, inventoryListTransfersCapabilityID,
		inventoryCreateCycleCountCapabilityID, inventoryRecordCycleCountsCapabilityID,
		inventoryPostCycleCountCapabilityID, inventoryCancelCycleCountCapabilityID,
		posOpenSessionCapabilityID, posCompleteSaleCapabilityID, posCloseSessionCapabilityID, posReturnSaleCapabilityID, posShiftSummaryCapabilityID,
		creditNoteCapabilityID, shareInvoiceCapabilityID, generateDueInvoicesCapabilityID, reverseEntryCapabilityID,
		addBankAccountCapabilityID, importBankFeedCapabilityID, deleteBankTransactionCapabilityID, matchBankTransactionCapabilityID,
		unmatchBankTransactionCapabilityID, bankReconciliationCapabilityID, excludeBankTransactionCapabilityID,
		unexcludeBankTransactionCapabilityID, bankSummaryCapabilityID,
		createPurchaseRequestCapabilityID, decidePurchaseRequestCapabilityID, createRfqCapabilityID, recordQuoteCapabilityID,
		selectWinningQuoteCapabilityID, listPurchaseWorkflowCapabilityID,
		inventoryCreateItemCapabilityID, inventoryUpdateItemCapabilityID, inventoryRestoreItemCapabilityID,
		inventoryArchiveItemCapabilityID, inventoryCreateLocationCapabilityID, inventoryListLocationsCapabilityID,
		inventoryLookupByBarcodeCapabilityID,
		inventoryImportItemsCapabilityID, inventoryUndoItemImportCapabilityID, inventoryRestoreItemImportCapabilityID,
		inventoryReserveStockCapabilityID, inventoryReleaseReservationCapabilityID, inventoryListReservationsCapabilityID,
		createPaymentRunCapabilityID, cancelPaymentRunDraftCapabilityID, restorePaymentRunDraftCapabilityID,
		instructPaymentRunCapabilityID, reversePaymentRunCapabilityID, listPaymentRunsCapabilityID,
		periodCloseWorkbenchCapabilityID, updatePeriodCloseCheckCapabilityID, restorePeriodCloseCheckCapabilityID,
		closePeriodCapabilityID, reopenPeriodCapabilityID, closeYearCapabilityID,
		saveBudgetScenarioCapabilityID, undoBudgetScenarioVersionCapabilityID, restoreBudgetScenarioVersionCapabilityID,
		listBudgetScenariosCapabilityID, budgetActualVsPlanCapabilityID,
		createTaxProfileCapabilityID, removeTaxProfileCapabilityID, createTaxCodeCapabilityID,
		archiveTaxCodeCapabilityID, activateTaxCodeCapabilityID,
		createTaxReturnCapabilityID, cancelTaxReturnDraftCapabilityID, restoreTaxReturnDraftCapabilityID,
		recordTaxReturnSubmissionCapabilityID, createTaxReturnAmendmentCapabilityID,
		recordTaxReturnAcknowledgmentCapabilityID, fileSalesTaxReturnCapabilityID,
		hrRequestLeaveCapabilityID, hrCancelLeaveCapabilityID, hrDecideLeaveCapabilityID,
		hrLogTimeCapabilityID, hrDecideTimeEntryCapabilityID, hrClockInCapabilityID, hrClockOutCapabilityID,
		hrLeaveBalanceCapabilityID, hrLeaveCalendarCapabilityID, hrTimeReportCapabilityID,
		hrCreatePayrollRunCapabilityID, hrExecutePayrollRunCapabilityID, hrVoidPayrollRunCapabilityID,
		hrReversePayrollPostingCapabilityID, hrAddApplicantCapabilityID, hrMoveApplicantCapabilityID,
		hrHireApplicantCapabilityID, hrListApplicantsCapabilityID,
		billCreditNoteCapabilityID, closePurchaseOrderCapabilityID, listReceiptsCapabilityID,
		inventoryPostValuationSummaryCapabilityID, inventoryReverseValuationSummaryCapabilityID,
		inventoryStockReportCapabilityID, inventoryItemHistoryCapabilityID, inventoryListLotsCapabilityID,
		inventoryRebuildStockProjectionsCapabilityID,
		incomeStatementCapabilityID, balanceSheetCapabilityID, listInvoicesCapabilityID, arAgingCapabilityID,
		cashBasisReportCapabilityID, customerStatementCapabilityID, salesTaxReportCapabilityID,
		cashFlowCapabilityID, cashForecastCapabilityID,
		unrealizedFxExposureCapabilityID, revalueForeignReceivablesCapabilityID, reversePeriodFxRevaluationCapabilityID,
		createProjectCapabilityID, ProjectBoardReadCapabilityID, archiveProjectCapabilityID, createProjectTaskCapabilityID, moveProjectTaskCapabilityID, assignProjectTaskCapabilityID,
		iamListMembersCapabilityID, iamCreateRoleCapabilityID, iamUpdateRolePermissionsCapabilityID, iamAssignRoleCapabilityID, iamInviteMemberCapabilityID:
		return true
	default:
		return false
	}
}

var (
	ErrSessionInvalid = errors.New("authenticated session is no longer valid")
	ErrNotMember      = errors.New("user is not a member of the requested organization")
	ErrScopeMismatch  = errors.New("capability assertion does not match the input")
)

type Result struct {
	OK                bool            `json:"ok"`
	Data              json.RawMessage `json:"data,omitempty"`
	Error             string          `json:"error,omitempty"`
	PendingApproval   bool            `json:"pendingApproval,omitempty"`
	ApprovalID        string          `json:"approvalId,omitempty"`
	ApprovalRationale string          `json:"approvalRationale,omitempty"`
	Replayed          bool            `json:"replayed,omitempty"`
}

// SystemClaims are accepted only by ExecuteSystem, which is an internal
// worker entrypoint and is not represented by an auth-bridge assertion.
type SystemClaims struct {
	OrganizationID     string
	CapabilityID       string
	Permission         string
	IntentID           string
	ApprovedApprovalID string
}

type Executor struct {
	pool       dbx.Beginner
	webhookURL string
	smtpHost   string
	smtpTo     string
}

func NewExecutor(pool dbx.Beginner, webhookURL, smtpHost, smtpTo string) *Executor {
	return &Executor{pool: pool, webhookURL: webhookURL, smtpHost: smtpHost, smtpTo: smtpTo}
}

func (e *Executor) Execute(
	ctx context.Context,
	claims authbridge.CapabilityClaims,
	capabilityID string,
	rawInput json.RawMessage,
) (Result, error) {
	return e.execute(ctx, claims, capabilityID, rawInput, false, "")
}

// ExecuteSystem runs a queued capability as the same least-privilege system
// actor used by the TypeScript worker. Actor identity is fixed here, never
// accepted from the caller. The job UUID is the stable receipt intent.
func (e *Executor) ExecuteSystem(ctx context.Context, request SystemClaims, rawInput json.RawMessage) (Result, error) {
	if e == nil || e.pool == nil {
		return Result{}, errors.New("capability executor is unavailable")
	}
	spec, supported := capabilitySpecs[request.CapabilityID]
	if !supportedCapability(request.CapabilityID) || !supported {
		return Result{OK: false, Error: "unknown capability: " + request.CapabilityID}, nil
	}
	if !isUUID(request.OrganizationID) || !isUUID(request.IntentID) {
		return Result{}, ErrScopeMismatch
	}
	if request.Permission != spec.permission {
		return Result{}, ErrSystemPermissionMismatch
	}
	if request.ApprovedApprovalID != "" && !isUUID(request.ApprovedApprovalID) {
		return Result{}, ErrScopeMismatch
	}
	digest, err := InputHash(rawInput)
	if err != nil {
		return Result{}, err
	}
	claims := authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		OrganizationID: request.OrganizationID,
		CapabilityID:   request.CapabilityID,
		InputSHA256:    digest,
		ActorType:      "system",
		Permissions:    []string{spec.permission},
		IntentID:       request.IntentID,
	}
	return e.execute(ctx, claims, request.CapabilityID, rawInput, true, request.ApprovedApprovalID)
}

var ErrSystemPermissionMismatch = errors.New("system capability permission does not match its declaration")

func (e *Executor) execute(
	ctx context.Context,
	claims authbridge.CapabilityClaims,
	capabilityID string,
	rawInput json.RawMessage,
	system bool,
	approvedApprovalID string,
) (Result, error) {
	if e == nil || e.pool == nil {
		return Result{}, errors.New("capability executor is unavailable")
	}
	spec, supported := capabilitySpecs[capabilityID]
	if !supportedCapability(capabilityID) || !supported || claims.CapabilityID != capabilityID {
		return Result{OK: false, Error: "unknown capability: " + capabilityID}, nil
	}
	inputDigest, err := InputHash(rawInput)
	if err != nil || inputDigest != claims.InputSHA256 {
		return Result{}, ErrScopeMismatch
	}
	if system {
		if claims.ActorType != "system" || claims.Subject != "" || claims.ActorID != nil || claims.AuthSessionID != "" || claims.AgentSessionID != "" {
			return Result{}, ErrSessionInvalid
		}
	} else if !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil || !isUUID(*claims.ActorID) || *claims.ActorID != claims.Subject {
		return Result{}, ErrSessionInvalid
	}
	if (capabilityID == saveCustomerViewCapabilityID || capabilityID == restoreCustomerViewCapabilityID) &&
		(system || claims.ActorType != "human" || claims.ActorID == nil || *claims.ActorID != claims.Subject || claims.AuthSessionID == "") {
		return Result{}, ErrSessionInvalid
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	return dbx.WithOrgTx(ctx, e.pool, claims.OrganizationID, func(tx pgx.Tx) (Result, error) {
		if !system {
			if err := verifyIdentity(ctx, tx, claims, now); err != nil {
				return Result{}, err
			}
		}
		if !isUUID(claims.OrganizationID) {
			return Result{}, ErrScopeMismatch
		}
		if system && claims.IntentID == "" {
			return Result{}, ErrScopeMismatch
		}

		enabled, err := isModuleEnabled(ctx, tx, claims.OrganizationID, spec.module)
		if err != nil {
			return Result{}, err
		}
		if !enabled {
			return Result{OK: false, Error: fmt.Sprintf("module %q is disabled for this organization", spec.module)}, nil
		}

		var input any
		switch capabilityID {
		case createCustomerCapabilityID:
			parsed, err := ParseCreateCustomerInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case saveCustomerViewCapabilityID:
			parsed, err := ParseSaveCustomerViewInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case restoreCustomerViewCapabilityID:
			parsed, err := ParseRestoreCustomerViewInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case listCustomersCapabilityID:
			parsed, err := ParseListCustomersInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case listCustomerViewsCapabilityID:
			parsed, err := parseListCustomerViewsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			parsed.UserID = claims.ActorID
			input = parsed
		case listDealsCapabilityID:
			parsed, err := ParseListDealsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case documentsListDocsCapabilityID:
			parsed, err := ParseListAuthoredDocsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case pipelineReportCapabilityID:
			parsed, err := ParsePipelineReportInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case listTasksCapabilityID:
			parsed, err := ParseListTasksInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case customerTimelineCapabilityID:
			parsed, err := ParseCustomerTimelineInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID:
			parsed, err := parseCRMDealInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID:
			parsed, err := parseCRMTaskInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createQuoteCapabilityID, acceptQuoteCapabilityID, declineQuoteCapabilityID, expireQuoteCapabilityID, listQuotesCapabilityID:
			parsed, err := parseAccountingQuoteInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createRecurringTemplateCapabilityID, pauseRecurringTemplateCapabilityID, resumeRecurringTemplateCapabilityID, listRecurringTemplatesCapabilityID:
			parsed, err := parseAccountingRecurringInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case hrHireEmployeeCapabilityID, hrDeactivateEmployeeCapabilityID, hrListEmployeesCapabilityID, hrUpdateEmployeeStructureCapabilityID:
			parsed, err := parseHREmployeeInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case salesCreateOrderCapabilityID, salesConfirmOrderCapabilityID, salesDeliverOrderCapabilityID, salesCancelOrderCapabilityID, salesListOrdersCapabilityID:
			parsed, err := parseSalesInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case deactivateCustomerCapabilityID:
			parsed, err := ParseDeactivateCustomerInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case mergeCustomersCapabilityID:
			parsed, err := ParseCustomerMergeInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case restoreCustomerMergeCapabilityID:
			parsed, err := ParseCustomerMergeSnapshotInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case importCustomersCapabilityID:
			parsed, err := ParseCustomerImportInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID:
			parsed, err := ParseCustomerIDsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case updateCustomerProfilesCapabilityID:
			parsed, err := ParseCustomerProfileUpdateInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID:
			parsed, err := ParseCustomerProfileSnapshotsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createInvoiceCapabilityID:
			parsed, err := ParseCreateInvoiceInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case recordFxRateCapabilityID:
			parsed, err := ParseRecordFxRateInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case recordPaymentCapabilityID:
			parsed, err := ParseRecordPaymentInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case reversePaymentCapabilityID:
			parsed, err := ParseReversePaymentInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case trialBalanceCapabilityID:
			parsed, err := ParseTrialBalanceInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createProjectCapabilityID:
			parsed, err := ParseCreateProjectInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case ProjectBoardReadCapabilityID:
			parsed, err := ParseProjectBoardInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case archiveProjectCapabilityID:
			parsed, err := ParseArchiveProjectInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createProjectTaskCapabilityID:
			parsed, err := ParseCreateProjectTaskInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case moveProjectTaskCapabilityID:
			parsed, err := ParseMoveProjectTaskInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case assignProjectTaskCapabilityID:
			parsed, err := ParseAssignProjectTaskInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case submitExpenseClaimCapabilityID, decideExpenseClaimCapabilityID, payExpenseClaimCapabilityID, listExpenseClaimsCapabilityID, listExpensePoliciesCapabilityID, setExpensePolicyCapabilityID:
			parsed, err := parseAccountingExpenseInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createPurchaseOrderCapabilityID:
			parsed, err := ParseCreatePurchaseOrderInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case receiveGoodsCapabilityID:
			parsed, err := ParseReceiveGoodsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case returnGoodsCapabilityID:
			parsed, err := ParseReturnGoodsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createVendorCapabilityID, createBillCapabilityID, payBillCapabilityID, reverseVendorPaymentCapabilityID:
			parsed, err := parsePurchasingBillInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case inventoryAdjustStockCapabilityID, inventoryCreateTransferCapabilityID, inventoryConfirmTransferCapabilityID,
			inventoryCancelTransferCapabilityID, inventoryReverseTransferCapabilityID, inventoryListTransfersCapabilityID:
			parsed, err := parseInventoryStockInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case inventoryCreateCycleCountCapabilityID, inventoryRecordCycleCountsCapabilityID,
			inventoryPostCycleCountCapabilityID, inventoryCancelCycleCountCapabilityID:
			parsed, err := parseInventoryCycleCountInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case posOpenSessionCapabilityID, posCompleteSaleCapabilityID, posCloseSessionCapabilityID, posReturnSaleCapabilityID, posShiftSummaryCapabilityID:
			parsed, err := parsePosSaleInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case creditNoteCapabilityID, shareInvoiceCapabilityID, generateDueInvoicesCapabilityID, reverseEntryCapabilityID:
			parsed, err := parseAccountingInvoiceOpsInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case addBankAccountCapabilityID, importBankFeedCapabilityID, deleteBankTransactionCapabilityID, matchBankTransactionCapabilityID,
			unmatchBankTransactionCapabilityID, bankReconciliationCapabilityID, excludeBankTransactionCapabilityID,
			unexcludeBankTransactionCapabilityID, bankSummaryCapabilityID:
			parsed, err := parseBankingInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createPurchaseRequestCapabilityID, decidePurchaseRequestCapabilityID, createRfqCapabilityID, recordQuoteCapabilityID,
			selectWinningQuoteCapabilityID, listPurchaseWorkflowCapabilityID:
			parsed, err := parsePurchasingRequestInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case inventoryCreateItemCapabilityID, inventoryUpdateItemCapabilityID, inventoryRestoreItemCapabilityID,
			inventoryArchiveItemCapabilityID, inventoryCreateLocationCapabilityID, inventoryListLocationsCapabilityID,
			inventoryLookupByBarcodeCapabilityID:
			parsed, err := parseInventoryItemInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case inventoryImportItemsCapabilityID, inventoryUndoItemImportCapabilityID, inventoryRestoreItemImportCapabilityID,
			inventoryReserveStockCapabilityID, inventoryReleaseReservationCapabilityID, inventoryListReservationsCapabilityID:
			parsed, err := parseInventoryImportInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createPaymentRunCapabilityID, cancelPaymentRunDraftCapabilityID, restorePaymentRunDraftCapabilityID,
			instructPaymentRunCapabilityID, reversePaymentRunCapabilityID, listPaymentRunsCapabilityID:
			parsed, err := parsePurchasingPaymentRunInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case periodCloseWorkbenchCapabilityID, updatePeriodCloseCheckCapabilityID, restorePeriodCloseCheckCapabilityID,
			closePeriodCapabilityID, reopenPeriodCapabilityID, closeYearCapabilityID:
			parsed, err := parseAccountingPeriodCloseInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case saveBudgetScenarioCapabilityID, undoBudgetScenarioVersionCapabilityID, restoreBudgetScenarioVersionCapabilityID,
			listBudgetScenariosCapabilityID, budgetActualVsPlanCapabilityID:
			parsed, err := parseAccountingBudgetInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createTaxProfileCapabilityID, removeTaxProfileCapabilityID, createTaxCodeCapabilityID,
			archiveTaxCodeCapabilityID, activateTaxCodeCapabilityID:
			parsed, err := parseAccountingTaxMasterInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createTaxReturnCapabilityID, cancelTaxReturnDraftCapabilityID, restoreTaxReturnDraftCapabilityID,
			recordTaxReturnSubmissionCapabilityID, createTaxReturnAmendmentCapabilityID,
			recordTaxReturnAcknowledgmentCapabilityID, fileSalesTaxReturnCapabilityID:
			parsed, err := parseAccountingTaxReturnInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case hrRequestLeaveCapabilityID, hrCancelLeaveCapabilityID, hrDecideLeaveCapabilityID,
			hrLogTimeCapabilityID, hrDecideTimeEntryCapabilityID, hrClockInCapabilityID, hrClockOutCapabilityID,
			hrLeaveBalanceCapabilityID, hrLeaveCalendarCapabilityID, hrTimeReportCapabilityID:
			parsed, err := parseHRLeaveTimeInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case hrCreatePayrollRunCapabilityID, hrExecutePayrollRunCapabilityID, hrVoidPayrollRunCapabilityID,
			hrReversePayrollPostingCapabilityID, hrAddApplicantCapabilityID, hrMoveApplicantCapabilityID,
			hrHireApplicantCapabilityID, hrListApplicantsCapabilityID:
			parsed, err := parseHRPayrollApplicantInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case billCreditNoteCapabilityID, closePurchaseOrderCapabilityID, listReceiptsCapabilityID:
			parsed, err := parsePurchasingLifecycleInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case inventoryPostValuationSummaryCapabilityID, inventoryReverseValuationSummaryCapabilityID,
			inventoryStockReportCapabilityID, inventoryItemHistoryCapabilityID, inventoryListLotsCapabilityID,
			inventoryRebuildStockProjectionsCapabilityID:
			parsed, err := parseInventoryValuationInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case incomeStatementCapabilityID, balanceSheetCapabilityID, listInvoicesCapabilityID, arAgingCapabilityID,
			cashBasisReportCapabilityID, customerStatementCapabilityID, salesTaxReportCapabilityID,
			cashFlowCapabilityID, cashForecastCapabilityID:
			parsed, err := parseAccountingReportInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case unrealizedFxExposureCapabilityID, revalueForeignReceivablesCapabilityID, reversePeriodFxRevaluationCapabilityID:
			parsed, err := parseAccountingFxInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case iamListMembersCapabilityID, iamCreateRoleCapabilityID, iamUpdateRolePermissionsCapabilityID,
			iamAssignRoleCapabilityID, iamInviteMemberCapabilityID:
			parsed, err := parseIAMInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		}
		inputHash, err := canonicalInputHash(input)
		if err != nil {
			return Result{}, err
		}
		permissions := map[string]bool{}
		if system {
			permissions[spec.permission] = true
		} else {
			permissions, err = effectivePermissions(ctx, tx, claims)
			if err != nil {
				return Result{}, err
			}
		}
		if !permissions["*"] && !permissions[spec.permission] {
			return Result{OK: false, Error: "forbidden: missing permission: " + spec.permission}, nil
		}

		requiresApproval, rationale, err := requiresApproval(ctx, tx, claims, capabilityID, spec, input)
		if err != nil {
			return Result{}, err
		}
		if system && requiresApproval && approvedApprovalID == "" && spec.risk == "money" {
			return Result{OK: false, Error: "system money actions require a verified human approval"}, nil
		}
		if system && requiresApproval && approvedApprovalID != "" {
			valid, err := verifySystemApproval(ctx, tx, claims.OrganizationID, capabilityID, approvedApprovalID, inputHash, now)
			if err != nil {
				return Result{}, err
			}
			if !valid {
				return Result{OK: false, Error: approvalVerificationError}, nil
			}
		}
		if requiresApproval {
			if approvedApprovalID == "" {
				approvalID, err := e.requestApproval(ctx, tx, claims, capabilityID, spec.risk, input, rationale, now)
				if err != nil {
					return Result{}, err
				}
				return Result{OK: false, PendingApproval: true, ApprovalID: approvalID, ApprovalRationale: rationale, Error: "pending human approval"}, nil
			}
			payload, err := marshalJS(struct {
				CapabilityID string `json:"capabilityId"`
				ApprovalID   string `json:"approvalId"`
			}{CapabilityID: capabilityID, ApprovalID: approvedApprovalID})
			if err != nil {
				return Result{}, err
			}
			capID := capabilityID
			if _, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
				OrgID: claims.OrganizationID, ActorType: claims.ActorType, ActorID: claims.ActorID,
				Kind: "approval.granted", CapabilityID: &capID, Payload: payload, OccurredAt: now,
			}); err != nil {
				return Result{}, err
			}
		}
		intentKey := ""
		if claims.IntentID != "" {
			intentKey = claims.OrganizationID + ":" + claims.IntentID
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, claims.OrganizationID, claims.IntentID); err != nil {
				return Result{}, err
			}
			prior, found, err := loadReceipt(ctx, tx, claims.OrganizationID, intentKey)
			if err != nil {
				return Result{}, err
			}
			if found {
				if prior.CapabilityID != capabilityID {
					return Result{OK: false, Error: "action intent conflict: key already used for " + prior.CapabilityID}, nil
				}
				if prior.InputHash != inputHash {
					return Result{OK: false, Error: "action intent conflict: same action key used with a different payload"}, nil
				}
				return Result{OK: prior.OK, Data: prior.Data, Error: prior.Error, Replayed: true}, nil
			}
		}

		var data json.RawMessage
		switch parsed := input.(type) {
		case IAMListMembersInput:
			output, err := iamListMembers(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case IAMCreateRoleInput:
			output, err := iamCreateRole(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case IAMUpdateRolePermissionsInput:
			output, err := iamUpdateRolePermissions(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case IAMAssignRoleInput:
			output, err := iamAssignRole(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case IAMInviteMemberInput:
			output, err := iamInviteMember(ctx, tx, claims, now, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateCustomerInput:
			output, err := createCustomer(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SaveCustomerViewInput:
			output, err := saveCustomerView(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RestoreCustomerViewInput:
			output, err := restoreCustomerView(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListCustomersInput:
			output, err := listCustomers(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListCustomerViewsInput:
			output, err := listCustomerViews(ctx, tx, claims.OrganizationID, parsed.UserID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListDealsInput:
			output, err := listDeals(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PipelineReportInput:
			output, err := pipelineReport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListTasksInput:
			output, err := listTasks(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerTimelineInput:
			output, err := customerTimeline(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateDealInput:
			output, err := createDeal(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case MoveDealStageInput:
			output, err := moveDealStage(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ConvertLeadInput:
			output, err := convertLead(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateTaskInput:
			output, err := createTask(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CompleteTaskInput:
			output, err := completeTask(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case UpdateTaskDetailsInput:
			output, err := updateTaskDetails(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateQuoteInput:
			output, err := createQuote(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case AcceptQuoteInput:
			output, err := acceptQuote(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DeclineQuoteInput:
			output, err := declineQuote(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ExpireQuoteInput:
			output, err := expireQuote(ctx, tx, claims.OrganizationID, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListQuotesInput:
			output, err := listQuotes(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateRecurringTemplateInput:
			output, err := createRecurringTemplate(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PauseRecurringTemplateInput:
			output, err := pauseRecurringTemplate(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ResumeRecurringTemplateInput:
			output, err := resumeRecurringTemplate(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListRecurringTemplatesInput:
			output, err := listRecurringTemplates(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRHireEmployeeInput:
			output, err := hrHireEmployee(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRDeactivateEmployeeInput:
			output, err := hrDeactivateEmployee(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRListEmployeesInput:
			output, err := hrListEmployees(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRUpdateEmployeeStructureInput:
			output, err := hrUpdateEmployeeStructure(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesCreateOrderInput:
			output, err := salesCreateOrder(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesConfirmOrderInput:
			output, err := salesConfirmOrder(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesDeliverOrderInput:
			output, err := salesDeliverOrder(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesCancelOrderInput:
			output, err := salesCancelOrder(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesListOrdersInput:
			output, err := salesListOrders(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListAuthoredDocsInput:
			output, err := listAuthoredDocs(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DeactivateCustomerInput:
			output, err := deactivateCustomer(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerMergeInput, CustomerMergeSnapshotInput, CustomerImportInput, CustomerIDsInput:
			output, err := executeCustomerMergeCapability(ctx, tx, claims, capabilityID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerProfileUpdateInput:
			output, err := updateCustomerProfiles(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerProfileSnapshotsInput:
			output, err := applyCustomerProfileSnapshots(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateInvoiceInput:
			output, err := createInvoice(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RecordFxRateInput:
			output, err := recordFxRate(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RecordPaymentInput:
			output, err := recordPayment(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReversePaymentInput:
			output, err := reversePayment(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case TrialBalanceInput:
			output, err := trialBalance(ctx, tx, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SubmitExpenseClaimInput:
			output, err := submitExpenseClaim(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DecideExpenseClaimInput:
			output, err := decideExpenseClaim(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PayExpenseClaimInput:
			output, err := payExpenseClaim(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListExpenseClaimsInput:
			output, err := listExpenseClaims(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListExpensePoliciesInput:
			output, err := listExpensePolicies(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SetExpensePolicyInput:
			output, err := setExpensePolicy(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateVendorInput:
			output, err := createVendor(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreatePurchaseOrderInput:
			output, err := createPurchaseOrder(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReceiveGoodsInput:
			output, err := receiveGoods(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReturnGoodsInput:
			output, err := returnGoods(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateBillInput:
			output, err := createBill(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PayBillInput:
			output, err := payBill(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReverseVendorPaymentInput:
			output, err := reverseVendorPayment(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryAdjustStockInput:
			output, err := inventoryAdjustStock(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryCreateTransferInput:
			output, err := inventoryCreateTransfer(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryConfirmTransferInput:
			output, err := inventoryConfirmTransfer(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryCancelTransferInput:
			output, err := inventoryCancelTransfer(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryReverseTransferInput:
			output, err := inventoryReverseTransfer(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryListTransfersInput:
			output, err := inventoryListTransfers(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryCreateCycleCountInput:
			output, err := inventoryCreateCycleCount(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryRecordCycleCountsInput:
			output, err := inventoryRecordCycleCounts(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryPostCycleCountInput:
			output, err := inventoryPostCycleCount(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryCancelCycleCountInput:
			output, err := inventoryCancelCycleCount(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PosOpenSessionInput:
			output, err := posOpenSession(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PosCompleteSaleInput:
			output, err := posCompleteSale(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PosCloseSessionInput:
			output, err := posCloseSession(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PosReturnSaleInput:
			output, err := posReturnSale(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PosShiftSummaryInput:
			output, err := posShiftSummary(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateProjectInput:
			output, err := createProject(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ProjectBoardInput:
			output, err := listProjectBoard(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ArchiveProjectInput:
			output, err := archiveProject(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateProjectTaskInput:
			output, err := createProjectTask(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case MoveProjectTaskInput:
			output, err := moveProjectTask(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case AssignProjectTaskInput:
			output, err := assignProjectTask(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreditNoteInput:
			output, err := executeCreditNote(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ShareInvoiceInput:
			output, err := executeShareInvoice(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case GenerateDueInvoicesInput:
			output, err := executeGenerateDueInvoices(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReverseEntryInput:
			output, err := executeReverseEntry(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case AddBankAccountInput:
			output, err := addBankAccount(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ImportBankFeedInput:
			output, err := importBankFeed(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DeleteBankTransactionInput:
			output, err := deleteBankTransaction(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case MatchBankTransactionInput:
			output, err := matchBankTransaction(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case UnmatchBankTransactionInput:
			output, err := unmatchBankTransaction(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case BankReconciliationInput:
			output, err := bankReconciliation(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ExcludeBankTransactionInput:
			output, err := excludeBankTransaction(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case UnexcludeBankTransactionInput:
			output, err := unexcludeBankTransaction(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case BankSummaryInput:
			output, err := bankSummary(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreatePurchaseRequestInput:
			output, err := createPurchaseRequest(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DecidePurchaseRequestInput:
			output, err := decidePurchaseRequest(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateRfqInput:
			output, err := createRfq(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RecordQuoteInput:
			output, err := recordQuote(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SelectWinningQuoteInput:
			output, err := selectWinningQuote(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListPurchaseWorkflowInput:
			output, err := listPurchaseWorkflow(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryCreateItemInput:
			output, err := inventoryCreateItem(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryItemPatchInput:
			output, err := inventoryUpdateItem(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryArchiveItemInput:
			output, err := inventoryArchiveItem(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryCreateLocationInput:
			output, err := inventoryCreateLocation(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryListLocationsInput:
			output, err := inventoryListLocations(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryLookupByBarcodeInput:
			output, err := inventoryLookupByBarcode(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryImportItemsInput:
			output, err := inventoryImportItems(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryUndoItemImportInput:
			output, err := inventoryUndoItemImport(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryRestoreItemImportInput:
			output, err := inventoryRestoreItemImport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryReserveStockInput:
			output, err := inventoryReserveStock(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryReleaseReservationInput:
			output, err := inventoryReleaseReservation(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryListReservationsInput:
			output, err := inventoryListReservations(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreatePaymentRunInput:
			output, err := createPaymentRun(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PaymentRunIDInput:
			var output any
			var execErr error
			switch capabilityID {
			case restorePaymentRunDraftCapabilityID:
				output, execErr = restorePaymentRunDraft(ctx, tx, claims.OrganizationID, parsed)
			case instructPaymentRunCapabilityID:
				output, execErr = instructPaymentRun(ctx, tx, claims, parsed, now)
			default:
				output, execErr = cancelPaymentRunDraft(ctx, tx, claims.OrganizationID, parsed)
			}
			if execErr != nil {
				return Result{}, execErr
			}
			data, err = marshalJS(output)
		case ReversePaymentRunInput:
			output, err := reversePaymentRun(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListPaymentRunsInput:
			output, err := listPaymentRuns(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ClosePeriodInput:
			var output any
			var execErr error
			switch capabilityID {
			case periodCloseWorkbenchCapabilityID:
				output, execErr = periodCloseWorkbench(ctx, tx, claims.OrganizationID, parsed)
			case reopenPeriodCapabilityID:
				output, execErr = reopenPeriod(ctx, tx, claims.OrganizationID, parsed)
			case revalueForeignReceivablesCapabilityID:
				output, execErr = executeRevalueForeignReceivables(ctx, tx, claims, parsed, now)
			default:
				output, execErr = closePeriod(ctx, tx, claims, parsed)
			}
			if execErr != nil {
				return Result{}, execErr
			}
			data, err = marshalJS(output)
		case PeriodCloseCheckInput:
			output, err := persistPeriodCloseCheck(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CloseYearInput:
			output, err := closeYear(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SaveBudgetScenarioInput:
			output, err := saveBudgetScenario(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case BudgetScenarioVersionInput:
			var output any
			var execErr error
			if capabilityID == restoreBudgetScenarioVersionCapabilityID {
				output, execErr = restoreBudgetScenarioVersion(ctx, tx, claims.OrganizationID, parsed)
			} else {
				output, execErr = undoBudgetScenarioVersion(ctx, tx, claims.OrganizationID, parsed)
			}
			if execErr != nil {
				return Result{}, execErr
			}
			data, err = marshalJS(output)
		case ListBudgetScenariosInput:
			output, err := listBudgetScenarios(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case BudgetActualVsPlanInput:
			output, err := budgetActualVsPlan(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateTaxProfileInput:
			output, err := executeCreateTaxProfile(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RemoveTaxProfileInput:
			output, err := executeRemoveTaxProfile(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateTaxCodeInput:
			output, err := executeCreateTaxCode(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ArchiveTaxCodeInput:
			output, err := executeArchiveTaxCode(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ActivateTaxCodeInput:
			output, err := executeActivateTaxCode(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateTaxReturnInput:
			output, err := executeCreateTaxReturn(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case TaxReturnIDInput:
			var output any
			var execErr error
			switch capabilityID {
			case cancelTaxReturnDraftCapabilityID:
				output, execErr = executeCancelTaxReturnDraft(ctx, tx, claims, parsed, now)
			case restoreTaxReturnDraftCapabilityID:
				output, execErr = executeRestoreTaxReturnDraft(ctx, tx, claims, parsed, now)
			case createTaxReturnAmendmentCapabilityID:
				output, execErr = executeCreateTaxReturnAmendment(ctx, tx, claims, parsed, now)
			default:
				output, execErr = executeFileSalesTaxReturn(ctx, tx, claims, parsed, now)
			}
			if execErr != nil {
				return Result{}, execErr
			}
			data, err = marshalJS(output)
		case RecordTaxReturnSubmissionInput:
			output, err := executeRecordTaxReturnSubmission(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RecordTaxReturnAcknowledgmentInput:
			output, err := executeRecordTaxReturnAcknowledgment(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRRequestLeaveInput:
			output, err := hrRequestLeave(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRCancelLeaveInput:
			output, err := hrCancelLeave(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRDecideLeaveInput:
			output, err := hrDecideLeave(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRLogTimeInput:
			output, err := hrLogTime(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRDecideTimeEntryInput:
			output, err := hrDecideTimeEntry(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRClockInInput:
			output, err := hrClockIn(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRClockOutInput:
			output, err := hrClockOut(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRLeaveBalanceInput:
			output, err := hrLeaveBalance(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRLeaveCalendarInput:
			output, err := hrLeaveCalendar(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRTimeReportInput:
			output, err := hrTimeReport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRCreatePayrollRunInput:
			output, err := hrCreatePayrollRun(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRExecutePayrollRunInput:
			output, err := hrExecutePayrollRun(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRVoidPayrollRunInput:
			output, err := hrVoidPayrollRun(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRReversePayrollPostingInput:
			output, err := hrReversePayrollPosting(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRAddApplicantInput:
			output, err := hrAddApplicant(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRMoveApplicantInput:
			output, err := hrMoveApplicant(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRHireApplicantInput:
			output, err := hrHireApplicant(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRListApplicantsInput:
			output, err := hrListApplicants(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case BillCreditNoteInput:
			output, err := purchasingBillCreditNote(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ClosePurchaseOrderInput:
			output, err := closePurchaseOrder(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListReceiptsInput:
			output, err := listReceipts(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryPostValuationSummaryInput:
			output, err := inventoryPostValuationSummary(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryReverseValuationSummaryInput:
			output, err := inventoryReverseValuationSummary(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryStockReportInput:
			output, err := inventoryStockReport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryItemHistoryInput:
			output, err := inventoryItemHistory(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryListLotsInput:
			output, err := inventoryListLots(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case InventoryRebuildStockProjectionsInput:
			output, err := inventoryRebuildStockProjections(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case IncomeStatementInput:
			output, err := incomeStatement(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case BalanceSheetInput:
			output, err := balanceSheet(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListInvoicesInput:
			output, err := listInvoices(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ArAgingInput:
			output, err := arAging(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CashBasisReportInput:
			output, err := cashBasisReport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerStatementInput:
			output, err := customerStatement(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesTaxReportInput:
			output, err := salesTaxReport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CashFlowInput:
			output, err := cashFlow(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CashForecastInput:
			output, err := cashForecast(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case UnrealizedFxExposureInput:
			output, err := executeUnrealizedFxExposure(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReversePeriodFxRevaluationInput:
			output, err := executeReversePeriodFxRevaluation(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		default:
			return Result{}, errors.New("unsupported capability input")
		}
		if err != nil {
			return Result{}, err
		}
		payload, err := marshalJS(struct {
			Input any `json:"input"`
		}{Input: input})
		if err != nil {
			return Result{}, err
		}
		actorID := claims.ActorID
		capID := capabilityID
		var agentSessionID *string
		if claims.AgentSessionID != "" {
			agentSessionID = &claims.AgentSessionID
		}
		if _, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
			OrgID:        claims.OrganizationID,
			ActorType:    claims.ActorType,
			ActorID:      actorID,
			Kind:         "capability.executed",
			CapabilityID: &capID,
			SessionID:    agentSessionID,
			Payload:      payload,
			OccurredAt:   now,
		}); err != nil {
			return Result{}, err
		}
		result := Result{OK: true, Data: data}
		if intentKey != "" {
			if err := insertReceipt(ctx, tx, claims.OrganizationID, intentKey, capabilityID, inputHash, result); err != nil {
				return Result{}, err
			}
		}
		return result, nil
	})
}

func canonicalInputHash(input any) (string, error) {
	switch parsed := input.(type) {
	case CreateCustomerInput:
		return CanonicalInputHash(parsed)
	case SaveCustomerViewInput, RestoreCustomerViewInput:
		return canonicalHash(parsed)
	case DeactivateCustomerInput:
		return CanonicalDeactivateCustomerInputHash(parsed)
	case CustomerMergeInput:
		return parsed.CanonicalHash()
	case CustomerMergeSnapshotInput:
		return parsed.CanonicalHash()
	case CustomerImportInput:
		return parsed.CanonicalHash()
	case CustomerIDsInput:
		return parsed.CanonicalHash()
	case CustomerProfileUpdateInput:
		return parsed.CanonicalHash()
	case CustomerProfileSnapshotsInput:
		return parsed.CanonicalHash()
	case ListCustomersInput, ListCustomerViewsInput, ListDealsInput, PipelineReportInput, ListTasksInput, CustomerTimelineInput, ListAuthoredDocsInput,
		CreateDealInput, MoveDealStageInput, ConvertLeadInput,
		CreateTaskInput, CompleteTaskInput, UpdateTaskDetailsInput,
		CreateQuoteInput, AcceptQuoteInput, DeclineQuoteInput, ExpireQuoteInput, ListQuotesInput,
		CreateRecurringTemplateInput, PauseRecurringTemplateInput, ResumeRecurringTemplateInput, ListRecurringTemplatesInput,
		HRHireEmployeeInput, HRDeactivateEmployeeInput, HRListEmployeesInput, HRUpdateEmployeeStructureInput,
		SalesCreateOrderInput, SalesConfirmOrderInput, SalesDeliverOrderInput, SalesCancelOrderInput, SalesListOrdersInput,
		CreateInvoiceInput, RecordFxRateInput, RecordPaymentInput, ReversePaymentInput, TrialBalanceInput,
		SubmitExpenseClaimInput, DecideExpenseClaimInput, PayExpenseClaimInput, ListExpenseClaimsInput, ListExpensePoliciesInput, SetExpensePolicyInput,
		CreateVendorInput, CreatePurchaseOrderInput, ReceiveGoodsInput, ReturnGoodsInput, CreateBillInput, PayBillInput, ReverseVendorPaymentInput,
		InventoryAdjustStockInput, InventoryCreateTransferInput, InventoryConfirmTransferInput, InventoryCancelTransferInput,
		InventoryReverseTransferInput, InventoryListTransfersInput,
		InventoryCreateCycleCountInput, InventoryRecordCycleCountsInput, InventoryPostCycleCountInput, InventoryCancelCycleCountInput,
		PosOpenSessionInput, PosCompleteSaleInput, PosCloseSessionInput, PosReturnSaleInput, PosShiftSummaryInput,
		CreditNoteInput, ShareInvoiceInput, GenerateDueInvoicesInput, ReverseEntryInput,
		AddBankAccountInput, ImportBankFeedInput, DeleteBankTransactionInput, MatchBankTransactionInput,
		UnmatchBankTransactionInput, BankReconciliationInput, ExcludeBankTransactionInput,
		UnexcludeBankTransactionInput, BankSummaryInput,
		CreatePurchaseRequestInput, DecidePurchaseRequestInput, CreateRfqInput, RecordQuoteInput,
		SelectWinningQuoteInput, ListPurchaseWorkflowInput,
		InventoryCreateItemInput, InventoryItemPatchInput, InventoryArchiveItemInput, InventoryCreateLocationInput,
		InventoryListLocationsInput, InventoryLookupByBarcodeInput,
		InventoryImportItemsInput, InventoryUndoItemImportInput, InventoryRestoreItemImportInput,
		InventoryReserveStockInput, InventoryReleaseReservationInput, InventoryListReservationsInput,
		CreatePaymentRunInput, PaymentRunIDInput, ReversePaymentRunInput, ListPaymentRunsInput,
		ClosePeriodInput, PeriodCloseCheckInput, CloseYearInput,
		SaveBudgetScenarioInput, BudgetScenarioVersionInput, ListBudgetScenariosInput, BudgetActualVsPlanInput,
		CreateTaxProfileInput, RemoveTaxProfileInput, CreateTaxCodeInput, ArchiveTaxCodeInput, ActivateTaxCodeInput,
		CreateTaxReturnInput, TaxReturnIDInput, RecordTaxReturnSubmissionInput, RecordTaxReturnAcknowledgmentInput,
		HRRequestLeaveInput, HRCancelLeaveInput, HRDecideLeaveInput, HRLogTimeInput, HRDecideTimeEntryInput,
		HRClockInInput, HRClockOutInput, HRLeaveBalanceInput, HRLeaveCalendarInput, HRTimeReportInput,
		HRCreatePayrollRunInput, HRExecutePayrollRunInput, HRVoidPayrollRunInput, HRReversePayrollPostingInput,
		HRAddApplicantInput, HRMoveApplicantInput, HRHireApplicantInput, HRListApplicantsInput,
		BillCreditNoteInput, ClosePurchaseOrderInput, ListReceiptsInput,
		InventoryPostValuationSummaryInput, InventoryReverseValuationSummaryInput, InventoryStockReportInput,
		InventoryItemHistoryInput, InventoryListLotsInput, InventoryRebuildStockProjectionsInput,
		IncomeStatementInput, BalanceSheetInput, ListInvoicesInput, ArAgingInput, CashBasisReportInput,
		CustomerStatementInput, SalesTaxReportInput, CashFlowInput, CashForecastInput,
		UnrealizedFxExposureInput, ReversePeriodFxRevaluationInput,
		CreateProjectInput, ProjectBoardInput, ArchiveProjectInput, CreateProjectTaskInput, MoveProjectTaskInput, AssignProjectTaskInput,
		IAMListMembersInput, IAMCreateRoleInput, IAMUpdateRolePermissionsInput, IAMAssignRoleInput, IAMInviteMemberInput:
		return canonicalHash(parsed)
	default:
		return "", errors.New("unsupported capability input")
	}
}

func verifySystemApproval(
	ctx context.Context,
	tx pgx.Tx,
	orgID, capabilityID, approvalID, inputHash string,
	now time.Time,
) (bool, error) {
	var storedCapabilityID, status string
	var storedPayload []byte
	var unexpired bool
	err := tx.QueryRow(ctx, `
		SELECT capability_id, status, payload,
	       expires_at IS NULL OR expires_at > $3::timestamptz
		FROM approvals
		WHERE id = $1::uuid AND org_id = $2::uuid`, approvalID, orgID, now).
		Scan(&storedCapabilityID, &status, &storedPayload, &unexpired)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if storedCapabilityID != capabilityID || !unexpired || status != "executing" {
		return false, nil
	}
	digest, err := InputHash(storedPayload)
	if err != nil {
		return false, nil
	}
	return digest == inputHash, nil
}

func verifyIdentity(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, now time.Time) error {
	if claims.AuthSessionID == "" {
		return ErrSessionInvalid
	}
	var authEmail string
	var expiresAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT au.email, s.expires_at
		FROM auth_session s
		JOIN auth_user au ON au.id = s.user_id
		WHERE s.id = $1 AND au.email_verified = true AND s.expires_at > $2`, claims.AuthSessionID, now).Scan(&authEmail, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionInvalid
	}
	if err != nil {
		return err
	}
	if expiresAt.IsZero() || !expiresAt.After(now) {
		return ErrSessionInvalid
	}
	var member bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid)`, claims.OrganizationID, claims.Subject).Scan(&member)
	if err != nil {
		return err
	}
	if !member {
		return ErrNotMember
	}
	var domainEmail string
	err = tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1::uuid`, claims.Subject).Scan(&domainEmail)
	if errors.Is(err, pgx.ErrNoRows) || normalizeIdentityEmail(authEmail) != normalizeIdentityEmail(domainEmail) {
		return ErrSessionInvalid
	}
	if err != nil {
		return err
	}
	if claims.ActorType == "agent" {
		if claims.AgentSessionID == "" || !isUUID(claims.AgentSessionID) {
			return ErrSessionInvalid
		}
		var agentSession bool
		err = tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM agent_sessions
				WHERE id = $1::uuid AND org_id = $2::uuid AND user_id = $3::uuid AND status = 'open'
			)`, claims.AgentSessionID, claims.OrganizationID, claims.Subject).Scan(&agentSession)
		if err != nil {
			return err
		}
		if !agentSession {
			return ErrSessionInvalid
		}
	} else if claims.AgentSessionID != "" {
		return ErrSessionInvalid
	}
	return nil
}

func normalizeIdentityEmail(value string) string {
	trimmed := strings.TrimFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' })
	return cases.Lower(language.Und).String(trimmed)
}

func effectivePermissions(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT rp.permission_key
		FROM user_roles ur
		JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.org_id = ur.org_id
		WHERE ur.org_id = $1::uuid AND ur.user_id = $2::uuid`, claims.OrganizationID, claims.Subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := make(map[string]bool)
	for rows.Next() {
		var permission string
		if err := rows.Scan(&permission); err != nil {
			return nil, err
		}
		grants[permission] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	effective := make(map[string]bool)
	for _, permission := range claims.Permissions {
		if permission == "*" && grants["*"] {
			effective["*"] = true
			continue
		}
		if permission == "*" {
			for grant := range grants {
				effective[grant] = true
			}
		} else if grants[permission] || grants["*"] {
			effective[permission] = true
		}
	}
	return effective, nil
}

func isModuleEnabled(ctx context.Context, tx pgx.Tx, orgID, moduleID string) (bool, error) {
	var enabledModules []byte
	err := tx.QueryRow(ctx, `SELECT enabled_modules FROM organizations WHERE id = $1::uuid`, orgID).Scan(&enabledModules)
	if err != nil {
		return false, err
	}
	if len(enabledModules) == 0 || string(enabledModules) == "null" {
		return true, nil
	}
	var modules []string
	if err := json.Unmarshal(enabledModules, &modules); err != nil {
		return false, nil
	}
	for _, enabled := range modules {
		if enabled == moduleID {
			return true, nil
		}
	}
	return false, nil
}

type policyRule struct {
	CapabilityPattern   string
	MaxRiskAutonomous   string
	MoneyThresholdMinor *int64
	RequiresApprovalFor []string
}

func requiresApproval(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, capabilityID string, spec capabilitySpec, input any) (bool, string, error) {
	rows, err := tx.Query(ctx, `
		SELECT capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for
		FROM policies WHERE org_id = $1::uuid`, claims.OrganizationID)
	if err != nil {
		return false, "", err
	}
	defer rows.Close()
	var matching []policyRule
	for rows.Next() {
		var rule policyRule
		var requiresRaw []byte
		if err := rows.Scan(&rule.CapabilityPattern, &rule.MaxRiskAutonomous, &rule.MoneyThresholdMinor, &requiresRaw); err != nil {
			return false, "", err
		}
		if json.Unmarshal(requiresRaw, &rule.RequiresApprovalFor) != nil {
			rule.RequiresApprovalFor = nil
		}
		if matchesCapability(rule.CapabilityPattern, capabilityID) {
			matching = append(matching, rule)
		}
	}
	if err := rows.Err(); err != nil {
		return false, "", err
	}
	rows.Close()
	if claims.ActorType != "human" && claims.ActorType != "agent" && claims.ActorType != "system" {
		return false, "within policy", nil
	}
	humanStrict := false
	for _, rule := range matching {
		for _, risk := range rule.RequiresApprovalFor {
			if risk == "*" || risk == spec.risk {
				humanStrict = true
				break
			}
		}
		if humanStrict {
			break
		}
	}
	sort.Slice(matching, func(i, j int) bool {
		if len(matching[i].CapabilityPattern) != len(matching[j].CapabilityPattern) {
			return len(matching[i].CapabilityPattern) > len(matching[j].CapabilityPattern)
		}
		return riskRank(matching[i].MaxRiskAutonomous) < riskRank(matching[j].MaxRiskAutonomous)
	})
	maxRisk := "write"
	threshold := spec.moneyThresholdMinor
	if len(matching) > 0 {
		maxRisk = matching[0].MaxRiskAutonomous
		if matching[0].MoneyThresholdMinor != nil {
			threshold = *matching[0].MoneyThresholdMinor
		}
	}
	if claims.ActorType == "human" && humanStrict {
		if spec.risk == "money" {
			amount, known := moneyAmount(input)
			if !known || amount == nil {
				return true, "amount is not knowable before execution; human approval required", nil
			}
			if *amount > threshold {
				return true, fmt.Sprintf("amount %d exceeds autonomous threshold %d", *amount, threshold), nil
			}
		} else {
			return true, fmt.Sprintf("risk class %q requires human approval by organization policy", spec.risk), nil
		}
	}
	if (claims.ActorType == "agent" || claims.ActorType == "system") && (spec.risk == "identity" || spec.risk == "destructive") {
		return true, fmt.Sprintf("risk class %q always requires human authority", spec.risk), nil
	}
	if (claims.ActorType == "agent" || claims.ActorType == "system") && spec.risk == "money" {
		amount, known := moneyAmount(input)
		if !known || amount == nil {
			return true, "amount is not knowable before execution; human approval required", nil
		}
		if *amount > threshold {
			return true, fmt.Sprintf("amount %d exceeds autonomous threshold %d", *amount, threshold), nil
		}
		return false, "within policy", nil
	}
	if (claims.ActorType == "agent" || claims.ActorType == "system") && spec.risk != "money" && riskRank(spec.risk) > riskRank(maxRisk) {
		return true, fmt.Sprintf("org policy caps autonomy at %q", maxRisk), nil
	}
	return false, "within policy", nil
}

func moneyAmount(input any) (*int64, bool) {
	switch parsed := input.(type) {
	case RecordPaymentInput:
		return &parsed.AmountMinor, true
	case ReversePaymentInput:
		return nil, true
	case PayExpenseClaimInput:
		return &parsed.AmountMinor, true
	case PayBillInput:
		return &parsed.AmountMinor, true
	case ReverseVendorPaymentInput, PosReturnSaleInput:
		return nil, true
	case PosCompleteSaleInput:
		totals, err := posComputeSaleTotals(parsed.Lines)
		if err != nil {
			return nil, false
		}
		return &totals.totalMinor, true
	case HRExecutePayrollRunInput:
		return &parsed.ExpectedTotalNetMinor, true
	default:
		return nil, false
	}
}

func matchesCapability(pattern, capabilityID string) bool {
	if pattern == "*" || pattern == "*.*" {
		return true
	}
	if strings.HasSuffix(pattern, ".*") {
		return strings.HasPrefix(capabilityID, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == capabilityID
}

func riskRank(risk string) int {
	switch risk {
	case "read":
		return 0
	case "write":
		return 1
	case "money":
		return 2
	case "identity":
		return 3
	case "destructive":
		return 4
	case "secret":
		return 5
	default:
		return 0
	}
}

func (e *Executor) requestApproval(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, capabilityID, risk string, input any, rationale string, now time.Time) (string, error) {
	payload, err := marshalJS(input)
	if err != nil {
		return "", err
	}
	var agentSessionID *string
	if claims.AgentSessionID != "" {
		agentSessionID = &claims.AgentSessionID
	}
	var requestedByUserID any
	if claims.ActorType != "system" {
		requestedByUserID = claims.Subject
	}
	var approvalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO approvals (org_id, session_id, requested_by_user_id, capability_id, risk_class, payload, rationale, status, expires_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, 'pending', $8)
		RETURNING id::text`, claims.OrganizationID, agentSessionID, requestedByUserID, capabilityID, risk, payload, rationale, now.Add(approvalTTL)).Scan(&approvalID); err != nil {
		return "", err
	}
	request := struct {
		CapabilityID string `json:"capabilityId"`
		RiskClass    string `json:"riskClass"`
		Payload      any    `json:"payload"`
		Rationale    string `json:"rationale"`
	}{CapabilityID: capabilityID, RiskClass: risk, Payload: input, Rationale: rationale}
	requestJSON, err := marshalJS(request)
	if err != nil {
		return "", err
	}
	actorID := claims.ActorID
	capID := capabilityID
	if err := e.enqueueApprovalNotifications(ctx, tx, claims.OrganizationID, request); err != nil {
		return "", err
	}
	if err := bestEffortApprovalFeed(ctx, tx, claims.OrganizationID, capabilityID, rationale); err != nil {
		return "", err
	}
	if _, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
		OrgID:        claims.OrganizationID,
		ActorType:    claims.ActorType,
		ActorID:      actorID,
		Kind:         "approval.requested",
		CapabilityID: &capID,
		SessionID:    agentSessionID,
		Payload:      requestJSON,
		OccurredAt:   now,
	}); err != nil {
		return "", err
	}
	return approvalID, nil
}

func (e *Executor) enqueueApprovalNotifications(ctx context.Context, tx pgx.Tx, orgID string, request any) error {
	if e.webhookURL != "" {
		var body struct {
			Event        string `json:"event"`
			CapabilityID string `json:"capabilityId"`
			Risk         string `json:"risk"`
			Rationale    string `json:"rationale"`
		}
		encoded, err := json.Marshal(request)
		if err != nil {
			return err
		}
		var requestMap map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &requestMap); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["capabilityId"], &body.CapabilityID); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["riskClass"], &body.Risk); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["rationale"], &body.Rationale); err != nil {
			return err
		}
		body.Event = "approval.requested"
		if err := e.insertOutbox(ctx, tx, orgID, "webhook", "approval.webhook", map[string]any{"req": request, "orgId": orgID}, map[string]any{"url": e.webhookURL, "body": body}); err != nil {
			return err
		}
	}
	if e.smtpHost != "" && e.smtpTo != "" {
		var requestMap map[string]json.RawMessage
		encoded, err := json.Marshal(request)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(encoded, &requestMap); err != nil {
			return err
		}
		var capabilityID, risk, rationale string
		if err := json.Unmarshal(requestMap["capabilityId"], &capabilityID); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["riskClass"], &risk); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["rationale"], &rationale); err != nil {
			return err
		}
		text := "An action is waiting for human approval.\n\nCapability: " + capabilityID + "\nRisk class: " + risk + "\nRationale: " + rationale + "\n\nOpen the Approvals inbox to decide."
		payload := map[string]any{"to": e.smtpTo, "subject": "[Chaste] Approval needed: " + capabilityID, "text": text}
		if err := e.insertOutbox(ctx, tx, orgID, "email", "approval.email", map[string]any{"req": request, "orgId": orgID}, payload); err != nil {
			return err
		}
	}
	return nil
}

func (e *Executor) insertOutbox(ctx context.Context, tx pgx.Tx, orgID, kind, keyKind string, keyValue, payload any) error {
	keyRaw, err := marshalJS(keyValue)
	if err != nil {
		return err
	}
	keyObject, err := decodeJSON(keyRaw)
	if err != nil {
		return err
	}
	keyBytes, err := marshalJS(keyObject)
	if err != nil {
		return err
	}
	keyHash := sha256.Sum256(keyBytes)
	dedupeKey := "notification:" + keyKind + ":" + hex.EncodeToString(keyHash[:])
	payloadJSON, err := marshalJS(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_messages (org_id, kind, dedupe_key, provider_operation_id, payload)
		VALUES ($1::uuid, $2, $3, gen_random_uuid(), $4::jsonb)
		ON CONFLICT (org_id, dedupe_key) DO NOTHING`, orgID, kind, dedupeKey, payloadJSON)
	return err
}

func bestEffortApprovalFeed(ctx context.Context, tx pgx.Tx, orgID, capabilityID, rationale string) error {
	if _, err := tx.Exec(ctx, `SAVEPOINT approval_feed`); err != nil {
		return err
	}
	title := (capabilityID + " needs approval - " + rationale)
	if len(title) > 200 {
		title = title[:200]
	}
	_, insertErr := tx.Exec(ctx, `
		INSERT INTO notifications (org_id, user_id, kind, title, href)
		VALUES ($1::uuid, NULL, 'approval.requested', $2, '/approvals')`, orgID, title)
	if insertErr != nil {
		if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT approval_feed`); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `RELEASE SAVEPOINT approval_feed`)
	return err
}

type actionReceipt struct {
	CapabilityID string
	InputHash    string
	OK           bool
	Data         json.RawMessage
	Error        string
	Outcome      string
	Replayed     bool
}

func loadReceipt(ctx context.Context, tx pgx.Tx, orgID, intentKey string) (actionReceipt, bool, error) {
	var receipt actionReceipt
	var data []byte
	err := tx.QueryRow(ctx, `
		SELECT capability_id, input_hash, ok, data, COALESCE(error, ''), outcome
		FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, orgID, intentKey).
		Scan(&receipt.CapabilityID, &receipt.InputHash, &receipt.OK, &data, &receipt.Error, &receipt.Outcome)
	if errors.Is(err, pgx.ErrNoRows) {
		return actionReceipt{}, false, nil
	}
	if err != nil {
		return actionReceipt{}, false, err
	}
	receipt.Data = append(json.RawMessage(nil), data...)
	return receipt, true, nil
}

func insertReceipt(ctx context.Context, tx pgx.Tx, orgID, intentKey, capabilityID, inputHash string, result Result) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO action_receipts (org_id, intent_key, capability_id, input_hash, ok, outcome, data, error)
		VALUES ($1::uuid, $2, $3, $4, $5, 'known', $6::jsonb, NULL)`, orgID, intentKey, capabilityID, inputHash, result.OK, result.Data)
	return err
}

func createCustomer(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateCustomerInput) (CreateCustomerOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT name, email, phone FROM customers
		WHERE org_id = $1::uuid AND merged_into_customer_id IS NULL
		LIMIT 500`, claims.OrganizationID)
	if err != nil {
		return CreateCustomerOutput{}, err
	}
	existing := make([]crm.CustomerFingerprint, 0, 500)
	for rows.Next() {
		var fingerprint crm.CustomerFingerprint
		if err := rows.Scan(&fingerprint.Name, &fingerprint.Email, &fingerprint.Phone); err != nil {
			rows.Close()
			return CreateCustomerOutput{}, err
		}
		existing = append(existing, fingerprint)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return CreateCustomerOutput{}, err
	}
	rows.Close()
	verdict := crm.FindDuplicate(existing, crm.CustomerFingerprint{Name: input.Name, Email: input.Email, Phone: input.Phone})
	var updatedByUserID *string
	if claims.ActorType == "human" {
		updatedByUserID = claims.ActorID
	}
	var customerID string
	err = tx.QueryRow(ctx, `
		INSERT INTO customers (org_id, name, email, phone, preferred_contact_method, do_not_contact, updated_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Name, input.Email, input.Phone, input.PreferredContactMethod, input.DoNotContact, updatedByUserID).Scan(&customerID)
	if err != nil {
		return CreateCustomerOutput{}, err
	}
	var warning *string
	if verdict.Duplicate && verdict.ExistingName != nil && verdict.Reason != nil {
		value := `Looks like existing customer "` + *verdict.ExistingName + `" (matched by ` + string(*verdict.Reason) + `). Merge or deactivate one of them.`
		warning = &value
	}
	return CreateCustomerOutput{CustomerID: customerID, DuplicateWarning: warning}, nil
}

func deactivateCustomer(ctx context.Context, tx pgx.Tx, orgID string, input DeactivateCustomerInput, now time.Time) (DeactivateCustomerOutput, error) {
	_, err := tx.Exec(ctx, `
		UPDATE customers SET deactivated_at = $1
		WHERE org_id = $2::uuid AND id = $3::uuid`, now, orgID, input.CustomerID)
	if err != nil {
		return DeactivateCustomerOutput{}, err
	}
	return DeactivateCustomerOutput{Deactivated: true}, nil
}
