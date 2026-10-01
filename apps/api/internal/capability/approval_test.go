package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func createPendingCustomerApproval(t *testing.T, fx *executorFixture, input json.RawMessage) string {
	t.Helper()
	if fx.count(`SELECT count(*) FROM agent_sessions WHERE id = $1::uuid`, fx.agentSession) == 0 {
		fx.addAgentSession()
	}
	if fx.count(`SELECT count(*) FROM policies WHERE org_id = $1::uuid AND capability_pattern = 'crm.*'`, fx.orgID) == 0 {
		fx.addPolicy("crm.*", "read", nil)
	}
	claims := fx.claims(input, "agent", fx.agentSession, "")
	result, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
	if err != nil || result.OK || !result.PendingApproval {
		t.Fatalf("gated execution result=%+v err=%v, want pending approval", result, err)
	}
	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals
		WHERE org_id = $1::uuid AND capability_id = $2 AND status = 'pending'
		ORDER BY created_at DESC LIMIT 1`, fx.orgID, createCustomerCapabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	return approvalID
}

func TestGoApprovalDecisionExecutesStoredPayloadAndAuditsHumanDecision(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Approved customer","email":"approved@fixture.test","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	comment := "reviewed and approved"
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	claims := fx.humanClaims(input, "")
	claims.IntentID = "approval-decision-must-not-create-a-second-receipt"
	result, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve", Comment: &comment})
	if err != nil || !result.OK || result.HTTPStatus != 200 || result.Status != "executed" || result.Result == nil || !result.Result.OK {
		t.Fatalf("approval result=%+v err=%v, want successful execution", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'executed' AND decided_by_user_id = $2::uuid AND decision_comment = $3`, approvalID, fx.userID, comment); got != 1 {
		t.Fatalf("finalized approval rows = %d, want one attributed execution", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND email = 'approved@fixture.test'`, fx.orgID); got != 1 {
		t.Fatalf("approved customer rows = %d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.granted'`, fx.orgID); got != 0 {
		t.Fatalf("direct human CRM re-execution emitted %d grant events, want legacy behavior of none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND actor_type = 'human' AND actor_id = $2::uuid`, fx.orgID, fx.userID); got != 1 {
		t.Fatalf("human execution events = %d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("approval re-execution wrote %d action receipts, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND capability_id = $2`, fx.orgID, createCustomerCapabilityID); got != 1 {
		t.Fatalf("agent approval followed by human execution left %d approval rows, want only the original gate", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND capability_id = $2 AND status = 'pending'`, fx.orgID, createCustomerCapabilityID); got != 0 {
		t.Fatalf("human approval execution created %d second pending gates, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.requested'`, fx.orgID); got != 1 {
		t.Fatalf("agent approval and human re-execution emitted %d approval requests, want one", got)
	}
}

func TestGoApprovalDecisionRollsBackWhenExecutionFinalizationFails(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Rolled back approval customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	functionName := "go_approval_finalize_" + strings.ReplaceAll(fx.orgID, "-", "")[:12]
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture approval finalization failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON approvals`, triggerName)); err != nil {
			t.Errorf("drop approval finalization trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop approval finalization function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE UPDATE ON approvals FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.status = 'executed')
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, functionName)); err != nil {
		t.Fatal(err)
	}
	result, err := NewApprovalDecider(fx.runtime, fx.executor).Decide(fx.ctx, fx.humanClaims(input, ""), ApprovalDecisionInput{
		ApprovalID: approvalID,
		Decision:   "approve",
	})
	if err == nil || result.HTTPStatus != 0 {
		t.Fatalf("approval result=%+v err=%v, want finalization failure", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'pending'`, approvalID); got != 1 {
		t.Fatalf("failed finalization left %d pending approval rows, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND name = 'Rolled back approval customer'`, fx.orgID); got != 0 {
		t.Fatalf("failed finalization left %d customer effects, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND capability_id = $2 AND kind = 'capability.executed'`, fx.orgID, createCustomerCapabilityID); got != 0 {
		t.Fatalf("failed finalization left %d execution audit events, want none", got)
	}
}

func TestGoCustomerExecutionMatchesLegacyHumanWritePolicy(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addPolicy("crm.*", "read", []string{"money"})
	input := json.RawMessage(`{"name":"Human write under legacy policy","preferredContactMethod":"email","doNotContact":false}`)

	result, err := fx.executor.Execute(fx.ctx, fx.humanClaims(input, ""), createCustomerCapabilityID, input)
	if err != nil || !result.OK || result.PendingApproval {
		t.Fatalf("human write result=%+v err=%v, want direct execution under legacy policy", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("direct human write created %d customers, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("direct human write created %d approvals, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.requested'`, fx.orgID); got != 0 {
		t.Fatalf("direct human write emitted %d approval requests, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed'`, fx.orgID); got != 1 {
		t.Fatalf("direct human write emitted %d execution events, want one", got)
	}
}

func TestGoApprovalDecisionRejectNeedsMembershipButNotCapabilityPermission(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Rejected customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	claims := fx.humanClaims(input, "")
	claims.Permissions = nil
	comment := "not the right customer"
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	result, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "reject", Comment: &comment})
	if err != nil || !result.OK || result.Status != "rejected" {
		t.Fatalf("rejection result=%+v err=%v, want rejected", result, err)
	}
	second, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "reject"})
	if err != nil || second.HTTPStatus != 409 {
		t.Fatalf("repeat rejection result=%+v err=%v, want 409", second, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'rejected' AND decision_comment = $2`, approvalID, comment); got != 1 {
		t.Fatalf("rejected approval rows = %d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.rejected' AND actor_type = 'human' AND actor_id = $2::uuid`, fx.orgID, fx.userID); got != 1 {
		t.Fatalf("human rejection events = %d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("rejection created %d customers, want none", got)
	}
}

func TestGoApprovalRejectionRollsBackWhenAuditAppendFails(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Rejected customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	functionName := "go_approval_reject_fail_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture approval audit failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop approval fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop approval fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.kind = 'approval.rejected')
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, functionName)); err != nil {
		t.Fatal(err)
	}
	comment := "reject while audit is unavailable"
	result, err := NewApprovalDecider(fx.runtime, fx.executor).Decide(fx.ctx, fx.humanClaims(input, ""), ApprovalDecisionInput{
		ApprovalID: approvalID,
		Decision:   "reject",
		Comment:    &comment,
	})
	if err == nil || result.HTTPStatus != 0 {
		t.Fatalf("rejection result=%+v err=%v, want audit append failure", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'pending'`, approvalID); got != 1 {
		t.Fatalf("failed audited rejection left %d pending approval rows, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.rejected'`, fx.orgID); got != 0 {
		t.Fatalf("failed rejection left %d audit events, want zero", got)
	}
}

func TestGoApprovalDecisionChecksPermissionBeforeClaimAndConsumesPayloadMismatch(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Approval payload customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	decider := NewApprovalDecider(fx.runtime, fx.executor)

	claims := fx.humanClaims(input, "")
	claims.Permissions = []string{"crm.read"}
	denied, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || denied.HTTPStatus != 403 || denied.Error != "you lack authority over this action" {
		t.Fatalf("unauthorized approval result=%+v err=%v, want 403", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'pending'`, approvalID); got != 1 {
		t.Fatalf("unauthorized decision changed pending row count to %d", got)
	}

	claims = fx.humanClaims(input, "")
	claims.InputSHA256 = strings.Repeat("0", 64)
	invalid := func() ApprovalDecisionResult {
		result, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
		if err != nil {
			t.Fatalf("payload mismatch decision error: %v", err)
		}
		return result
	}()
	if invalid.HTTPStatus != 422 || invalid.Error != approvalVerificationError {
		t.Fatalf("payload mismatch result=%+v, want legacy approval verification failure", invalid)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'failed' AND decided_by_user_id = $2::uuid`, approvalID, fx.userID); got != 1 {
		t.Fatalf("failed approval rows = %d, want one consumed gate", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.granted'`, fx.orgID); got != 0 {
		t.Fatalf("invalid payload emitted %d approval grant events, want none", got)
	}

	secondID := createPendingCustomerApproval(t, fx, input)
	withUnknownField := json.RawMessage(`{"name":"Approval payload customer","preferredContactMethod":"email","doNotContact":false,"unexpected":true}`)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET payload = $2::jsonb WHERE id = $1::uuid`, secondID, withUnknownField); err != nil {
		t.Fatal(err)
	}
	claims = fx.humanClaims(withUnknownField, "")
	stripped, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: secondID, Decision: "approve"})
	if err != nil || stripped.HTTPStatus != 422 || stripped.Error != approvalVerificationError {
		t.Fatalf("stripped payload result=%+v err=%v, want exact-payload refusal", stripped, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'failed'`, secondID); got != 1 {
		t.Fatalf("stripped-payload approval rows = %d, want one failed row", got)
	}
}

func TestGoApprovalDecisionVerifiesInventoryReadCapabilityInputs(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'inventory.read', $2::uuid) ON CONFLICT DO NOTHING`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)

	for _, capabilityID := range []string{inventoryListLocationRecordsCapabilityID, inventoryListItemMetadataCapabilityID} {
		t.Run(capabilityID, func(t *testing.T) {
			customerInput := json.RawMessage(`{"name":"Approval payload seed for ` + capabilityID + `","preferredContactMethod":"email","doNotContact":false}`)
			approvalID := createPendingCustomerApproval(t, fx, customerInput)
			input := json.RawMessage(`{}`)
			if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET capability_id = $2, payload = $3::jsonb WHERE id = $1::uuid`, approvalID, capabilityID, input); err != nil {
				t.Fatal(err)
			}

			claims := fx.humanClaims(input, "")
			claims.CapabilityID = capabilityID
			claims.Permissions = []string{"inventory.read"}
			result, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
			if err != nil || !result.OK || result.Status != "executed" || result.Result == nil || !result.Result.OK {
				t.Fatalf("inventory approval result=%+v err=%v, want verified read capability execution", result, err)
			}
		})
	}
}

