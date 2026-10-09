package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/jackc/pgx/v5"
)

const approvalVerificationError = "approval verification failed for the supplied approval id"

type ApprovalCapabilityExecutor interface {
	Execute(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (Result, error)
}

// ApprovalFinalizingExecutor commits successful approval execution and gate finalization together.
type ApprovalFinalizingExecutor interface {
	ExecuteWithApprovalFinalizer(context.Context, authbridge.CapabilityClaims, string, json.RawMessage, func(context.Context, pgx.Tx) error) (Result, error)
}

type ApprovalDecisionInput struct {
	ApprovalID string
	Decision   string
	Comment    *string
}

// ApprovalDecisionResult mirrors the legacy decision body. HTTPStatus is
// transport metadata and is not included in the JSON response.
type ApprovalDecisionResult struct {
	OK         bool    `json:"ok"`
	Status     string  `json:"status,omitempty"`
	Result     *Result `json:"result,omitempty"`
	Error      string  `json:"error,omitempty"`
	HTTPStatus int     `json:"-"`
}

type ApprovalDecider struct {
	pool     dbx.Beginner
	executor ApprovalCapabilityExecutor
}

func NewApprovalDecider(pool dbx.Beginner, executor ApprovalCapabilityExecutor) *ApprovalDecider {
	return &ApprovalDecider{pool: pool, executor: executor}
}

type approvalRecord struct {
	ID           string
	OrgID        string
	CapabilityID string
	Payload      json.RawMessage
	Status       string
	IntentID     string
	InputHash    string
	Rationale    string
	ExpiresAt    *time.Time
}

type approvalTransition struct {
	result  ApprovalDecisionResult
	row     approvalRecord
	claimed bool
}

// Decide rechecks the signed human session and organization membership, then
// conditionally claims a pending approval before any execution can occur.
// Approvals remain driven by the existing legacy-owned route until a caller
// explicitly opts into this service.
func (d *ApprovalDecider) Decide(ctx context.Context, claims authbridge.CapabilityClaims, input ApprovalDecisionInput) (ApprovalDecisionResult, error) {
	if d == nil || d.pool == nil || d.executor == nil {
		return ApprovalDecisionResult{}, errors.New("approval decision service is unavailable")
	}
	if !isUUID(claims.OrganizationID) {
		return decisionFailure(428, "onboarding required"), nil
	}
	if input.Decision != "approve" && input.Decision != "reject" || input.Comment != nil && len(utf16.Encode([]rune(*input.Comment))) > 2000 {
		return decisionFailure(400, "invalid request"), nil
	}
	if !isUUID(input.ApprovalID) {
		return decisionFailure(404, "not found"), nil
	}
	if claims.ActorType != "human" || claims.ActorID == nil || *claims.ActorID != claims.Subject || !isUUID(claims.Subject) {
		return decisionFailure(401, ErrSessionInvalid.Error()), nil
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	transition, err := dbx.WithOrgTx(ctx, d.pool, claims.OrganizationID, func(tx pgx.Tx) (approvalTransition, error) {
		if err := verifyIdentity(ctx, tx, claims, now); err != nil {
			return approvalTransition{}, err
		}
		var row approvalRecord
		var expiresAt *time.Time
		err := tx.QueryRow(ctx, `
			SELECT id::text, org_id::text, capability_id, payload, status, expires_at,
			       COALESCE(intent_id, ''), COALESCE(input_hash, ''), COALESCE(rationale, '')
			FROM approvals WHERE id = $1::uuid AND org_id = $2::uuid`, input.ApprovalID, claims.OrganizationID).
			Scan(&row.ID, &row.OrgID, &row.CapabilityID, &row.Payload, &row.Status, &expiresAt, &row.IntentID, &row.InputHash, &row.Rationale)
		if errors.Is(err, pgx.ErrNoRows) {
			return approvalTransition{result: decisionFailure(404, "not found")}, nil
		}
		if err != nil {
			return approvalTransition{}, err
		}
		row.ExpiresAt = expiresAt

		if row.Status == "pending" && row.ExpiresAt != nil && !row.ExpiresAt.After(now) {
			var expiredID string
			err := tx.QueryRow(ctx, `
				UPDATE approvals SET status = 'expired'
				WHERE id = $1::uuid AND status = 'pending'
				RETURNING id::text`, row.ID).Scan(&expiredID)
			if err == nil {
				return approvalTransition{result: decisionFailure(410, "this approval has expired; request it again")}, nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return approvalTransition{}, err
			}
			return approvalTransition{result: approvalAlreadyDecided(row.Status)}, nil
		}
		if row.Status != "pending" {
			return approvalTransition{result: approvalAlreadyDecided(row.Status)}, nil
		}

		if input.Decision == "reject" {
			var rejectedID string
			err := tx.QueryRow(ctx, `
			UPDATE approvals SET status = 'rejected', decided_by_user_id = $2::uuid,
				decision_comment = $3::text, decided_at = $4
				WHERE id = $1::uuid AND status = 'pending'
				RETURNING id::text`, row.ID, claims.Subject, input.Comment, now).Scan(&rejectedID)
			if errors.Is(err, pgx.ErrNoRows) {
				return approvalTransition{result: approvalAlreadyDecided(row.Status)}, nil
			}
			if err != nil {
				return approvalTransition{}, err
			}
			if err := appendApprovalDecisionEventTx(ctx, tx, claims, row, "approval.rejected", rejectionPayload{ApprovalID: row.ID, Comment: input.Comment}, now); err != nil {
				return approvalTransition{}, err
			}
			return approvalTransition{
				row:    row,
				result: ApprovalDecisionResult{OK: true, Status: "rejected", HTTPStatus: 200},
			}, nil
		}

		permission, supported := permissionForCapability(row.CapabilityID)
		if !supported {
			return approvalTransition{result: decisionFailure(422, "unknown capability: "+row.CapabilityID)}, nil
		}
		permissions, err := effectivePermissions(ctx, tx, claims)
		if err != nil {
			return approvalTransition{}, err
		}
		if !permissions["*"] && !permissions[permission] {
			return approvalTransition{result: decisionFailure(403, "you lack authority over this action")}, nil
		}

		var claimedID string
		err = tx.QueryRow(ctx, `
			UPDATE approvals SET status = 'executing'
			WHERE id = $1::uuid AND status = 'pending'
			RETURNING id::text`, row.ID).Scan(&claimedID)
		if errors.Is(err, pgx.ErrNoRows) {
			return approvalTransition{result: approvalAlreadyDecided(row.Status)}, nil
		}
		if err != nil {
			return approvalTransition{}, err
		}
		row.Status = "executing"
		return approvalTransition{row: row, claimed: true}, nil
	})
	if err != nil {
		if errors.Is(err, ErrSessionInvalid) {
			return decisionFailure(401, ErrSessionInvalid.Error()), nil
		}
		if errors.Is(err, ErrNotMember) {
			return decisionFailure(403, ErrNotMember.Error()), nil
		}
		return ApprovalDecisionResult{}, err
	}
	if transition.result.Status == "rejected" {
		return transition.result, nil
	}
	if transition.result.HTTPStatus != 0 {
		return transition.result, nil
	}
	if !transition.claimed {
		return transition.result, nil
	}

	// The database row is the sole execution input. Verify its canonical digest
	// against the signed assertion after the claim, matching the legacy kernel's
	// claim-then-verify ordering and preventing caller payload substitution.
	digest, digestErr := InputHash(transition.row.Payload)
	verifiedPayload := digestErr == nil && claims.CapabilityID == transition.row.CapabilityID && claims.InputSHA256 == digest &&
		transition.row.OrgID == claims.OrganizationID && transition.row.Status == "executing" &&
		(transition.row.ExpiresAt == nil || transition.row.ExpiresAt.After(now))
	if verifiedPayload {
		switch transition.row.CapabilityID {
		case createCustomerCapabilityID:
			parsed, parseErr := ParseCreateCustomerInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := CanonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case deactivateCustomerCapabilityID:
			parsed, parseErr := ParseDeactivateCustomerInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := CanonicalDeactivateCustomerInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case mergeCustomersCapabilityID:
			parsed, parseErr := ParseCustomerMergeInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case restoreCustomerMergeCapabilityID:
			parsed, parseErr := ParseCustomerMergeSnapshotInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case importCustomersCapabilityID:
			parsed, parseErr := ParseCustomerImportInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case undoCustomerImportCapabilityID:
			parsed, parseErr := ParseCustomerUndoImportInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case restoreImportedCustomersCapabilityID:
			parsed, parseErr := ParseCustomerRestoreImportInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case updateCustomerProfilesCapabilityID:
			parsed, parseErr := ParseCustomerProfileUpdateInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID:
			parsed, parseErr := ParseCustomerProfileSnapshotsInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := parsed.CanonicalHash()
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createInvoiceCapabilityID:
			parsed, parseErr := ParseCreateInvoiceInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case recordFxRateCapabilityID:
			parsed, parseErr := ParseRecordFxRateInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case recordPaymentCapabilityID:
			parsed, parseErr := ParseRecordPaymentInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case reversePaymentCapabilityID:
			parsed, parseErr := ParseReversePaymentInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID:
			parsed, parseErr := parseCRMDealInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID:
			parsed, parseErr := parseCRMTaskInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createQuoteCapabilityID, acceptQuoteCapabilityID, declineQuoteCapabilityID, expireQuoteCapabilityID, listQuotesCapabilityID:
			parsed, parseErr := parseAccountingQuoteInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createRecurringTemplateCapabilityID, pauseRecurringTemplateCapabilityID, resumeRecurringTemplateCapabilityID, listRecurringTemplatesCapabilityID:
			parsed, parseErr := parseAccountingRecurringInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case hrHireEmployeeCapabilityID, hrDeactivateEmployeeCapabilityID, hrListEmployeesCapabilityID, hrUpdateEmployeeStructureCapabilityID:
			parsed, parseErr := parseHREmployeeInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case salesCreateOrderCapabilityID, salesConfirmOrderCapabilityID, salesDeliverOrderCapabilityID, salesCancelOrderCapabilityID, salesListOrdersCapabilityID:
			parsed, parseErr := parseSalesInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case submitExpenseClaimCapabilityID, decideExpenseClaimCapabilityID, payExpenseClaimCapabilityID, listExpenseClaimsCapabilityID, setExpensePolicyCapabilityID:
			parsed, parseErr := parseAccountingExpenseInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createPurchaseOrderCapabilityID:
			parsed, parseErr := ParseCreatePurchaseOrderInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createVendorCapabilityID, createBillCapabilityID, payBillCapabilityID, reverseVendorPaymentCapabilityID:
			parsed, parseErr := parsePurchasingBillInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case receiveGoodsCapabilityID:
			parsed, parseErr := ParseReceiveGoodsInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case returnGoodsCapabilityID:
			parsed, parseErr := ParseReturnGoodsInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case inventoryAdjustStockCapabilityID, inventoryCreateTransferCapabilityID, inventoryConfirmTransferCapabilityID,
			inventoryCancelTransferCapabilityID, inventoryReverseTransferCapabilityID, inventoryListTransfersCapabilityID:
			parsed, parseErr := parseInventoryStockInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case inventoryCreateCycleCountCapabilityID, inventoryRecordCycleCountsCapabilityID,
			inventoryPostCycleCountCapabilityID, inventoryCancelCycleCountCapabilityID, inventoryListCycleCountsCapabilityID:
			parsed, parseErr := parseInventoryCycleCountInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case posOpenSessionCapabilityID, posCompleteSaleCapabilityID, posCloseSessionCapabilityID, posReturnSaleCapabilityID, posShiftSummaryCapabilityID:
			parsed, parseErr := parsePosSaleInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case creditNoteCapabilityID, shareInvoiceCapabilityID, generateDueInvoicesCapabilityID, reverseEntryCapabilityID:
			parsed, parseErr := parseAccountingInvoiceOpsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case addBankAccountCapabilityID, importBankFeedCapabilityID, deleteBankTransactionCapabilityID, matchBankTransactionCapabilityID,
			unmatchBankTransactionCapabilityID, bankReconciliationCapabilityID, excludeBankTransactionCapabilityID,
			unexcludeBankTransactionCapabilityID, bankSummaryCapabilityID:
			parsed, parseErr := parseBankingInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createPurchaseRequestCapabilityID, decidePurchaseRequestCapabilityID, createRfqCapabilityID, recordQuoteCapabilityID,
			selectWinningQuoteCapabilityID, listPurchaseWorkflowCapabilityID:
			parsed, parseErr := parsePurchasingRequestInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case inventoryCreateItemCapabilityID, inventoryUpdateItemCapabilityID, inventoryRestoreItemCapabilityID,
			inventoryArchiveItemCapabilityID, inventoryCreateLocationCapabilityID, inventoryListLocationsCapabilityID,
			inventoryListLocationRecordsCapabilityID, inventoryListItemMetadataCapabilityID,
			inventoryLookupByBarcodeCapabilityID:
			parsed, parseErr := parseInventoryItemInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case inventoryImportItemsCapabilityID, inventoryUndoItemImportCapabilityID, inventoryRestoreItemImportCapabilityID,
			inventoryReserveStockCapabilityID, inventoryReleaseReservationCapabilityID, inventoryListReservationsCapabilityID:
			parsed, parseErr := parseInventoryImportInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createPaymentRunCapabilityID, cancelPaymentRunDraftCapabilityID, restorePaymentRunDraftCapabilityID,
			instructPaymentRunCapabilityID, reversePaymentRunCapabilityID, listPaymentRunsCapabilityID:
			parsed, parseErr := parsePurchasingPaymentRunInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case periodCloseWorkbenchCapabilityID, updatePeriodCloseCheckCapabilityID, restorePeriodCloseCheckCapabilityID,
			closePeriodCapabilityID, reopenPeriodCapabilityID, closeYearCapabilityID:
			parsed, parseErr := parseAccountingPeriodCloseInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case saveBudgetScenarioCapabilityID, undoBudgetScenarioVersionCapabilityID, restoreBudgetScenarioVersionCapabilityID,
			listBudgetScenariosCapabilityID, budgetActualVsPlanCapabilityID:
			parsed, parseErr := parseAccountingBudgetInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createTaxProfileCapabilityID, removeTaxProfileCapabilityID, createTaxCodeCapabilityID,
			archiveTaxCodeCapabilityID, activateTaxCodeCapabilityID:
			parsed, parseErr := parseAccountingTaxMasterInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case createTaxReturnCapabilityID, cancelTaxReturnDraftCapabilityID, restoreTaxReturnDraftCapabilityID,
			recordTaxReturnSubmissionCapabilityID, createTaxReturnAmendmentCapabilityID,
			recordTaxReturnAcknowledgmentCapabilityID, fileSalesTaxReturnCapabilityID:
			parsed, parseErr := parseAccountingTaxReturnInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case hrRequestLeaveCapabilityID, hrCancelLeaveCapabilityID, hrDecideLeaveCapabilityID,
			hrLogTimeCapabilityID, hrDecideTimeEntryCapabilityID, hrClockInCapabilityID, hrClockOutCapabilityID,
			hrLeaveBalanceCapabilityID, hrLeaveCalendarCapabilityID, hrTimeReportCapabilityID:
			parsed, parseErr := parseHRLeaveTimeInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case hrCreatePayrollRunCapabilityID, hrExecutePayrollRunCapabilityID, hrVoidPayrollRunCapabilityID,
			hrReversePayrollPostingCapabilityID, hrAddApplicantCapabilityID, hrMoveApplicantCapabilityID,
			hrHireApplicantCapabilityID, hrListApplicantsCapabilityID:
			parsed, parseErr := parseHRPayrollApplicantInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case billCreditNoteCapabilityID, closePurchaseOrderCapabilityID, listReceiptsCapabilityID:
			parsed, parseErr := parsePurchasingLifecycleInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case inventoryPostValuationSummaryCapabilityID, inventoryReverseValuationSummaryCapabilityID,
			inventoryStockReportCapabilityID, inventoryItemHistoryCapabilityID, inventoryListLotsCapabilityID,
			inventoryRebuildStockProjectionsCapabilityID:
			parsed, parseErr := parseInventoryValuationInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case incomeStatementCapabilityID, balanceSheetCapabilityID, listInvoicesCapabilityID, arAgingCapabilityID,
			cashBasisReportCapabilityID, customerStatementCapabilityID, salesTaxReportCapabilityID,
			cashFlowCapabilityID, cashForecastCapabilityID:
			parsed, parseErr := parseAccountingReportInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case unrealizedFxExposureCapabilityID, revalueForeignReceivablesCapabilityID, reversePeriodFxRevaluationCapabilityID:
			parsed, parseErr := parseAccountingFxInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case apAgingCapabilityID:
			parsed, parseErr := parsePurchasingAPAgingInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case buildRemindersCapabilityID:
			parsed, parseErr := parseAccountingPolicyInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case manufacturingCreateWorkOrderCapabilityID, manufacturingReleaseWorkOrderCapabilityID,
			manufacturingCompleteWorkOrderCapabilityID, manufacturingCancelWorkOrderCapabilityID,
			manufacturingReverseProductionRunCapabilityID, manufacturingCheckProductionFeasibilityCapabilityID,
			manufacturingWorkOrdersListCapabilityID, manufacturingProduceFromBomCapabilityID:
			parsed, parseErr := parseManufacturingWorkOrderInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case manufacturingDefineBomCapabilityID, manufacturingDeleteBomCapabilityID, manufacturingBomTreeCapabilityID,
			manufacturingBomReportCapabilityID, manufacturingCostPreviewCapabilityID, manufacturingLotTraceCapabilityID,
			manufacturingProductionRunsCapabilityID:
			parsed, parseErr := parseManufacturingBomInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case marketingCreateSegmentCapabilityID, marketingCreateCampaignCapabilityID, marketingSendCampaignCapabilityID,
			marketingCampaignAnalyticsCapabilityID:
			parsed, parseErr := parseMarketingCampaignInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case supportStartConversationCapabilityID, supportPostMessageCapabilityID,
			supportListConversationsCapabilityID, supportListLibraryCapabilityID, supportReadConversationCapabilityID,
			supportLookupOrderStatusCapabilityID, supportSearchKnowledgeCapabilityID,
			supportEscalateConversationCapabilityID, supportResolveConversationCapabilityID,
			supportReopenConversationCapabilityID, supportCreateTicketCapabilityID,
			supportUpdateTicketCapabilityID, supportSuggestCategoryCapabilityID,
			supportCreateCannedResponseCapabilityID, supportCreateKbArticleCapabilityID:
			parsed, parseErr := parseSupportInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case hrCreateOpeningCapabilityID, hrCloseOpeningCapabilityID:
			parsed, parseErr := parseHROpeningInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case documentsListDocVersionsCapabilityID:
			parsed, parseErr := ParseListDocumentVersionsInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case documentsGetDocVersionCapabilityID:
			parsed, parseErr := ParseDocumentVersionIDInput(transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case iamSetModulesCapabilityID, iamRestoreModulesCapabilityID, iamSetModuleConfigCapabilityID,
			iamSetOrgPolicyCapabilityID, iamSetOrgBrandingCapabilityID:
			parsed, parseErr := parseIAMOrgSettingsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case purchasingSupplierPerformanceCapabilityID, purchasingPriceHistoryCapabilityID,
			purchasingSupplierStatementCapabilityID:
			parsed, parseErr := parsePurchasingReadsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case signalsListCapabilityID:
			parsed, parseErr := parseSignalsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case skillsFindCapabilityID, skillsLoadCapabilityID:
			parsed, parseErr := parseSkillsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case creatorSubmitProposalCapabilityID, creatorListProposalsCapabilityID, creatorScaffoldCapabilityID,
			creatorVerifyPluginCapabilityID, creatorPublishListingCapabilityID, creatorRetractListingCapabilityID,
			creatorInstallListingCapabilityID, creatorUninstallListingCapabilityID, creatorListMarketplaceCapabilityID,
			creatorStageCandidateCapabilityID, creatorPromoteCandidateCapabilityID, creatorRollbackCandidateCapabilityID,
			creatorRecordCanaryOutcomeCapabilityID:
			parsed, parseErr := parseCreatorInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case routinesCreateCapabilityID, routinesListCapabilityID, routinesUpdateCapabilityID,
			routinesDeleteCapabilityID, routinesRunNowCapabilityID:
			parsed, parseErr := parseRoutinesInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case analyticsRenderReportCapabilityID, analyticsPipelineByStageCapabilityID,
			analyticsRevenueByMonthCapabilityID, analyticsInvoiceAgingCapabilityID,
			analyticsSalesByCustomerCapabilityID, analyticsStockLevelsCapabilityID,
			analyticsExplainChangeCapabilityID, analyticsAskYourBusinessCapabilityID:
			parsed, parseErr := parseAnalyticsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case iamListMembersCapabilityID, iamCreateRoleCapabilityID, iamUpdateRolePermissionsCapabilityID,
			iamAssignRoleCapabilityID, iamInviteMemberCapabilityID:
			parsed, parseErr := parseIAMInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case settingsConfigureAiProviderCapabilityID, settingsRestoreAiProviderCapabilityID:
			parsed, parseErr := parseSettingsInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		case harnessApproveCompositionCapabilityID:
			parsed, parseErr := parseHarnessInput(transition.row.CapabilityID, transition.row.Payload)
			if parseErr == nil {
				parsedDigest, err := canonicalInputHash(parsed)
				verifiedPayload = err == nil && parsedDigest == digest
			}
		default:
			verifiedPayload = false
		}
	}
	if !verifiedPayload {
		result := Result{OK: false, Error: approvalVerificationError}
		if err := d.finish(ctx, claims, transition.row.ID, "failed", input.Comment, now); err != nil {
			return ApprovalDecisionResult{}, err
		}
		return ApprovalDecisionResult{OK: false, Error: result.Error, HTTPStatus: 422}, nil
	}

	// Go-owned writes execute directly under the approver's human authority,
	// so the executor records capability.executed without a second approval request.
	executionClaims := claims
	executionClaims.IntentID = transition.row.IntentID
	var result Result
	finalizedInExecution := false
	if finalizingExecutor, ok := d.executor.(ApprovalFinalizingExecutor); ok {
		result, err = finalizingExecutor.ExecuteWithApprovalFinalizer(ctx, executionClaims, transition.row.CapabilityID, transition.row.Payload, func(txCtx context.Context, tx pgx.Tx) error {
			return d.finishTx(txCtx, tx, claims, transition.row.ID, "executed", input.Comment, now)
		})
		if err != nil {
			if recoveryErr := d.restorePending(ctx, claims, transition.row.ID); recoveryErr != nil {
				return ApprovalDecisionResult{}, errors.Join(err, fmt.Errorf("restore approval to pending after execution rollback: %w", recoveryErr))
			}
			return ApprovalDecisionResult{}, err
		}
		finalizedInExecution = result.OK
	} else {
		result, err = d.executor.Execute(ctx, executionClaims, transition.row.CapabilityID, transition.row.Payload)
	}
	if err != nil {
		return ApprovalDecisionResult{}, err
	}
	finalStatus := "failed"
	if result.OK {
		finalStatus = "executed"
	} else if result.PendingApproval {
		finalStatus = "approved"
	}
	if !finalizedInExecution {
		if err := d.finish(ctx, claims, transition.row.ID, finalStatus, input.Comment, now); err != nil {
			return ApprovalDecisionResult{}, err
		}
	}
	if !result.OK && !result.PendingApproval {
		message := result.Error
		if message == "" {
			message = "execution failed"
		}
		return decisionFailure(422, message), nil
	}
	return ApprovalDecisionResult{OK: true, Status: finalStatus, Result: &result, HTTPStatus: 200}, nil
}

func (d *ApprovalDecider) finish(ctx context.Context, claims authbridge.CapabilityClaims, approvalID, status string, comment *string, decidedAt time.Time) error {
	_, err := dbx.WithOrgTx(ctx, d.pool, claims.OrganizationID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, d.finishTx(ctx, tx, claims, approvalID, status, comment, decidedAt)
	})
	return err
}

func (d *ApprovalDecider) finishTx(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, approvalID, status string, comment *string, decidedAt time.Time) error {
	tag, err := tx.Exec(ctx, `
			UPDATE approvals SET status = $2, decided_by_user_id = $3::uuid,
				decision_comment = $4::text, decided_at = $5
			WHERE id = $1::uuid AND org_id = $6::uuid AND status = 'executing'`, approvalID, status, claims.Subject, comment, decidedAt, claims.OrganizationID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("approval execution claim was lost before finalization")
	}
	return nil
}

func (d *ApprovalDecider) restorePending(ctx context.Context, claims authbridge.CapabilityClaims, approvalID string) error {
	_, err := dbx.WithOrgTx(ctx, d.pool, claims.OrganizationID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			UPDATE approvals SET status = 'pending', decided_by_user_id = NULL,
				decision_comment = NULL, decided_at = NULL
			WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'executing'`, approvalID, claims.OrganizationID)
		return struct{}{}, err
	})
	return err
}

func appendApprovalDecisionEventTx(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, row approvalRecord, kind string, payload any, now time.Time) error {
	encoded, err := marshalJS(payload)
	if err != nil {
		return err
	}
	capabilityID := row.CapabilityID
	actorID := claims.Subject
	_, _, err = ledger.AppendTx(ctx, tx, ledger.AppendEvent{
		OrgID:        claims.OrganizationID,
		ActorType:    "human",
		ActorID:      &actorID,
		Kind:         kind,
		CapabilityID: &capabilityID,
		Payload:      encoded,
		OccurredAt:   now,
	})
	return err
}

type rejectionPayload struct {
	ApprovalID string  `json:"approvalId"`
	Comment    *string `json:"comment"`
}

func permissionForCapability(capabilityID string) (string, bool) {
	if spec, ok := capabilitySpecs[capabilityID]; ok && spec.permission != "" {
		return spec.permission, true
	}
	switch capabilityID {
	case createCustomerCapabilityID, saveCustomerViewCapabilityID, restoreCustomerViewCapabilityID, deactivateCustomerCapabilityID,
		mergeCustomersCapabilityID, restoreCustomerMergeCapabilityID, importCustomersCapabilityID,
		undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID,
		updateCustomerProfilesCapabilityID, restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID,
		createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID,
		createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID:
		return "crm.write", true
	case createInvoiceCapabilityID, createQuoteCapabilityID, acceptQuoteCapabilityID, declineQuoteCapabilityID,
		expireQuoteCapabilityID, createRecurringTemplateCapabilityID, pauseRecurringTemplateCapabilityID, resumeRecurringTemplateCapabilityID:
		return "accounting.write", true
	case listQuotesCapabilityID, listRecurringTemplatesCapabilityID:
		return "accounting.read", true
	case hrHireEmployeeCapabilityID, hrDeactivateEmployeeCapabilityID, hrUpdateEmployeeStructureCapabilityID:
		return "hr.write", true
	case hrListEmployeesCapabilityID:
		return "hr.read", true
	case salesCreateOrderCapabilityID, salesConfirmOrderCapabilityID, salesDeliverOrderCapabilityID, salesCancelOrderCapabilityID:
		return "sales.write", true
	case salesListOrdersCapabilityID:
		return "sales.read", true
	case recordFxRateCapabilityID, recordPaymentCapabilityID, reversePaymentCapabilityID:
		return "accounting.post", true
	case trialBalanceCapabilityID:
		return "accounting.read", true
	case submitExpenseClaimCapabilityID:
		return "expenses.submit", true
	case decideExpenseClaimCapabilityID, listExpenseClaimsCapabilityID, listExpensePoliciesCapabilityID, setExpensePolicyCapabilityID:
		return "expenses.decide", true
	case payExpenseClaimCapabilityID:
		return "accounting.post", true
	case createVendorCapabilityID, createPurchaseOrderCapabilityID, receiveGoodsCapabilityID, returnGoodsCapabilityID, createBillCapabilityID:
		return "purchasing.write", true
	case payBillCapabilityID, reverseVendorPaymentCapabilityID:
		return "purchasing.post", true
	case inventoryAdjustStockCapabilityID, inventoryCreateTransferCapabilityID, inventoryConfirmTransferCapabilityID,
		inventoryCancelTransferCapabilityID, inventoryReverseTransferCapabilityID,
		inventoryCreateCycleCountCapabilityID, inventoryRecordCycleCountsCapabilityID,
		inventoryPostCycleCountCapabilityID, inventoryCancelCycleCountCapabilityID:
		return "inventory.write", true
	case inventoryListTransfersCapabilityID, inventoryListCycleCountsCapabilityID:
		return "inventory.read", true
	case posOpenSessionCapabilityID, posCloseSessionCapabilityID:
		return "pos.write", true
	case posCompleteSaleCapabilityID, posReturnSaleCapabilityID:
		return "pos.sell", true
	case posShiftSummaryCapabilityID:
		return "pos.read", true
	case creditNoteCapabilityID, reverseEntryCapabilityID:
		return "accounting.post", true
	case shareInvoiceCapabilityID, generateDueInvoicesCapabilityID:
		return "accounting.write", true
	case addBankAccountCapabilityID, importBankFeedCapabilityID, deleteBankTransactionCapabilityID, matchBankTransactionCapabilityID,
		unmatchBankTransactionCapabilityID, excludeBankTransactionCapabilityID, unexcludeBankTransactionCapabilityID:
		return "accounting.write", true
	case bankReconciliationCapabilityID, bankSummaryCapabilityID:
		return "accounting.read", true
	case createPurchaseRequestCapabilityID, decidePurchaseRequestCapabilityID, createRfqCapabilityID, recordQuoteCapabilityID,
		selectWinningQuoteCapabilityID:
		return "purchasing.write", true
	case listPurchaseWorkflowCapabilityID:
		return "purchasing.read", true
	case inventoryCreateItemCapabilityID, inventoryUpdateItemCapabilityID, inventoryRestoreItemCapabilityID,
		inventoryArchiveItemCapabilityID, inventoryCreateLocationCapabilityID:
		return "inventory.write", true
	case inventoryListLocationsCapabilityID, inventoryListLocationRecordsCapabilityID,
		inventoryListItemMetadataCapabilityID, inventoryLookupByBarcodeCapabilityID:
		return "inventory.read", true
	case inventoryImportItemsCapabilityID, inventoryUndoItemImportCapabilityID, inventoryRestoreItemImportCapabilityID,
		inventoryReserveStockCapabilityID, inventoryReleaseReservationCapabilityID:
		return "inventory.write", true
	case inventoryListReservationsCapabilityID:
		return "inventory.read", true
	case createPaymentRunCapabilityID, cancelPaymentRunDraftCapabilityID, restorePaymentRunDraftCapabilityID:
		return "purchasing.write", true
	case instructPaymentRunCapabilityID, reversePaymentRunCapabilityID:
		return "purchasing.post", true
	case listPaymentRunsCapabilityID:
		return "purchasing.read", true
	case periodCloseWorkbenchCapabilityID:
		return "accounting.read", true
	case updatePeriodCloseCheckCapabilityID, restorePeriodCloseCheckCapabilityID:
		return "accounting.write", true
	case closePeriodCapabilityID, reopenPeriodCapabilityID, closeYearCapabilityID:
		return "accounting.admin", true
	case saveBudgetScenarioCapabilityID, undoBudgetScenarioVersionCapabilityID, restoreBudgetScenarioVersionCapabilityID:
		return "accounting.write", true
	case listBudgetScenariosCapabilityID, budgetActualVsPlanCapabilityID:
		return "accounting.read", true
	case createTaxProfileCapabilityID, removeTaxProfileCapabilityID, createTaxCodeCapabilityID,
		archiveTaxCodeCapabilityID, activateTaxCodeCapabilityID:
		return "accounting.admin", true
	case createTaxReturnCapabilityID, cancelTaxReturnDraftCapabilityID, restoreTaxReturnDraftCapabilityID,
		createTaxReturnAmendmentCapabilityID:
		return "accounting.write", true
	case recordTaxReturnSubmissionCapabilityID, fileSalesTaxReturnCapabilityID:
		return "accounting.post", true
	case recordTaxReturnAcknowledgmentCapabilityID:
		return "accounting.admin", true
	case hrRequestLeaveCapabilityID, hrCancelLeaveCapabilityID, hrDecideLeaveCapabilityID,
		hrLogTimeCapabilityID, hrDecideTimeEntryCapabilityID, hrClockInCapabilityID, hrClockOutCapabilityID,
		hrCreatePayrollRunCapabilityID, hrExecutePayrollRunCapabilityID, hrVoidPayrollRunCapabilityID,
		hrReversePayrollPostingCapabilityID, hrAddApplicantCapabilityID, hrMoveApplicantCapabilityID,
		hrHireApplicantCapabilityID:
		return "hr.write", true
	case hrLeaveBalanceCapabilityID, hrLeaveCalendarCapabilityID, hrTimeReportCapabilityID, hrListApplicantsCapabilityID:
		return "hr.read", true
	case billCreditNoteCapabilityID, closePurchaseOrderCapabilityID:
		return "purchasing.write", true
	case listReceiptsCapabilityID:
		return "purchasing.read", true
	case apAgingCapabilityID:
		return "purchasing.read", true
	case buildRemindersCapabilityID:
		return "accounting.read", true
	case manufacturingCreateWorkOrderCapabilityID, manufacturingReleaseWorkOrderCapabilityID,
		manufacturingCompleteWorkOrderCapabilityID, manufacturingCancelWorkOrderCapabilityID,
		manufacturingProduceFromBomCapabilityID, manufacturingDefineBomCapabilityID,
		manufacturingReverseProductionRunCapabilityID, manufacturingDeleteBomCapabilityID:
		return "manufacturing.write", true
	case manufacturingCheckProductionFeasibilityCapabilityID, manufacturingWorkOrdersListCapabilityID,
		manufacturingBomTreeCapabilityID, manufacturingBomReportCapabilityID, manufacturingCostPreviewCapabilityID,
		manufacturingLotTraceCapabilityID, manufacturingProductionRunsCapabilityID:
		return "manufacturing.read", true
	case marketingCreateSegmentCapabilityID, marketingCreateCampaignCapabilityID, marketingSendCampaignCapabilityID:
		return "marketing.write", true
	case marketingCampaignAnalyticsCapabilityID:
		return "marketing.read", true
	case hrCreateOpeningCapabilityID, hrCloseOpeningCapabilityID:
		return "hr.write", true
	case iamSetModulesCapabilityID, iamRestoreModulesCapabilityID, iamSetOrgPolicyCapabilityID,
		iamSetModuleConfigCapabilityID, iamSetOrgBrandingCapabilityID:
		return "iam.admin", true
	case purchasingSupplierPerformanceCapabilityID, purchasingPriceHistoryCapabilityID, purchasingSupplierStatementCapabilityID:
		return "purchasing.read", true
	case signalsListCapabilityID:
		return "signals.read", true
	case skillsFindCapabilityID, skillsLoadCapabilityID:
		return "documents.read", true
	case creatorSubmitProposalCapabilityID, creatorListProposalsCapabilityID, creatorScaffoldCapabilityID,
		creatorVerifyPluginCapabilityID, creatorPublishListingCapabilityID, creatorRetractListingCapabilityID,
		creatorInstallListingCapabilityID, creatorUninstallListingCapabilityID,
		creatorStageCandidateCapabilityID, creatorPromoteCandidateCapabilityID, creatorRollbackCandidateCapabilityID:
		return "platform.creator", true
	case creatorListMarketplaceCapabilityID:
		return "platform.browse", true
	case creatorRecordCanaryOutcomeCapabilityID:
		return "platform.creator.release", true
	case routinesCreateCapabilityID, routinesUpdateCapabilityID, routinesDeleteCapabilityID, routinesRunNowCapabilityID:
		return "routines.write", true
	case routinesListCapabilityID:
		return "routines.read", true
	case analyticsRenderReportCapabilityID, analyticsExplainChangeCapabilityID, analyticsAskYourBusinessCapabilityID:
		return "analytics.report", true
	case analyticsPipelineByStageCapabilityID:
		return "crm.read", true
	case analyticsRevenueByMonthCapabilityID, analyticsInvoiceAgingCapabilityID, analyticsSalesByCustomerCapabilityID:
		return "accounting.read", true
	case analyticsStockLevelsCapabilityID:
		return "inventory.read", true
	case supportStartConversationCapabilityID, supportPostMessageCapabilityID,
		supportEscalateConversationCapabilityID, supportResolveConversationCapabilityID,
		supportReopenConversationCapabilityID, supportCreateTicketCapabilityID,
		supportUpdateTicketCapabilityID, supportCreateCannedResponseCapabilityID,
		supportCreateKbArticleCapabilityID:
		return "support.write", true
	case supportListConversationsCapabilityID, supportListLibraryCapabilityID, supportReadConversationCapabilityID,
		supportLookupOrderStatusCapabilityID, supportSearchKnowledgeCapabilityID,
		supportSuggestCategoryCapabilityID:
		return "support.read", true
	case inventoryPostValuationSummaryCapabilityID, inventoryReverseValuationSummaryCapabilityID:
		return "inventory.write", true
	case inventoryRebuildStockProjectionsCapabilityID:
		return "inventory.admin", true
	case inventoryStockReportCapabilityID, inventoryItemHistoryCapabilityID, inventoryListLotsCapabilityID:
		return "inventory.read", true
	case incomeStatementCapabilityID, balanceSheetCapabilityID, listInvoicesCapabilityID, arAgingCapabilityID,
		cashBasisReportCapabilityID, customerStatementCapabilityID, salesTaxReportCapabilityID,
		cashFlowCapabilityID, cashForecastCapabilityID:
		return "accounting.read", true
	case unrealizedFxExposureCapabilityID:
		return "accounting.read", true
	case revalueForeignReceivablesCapabilityID, reversePeriodFxRevaluationCapabilityID:
		return "accounting.post", true
	case iamListMembersCapabilityID:
		return "iam.read", true
	case documentsListDocsCapabilityID, documentsListDocVersionsCapabilityID, documentsGetDocVersionCapabilityID:
		return "documents.read", true
	case iamCreateRoleCapabilityID, iamUpdateRolePermissionsCapabilityID, iamAssignRoleCapabilityID, iamInviteMemberCapabilityID,
		SCIMTokenCreateCapabilityID, SCIMTokenRevokeCapabilityID:
		return "iam.admin", true
	case settingsConfigureAiProviderCapabilityID, settingsRestoreAiProviderCapabilityID:
		return "iam.admin", true
	case harnessApproveCompositionCapabilityID:
		return "harness.approve", true
	default:
		if spec, ok := messagingCapabilitySpecs[capabilityID]; ok {
			return spec.Permission, true
		}
		return documentsPermissionFor(capabilityID)
	}
}

func decisionFailure(status int, message string) ApprovalDecisionResult {
	return ApprovalDecisionResult{OK: false, Error: message, HTTPStatus: status}
}

func approvalAlreadyDecided(status string) ApprovalDecisionResult {
	if status == "executing" {
		return decisionFailure(409, "this approval is being executed elsewhere; refresh to see the outcome")
	}
	return decisionFailure(409, "already "+status)
}
