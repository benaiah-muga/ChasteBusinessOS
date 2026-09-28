package capability

import (
	"context"
	"encoding/json"
	"errors"
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
			SELECT id::text, org_id::text, capability_id, payload, status, expires_at
			FROM approvals WHERE id = $1::uuid AND org_id = $2::uuid`, input.ApprovalID, claims.OrganizationID).
			Scan(&row.ID, &row.OrgID, &row.CapabilityID, &row.Payload, &row.Status, &expiresAt)
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
		if err := appendApprovalDecisionEvent(ctx, d.pool, claims, transition.row, "approval.rejected", rejectionPayload{ApprovalID: transition.row.ID, Comment: input.Comment}, now); err != nil {
			return ApprovalDecisionResult{}, err
		}
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
		case undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID:
			parsed, parseErr := ParseCustomerIDsInput(transition.row.Payload)
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
	executionClaims.IntentID = ""
	result, err := d.executor.Execute(ctx, executionClaims, transition.row.CapabilityID, transition.row.Payload)
	if err != nil {
		return ApprovalDecisionResult{}, err
	}
	finalStatus := "failed"
	if result.OK {
		finalStatus = "executed"
	} else if result.PendingApproval {
		finalStatus = "approved"
	}
	if err := d.finish(ctx, claims, transition.row.ID, finalStatus, input.Comment, now); err != nil {
		return ApprovalDecisionResult{}, err
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
		_, err := tx.Exec(ctx, `
			UPDATE approvals SET status = $2, decided_by_user_id = $3::uuid,
				decision_comment = $4::text, decided_at = $5
			WHERE id = $1::uuid`, approvalID, status, claims.Subject, comment, decidedAt)
		return struct{}{}, err
	})
	return err
}

func appendApprovalDecisionEvent(ctx context.Context, pool dbx.Beginner, claims authbridge.CapabilityClaims, row approvalRecord, kind string, payload any, now time.Time) error {
	encoded, err := marshalJS(payload)
	if err != nil {
		return err
	}
	capabilityID := row.CapabilityID
	actorID := claims.Subject
	_, err = dbx.WithOrgTx(ctx, pool, claims.OrganizationID, func(tx pgx.Tx) (struct{}, error) {
		_, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
			OrgID:        claims.OrganizationID,
			ActorType:    "human",
			ActorID:      &actorID,
			Kind:         kind,
			CapabilityID: &capabilityID,
			Payload:      encoded,
			OccurredAt:   now,
		})
		return struct{}{}, err
	})
	return err
}

type rejectionPayload struct {
	ApprovalID string  `json:"approvalId"`
	Comment    *string `json:"comment"`
}

func permissionForCapability(capabilityID string) (string, bool) {
	switch capabilityID {
	case createCustomerCapabilityID, deactivateCustomerCapabilityID,
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
	default:
		return "", false
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
