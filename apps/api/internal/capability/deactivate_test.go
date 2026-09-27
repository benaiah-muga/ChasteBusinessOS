package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func deactivateCustomerClaims(fx *executorFixture, input json.RawMessage, actorType, agentSession, intent string) authbridge.CapabilityClaims {
	claims := fx.claims(input, actorType, agentSession, intent)
	claims.CapabilityID = deactivateCustomerCapabilityID
	return claims
}

func seedCustomer(t *testing.T, fx *executorFixture, orgID, name string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, $2)
		RETURNING id::text`, orgID, name).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func TestGoCustomerDeactivationPreservesHistoryAndScopesOrganization(t *testing.T) {
	fx := newExecutorFixture(t)
	localCustomerID := seedCustomer(t, fx, fx.orgID, "Retained customer history")
	foreignCustomerID := seedCustomer(t, fx, fx.otherOrgID, "Foreign customer history")
	var originalUpdatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_at FROM customers WHERE id = $1::uuid`, localCustomerID).Scan(&originalUpdatedAt); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(fmt.Sprintf(`{"customerId":%q,"ignored":"stripped by the legacy schema"}`, localCustomerID))
	claims := deactivateCustomerClaims(fx, input, "human", "", "deactivate-history")
	result, err := fx.executor.Execute(fx.ctx, claims, deactivateCustomerCapabilityID, input)
	if err != nil || !result.OK || result.PendingApproval || string(result.Data) != `{"deactivated":true}` {
		t.Fatalf("deactivation result=%+v err=%v, want {deactivated:true}", result, err)
	}
	var name string
	var deactivatedAt *time.Time
	var updatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT name, deactivated_at, updated_at FROM customers WHERE id = $1::uuid`, localCustomerID).
		Scan(&name, &deactivatedAt, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if name != "Retained customer history" || deactivatedAt == nil || !updatedAt.Equal(originalUpdatedAt) {
		t.Fatalf("deactivated customer name=%q deactivatedAt=%v updatedAt=%s, want retained row, timestamp, and unchanged updated_at", name, deactivatedAt, updatedAt)
	}
	var foreignDeactivatedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM customers WHERE id = $1::uuid`, foreignCustomerID).Scan(&foreignDeactivatedAt); err != nil {
		t.Fatal(err)
	}
	if foreignDeactivatedAt != nil {
		t.Fatalf("cross-organization customer was deactivated at %s", foreignDeactivatedAt)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2`, fx.orgID, deactivateCustomerCapabilityID); got != 1 {
		t.Fatalf("deactivation execution events = %d, want one", got)
	}
	var payload []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT payload::text FROM ledger_events
		WHERE org_id = $1::uuid AND capability_id = $2 AND kind = 'capability.executed'`, fx.orgID, deactivateCustomerCapabilityID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	auditDigest, err := InputHash(payload)
	if err != nil {
		t.Fatal(err)
	}
	wantAuditDigest, err := InputHash(json.RawMessage(fmt.Sprintf(`{"input":{"customerId":%q}}`, localCustomerID)))
	if err != nil {
		t.Fatal(err)
	}
	if auditDigest != wantAuditDigest {
		t.Fatalf("deactivation audit payload = %s, want exact normalized input", payload)
	}

	foreignInput := json.RawMessage(fmt.Sprintf(`{"customerId":%q}`, foreignCustomerID))
	foreignScope, err := fx.executor.Execute(fx.ctx, deactivateCustomerClaims(fx, foreignInput, "human", "", ""), deactivateCustomerCapabilityID, foreignInput)
	if err != nil || !foreignScope.OK || string(foreignScope.Data) != `{"deactivated":true}` {
		t.Fatalf("foreign-id deactivation result=%+v err=%v, want legacy success response", foreignScope, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM customers WHERE id = $1::uuid`, foreignCustomerID).Scan(&foreignDeactivatedAt); err != nil {
		t.Fatal(err)
	}
	if foreignDeactivatedAt != nil {
		t.Fatalf("organization-scoped update changed foreign customer at %s", foreignDeactivatedAt)
	}

	nonmemberClaims := deactivateCustomerClaims(fx, foreignInput, "human", "", "")
	nonmemberClaims.OrganizationID = fx.otherOrgID
	if _, err := fx.executor.Execute(fx.ctx, nonmemberClaims, deactivateCustomerCapabilityID, foreignInput); !errors.Is(err, ErrNotMember) {
		t.Fatalf("non-member deactivation error = %v, want ErrNotMember", err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2`, fx.otherOrgID, deactivateCustomerCapabilityID); got != 0 {
		t.Fatalf("non-member execution events = %d, want none", got)
	}
}

func TestGoCustomerDeactivationDeniesMissingPermission(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedCustomer(t, fx, fx.orgID, "Permission protected customer")
	input := json.RawMessage(fmt.Sprintf(`{"customerId":%q}`, customerID))
	claims := deactivateCustomerClaims(fx, input, "human", "", "")
	claims.Permissions = []string{"crm.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, deactivateCustomerCapabilityID, input)
	if err != nil || result.OK || result.Error != "forbidden: missing permission: crm.write" {
		t.Fatalf("permission denial result=%+v err=%v, want crm.write refusal", result, err)
	}
	var deactivatedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM customers WHERE id = $1::uuid`, customerID).Scan(&deactivatedAt); err != nil {
		t.Fatal(err)
	}
	if deactivatedAt != nil {
		t.Fatalf("unauthorized deactivation changed row at %s", deactivatedAt)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND capability_id = $2 AND kind = 'capability.executed'`, fx.orgID, deactivateCustomerCapabilityID); got != 0 {
		t.Fatalf("unauthorized execution events = %d, want none", got)
	}
}

func TestGoCustomerDeactivationRollsBackEffectWhenAuditAppendFails(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedCustomer(t, fx, fx.orgID, "Audit rollback customer")
	functionName := "go_deactivate_fail_ledger_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture deactivation audit failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop deactivation fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop deactivation fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.kind = 'capability.executed' AND NEW.capability_id = '%s')
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, deactivateCustomerCapabilityID, functionName)); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(fmt.Sprintf(`{"customerId":%q}`, customerID))
	claims := deactivateCustomerClaims(fx, input, "human", "", "deactivate-audit-failure")
	if _, err := fx.executor.Execute(fx.ctx, claims, deactivateCustomerCapabilityID, input); err == nil {
		t.Fatal("deactivation succeeded despite audit append failure")
	}
	var deactivatedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM customers WHERE id = $1::uuid`, customerID).Scan(&deactivatedAt); err != nil {
		t.Fatal(err)
	}
	if deactivatedAt != nil {
		t.Fatalf("failed audited write left deactivated_at=%s", deactivatedAt)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("failed audited deactivation left %d action receipts, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2`, fx.orgID, deactivateCustomerCapabilityID); got != 0 {
		t.Fatalf("failed audited deactivation left %d events, want none", got)
	}
}

