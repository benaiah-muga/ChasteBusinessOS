package capability

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestExecuteSystemPreservesLegacyActorAndApproval(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Go system execution customer"}`)
	intentID := executorUUID(t)

	if _, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   createCustomerCapabilityID,
		Permission:     "accounting.write",
		IntentID:       executorUUID(t),
	}, input); !errors.Is(err, ErrSystemPermissionMismatch) {
		t.Fatalf("permission mismatch err=%v, want ErrSystemPermissionMismatch", err)
	}

	result, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   createCustomerCapabilityID,
		Permission:     "crm.write",
		IntentID:       intentID,
	}, input)
	if err != nil || !result.OK {
		t.Fatalf("system execution result=%+v err=%v", result, err)
	}
	var eventCount int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*)::int FROM ledger_events
		WHERE org_id = $1::uuid AND kind = 'capability.executed'
		  AND capability_id = $2 AND actor_type = 'system'
		  AND actor_id IS NULL AND session_id IS NULL`, fx.orgID, createCustomerCapabilityID).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 {
		t.Fatalf("system capability ledger events=%d, want one null-ID, sessionless event", eventCount)
	}
	var receiptCount int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*)::int FROM action_receipts
		WHERE org_id = $1::uuid AND intent_key = $2`, fx.orgID, fx.orgID+":"+intentID).Scan(&receiptCount); err != nil {
		t.Fatal(err)
	}
	if receiptCount != 1 {
		t.Fatalf("job action receipts=%d, want one", receiptCount)
	}
	replayed, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   createCustomerCapabilityID,
		Permission:     "crm.write",
		IntentID:       intentID,
	}, input)
	if err != nil || !replayed.OK || !replayed.Replayed {
		t.Fatalf("receipt replay result=%+v err=%v", replayed, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND name = $2`, fx.orgID, "Go system execution customer"); got != 1 {
		t.Fatalf("receipt replay created %d customer rows, want one", got)
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, requires_approval_for)
		VALUES ($1::uuid, $2, 'read', '[]'::jsonb)`, fx.orgID, createCustomerCapabilityID); err != nil {
		t.Fatal(err)
	}
	approvedInput := json.RawMessage(`{"name":"Go system approved customer"}`)
	approvedIntent := executorUUID(t)
	pending, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   createCustomerCapabilityID,
		Permission:     "crm.write",
		IntentID:       approvedIntent,
	}, approvedInput)
	if err != nil || pending.OK || !pending.PendingApproval || pending.ApprovalID == "" {
		t.Fatalf("system approval request result=%+v err=%v", pending, err)
	}
	var requestedByUserID, sessionID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT requested_by_user_id::text, session_id::text FROM approvals
		WHERE id = $1::uuid AND org_id = $2::uuid`, pending.ApprovalID, fx.orgID).
		Scan(&requestedByUserID, &sessionID); err != nil {
		t.Fatal(err)
	}
	if requestedByUserID != nil || sessionID != nil {
		t.Fatalf("system approval attribution requester=%v session=%v, want both NULL", requestedByUserID, sessionID)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET status = 'executing' WHERE id = $1::uuid AND org_id = $2::uuid`, pending.ApprovalID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	approved, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID:     fx.orgID,
		CapabilityID:       createCustomerCapabilityID,
		Permission:         "crm.write",
		IntentID:           approvedIntent,
		ApprovedApprovalID: pending.ApprovalID,
	}, approvedInput)
	if err != nil || !approved.OK {
		t.Fatalf("approved system execution result=%+v err=%v", approved, err)
	}
	var grantEvents int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*)::int FROM ledger_events
		WHERE org_id = $1::uuid AND kind = 'approval.granted'
		  AND capability_id = $2 AND actor_type = 'system'
		  AND actor_id IS NULL AND session_id IS NULL`, fx.orgID, createCustomerCapabilityID).Scan(&grantEvents); err != nil {
		t.Fatal(err)
	}
	if grantEvents != 1 {
		t.Fatalf("system approval grant events=%d, want one", grantEvents)
	}

	wrongInput := json.RawMessage(`{"name":"Go system payload substitution"}`)
	wrongIntent := executorUUID(t)
	wrongPending, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   createCustomerCapabilityID,
		Permission:     "crm.write",
		IntentID:       wrongIntent,
	}, json.RawMessage(`{"name":"Go system stored approval payload"}`))
	if err != nil || !wrongPending.PendingApproval {
		t.Fatalf("second system approval request result=%+v err=%v", wrongPending, err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET status = 'executing' WHERE id = $1::uuid AND org_id = $2::uuid`, wrongPending.ApprovalID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	denied, err := fx.executor.ExecuteSystem(fx.ctx, SystemClaims{
		OrganizationID:     fx.orgID,
		CapabilityID:       createCustomerCapabilityID,
		Permission:         "crm.write",
		IntentID:           wrongIntent,
		ApprovedApprovalID: wrongPending.ApprovalID,
	}, wrongInput)
	if err != nil || denied.OK || denied.Error != approvalVerificationError {
		t.Fatalf("substituted approval payload result=%+v err=%v, want fail-closed approval verification", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND name = $2`, fx.orgID, "Go system payload substitution"); got != 0 {
		t.Fatalf("payload substitution created %d customer rows, want none", got)
	}
}