func TestGoApprovalDecisionRechecksMembershipAndExpiry(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Membership approval customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	decider := NewApprovalDecider(fx.runtime, fx.executor)

	claims := fx.humanClaims(input, "")
	claims.AuthSessionID = "revoked-approval-session"
	unauthenticated, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "reject"})
	if err != nil || unauthenticated.HTTPStatus != 401 {
		t.Fatalf("invalid session decision result=%+v err=%v, want 401", unauthenticated, err)
	}
	claims = fx.humanClaims(input, "")
	claims.OrganizationID = fx.otherOrgID
	foreign, err := decider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "reject"})
	if err != nil || foreign.HTTPStatus != 403 {
		t.Fatalf("non-member decision result=%+v err=%v, want 403", foreign, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'pending'`, approvalID); got != 1 {
		t.Fatalf("non-member decision changed pending row count to %d", got)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET expires_at = $2 WHERE id = $1::uuid`, approvalID, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	expired, err := decider.Decide(fx.ctx, fx.humanClaims(input, ""), ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || expired.HTTPStatus != 410 || expired.Error != "this approval has expired; request it again" {
		t.Fatalf("expired decision result=%+v err=%v, want 410", expired, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'expired'`, approvalID); got != 1 {
		t.Fatalf("expired approval rows = %d, want one", got)
	}
}

type blockingApprovalExecutor struct {
	inner   ApprovalCapabilityExecutor
	started chan struct{}
	release chan struct{}
}

func (e *blockingApprovalExecutor) Execute(ctx context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (Result, error) {
	close(e.started)
	select {
	case <-e.release:
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	return e.inner.Execute(ctx, claims, capabilityID, input)
}

func TestGoApprovalDecisionClaimsPendingRowBeforeSingleExecution(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Racing approval customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	blocking := &blockingApprovalExecutor{inner: fx.executor, started: make(chan struct{}), release: make(chan struct{})}
	firstDecider := NewApprovalDecider(fx.runtime, blocking)
	secondDecider := NewApprovalDecider(fx.runtime, fx.executor)
	claims := fx.humanClaims(input, "")

	firstDone := make(chan ApprovalDecisionResult, 1)
	firstErr := make(chan error, 1)
	go func() {
		result, err := firstDecider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
		firstDone <- result
		firstErr <- err
	}()
	select {
	case <-blocking.started:
	case <-time.After(5 * time.Second):
		t.Fatal("first decision did not reach execution after claiming the row")
	}

	second, err := secondDecider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || second.HTTPStatus != 409 || !strings.Contains(second.Error, "being executed elsewhere") {
		t.Fatalf("concurrent decision result=%+v err=%v, want executing conflict", second, err)
	}
	close(blocking.release)
	first := <-firstDone
	if err := <-firstErr; err != nil || !first.OK || first.Status != "executed" {
		t.Fatalf("first decision result=%+v err=%v, want one success", first, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("racing decisions created %d customers, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed'`, fx.orgID); got != 1 {
		t.Fatalf("racing decisions appended %d execution events, want one", got)
	}
}

func TestApprovalDecisionInputRejectsInvalidDecisionAndLongComment(t *testing.T) {
	if utf16Comment := strings.Repeat("😀", 1001); len([]rune(utf16Comment)) != 1001 {
		t.Fatal("fixture comment is malformed")
	}
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Validation approval customer","preferredContactMethod":"email","doNotContact":false}`)
	approvalID := createPendingCustomerApproval(t, fx, input)
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	claims := fx.humanClaims(input, "")
	long := strings.Repeat("😀", 1001)
	for name, decision := range map[string]ApprovalDecisionInput{
		"invalid decision":    {ApprovalID: approvalID, Decision: "skip"},
		"long UTF-16 comment": {ApprovalID: approvalID, Decision: "reject", Comment: &long},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := decider.Decide(fx.ctx, claims, decision)
			if err != nil || result.HTTPStatus != 400 || result.Error != "invalid request" {
				t.Fatalf("invalid decision result=%+v err=%v, want 400", result, err)
			}
		})
	}
}