func TestGoCustomerDeactivationAgentApprovalCompletesOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy("crm.*", "read", nil)
	customerID := seedCustomer(t, fx, fx.orgID, "Agent approval customer")
	input := json.RawMessage(fmt.Sprintf(`{"customerId":%q}`, customerID))
	agentClaims := deactivateCustomerClaims(fx, input, "agent", fx.agentSession, "deactivate-agent-intent")
	pending, err := fx.executor.Execute(fx.ctx, agentClaims, deactivateCustomerCapabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent deactivation result=%+v err=%v, want pending approval", pending, err)
	}
	var approvalID string
	var approvalPayload []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, payload::text FROM approvals
		WHERE org_id = $1::uuid AND capability_id = $2 AND status = 'pending'`, fx.orgID, deactivateCustomerCapabilityID).Scan(&approvalID, &approvalPayload); err != nil {
		t.Fatal(err)
	}
	storedDigest, err := InputHash(approvalPayload)
	if err != nil {
		t.Fatal(err)
	}
	wantDigest, err := InputHash(input)
	if err != nil {
		t.Fatal(err)
	}
	if storedDigest != wantDigest {
		t.Fatalf("stored deactivation approval payload digest = %s, want %s", storedDigest, wantDigest)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	approved, err := decider.Decide(fx.ctx, deactivateCustomerClaims(fx, input, "human", "", ""), ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || !approved.OK || approved.Status != "executed" || approved.Result == nil || !approved.Result.OK {
		t.Fatalf("approved deactivation result=%+v err=%v, want one completed effect", approved, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND capability_id = $2`, fx.orgID, deactivateCustomerCapabilityID); got != 1 {
		t.Fatalf("agent approval then human execution left %d approval rows, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND capability_id = $2 AND status = 'pending'`, fx.orgID, deactivateCustomerCapabilityID); got != 0 {
		t.Fatalf("human approval execution created %d second pending approvals", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND id = $2::uuid AND deactivated_at IS NOT NULL`, fx.orgID, customerID); got != 1 {
		t.Fatalf("approved deactivation changed customer row count to %d, want one soft-deactivated row", got)
	}
}
