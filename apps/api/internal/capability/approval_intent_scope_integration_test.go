package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoApprovalIntentCannotBeReusedForDifferentCapabilityInSameOrganization(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addPolicy("crm.*", "read", nil)
	intentID := executorUUID(t)

	customerInput := json.RawMessage(`{"name":"Intent conflict customer","preferredContactMethod":"email","doNotContact":false}`)
	first, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, createCustomerCapabilityID, "crm.write", intentID, "", ""), customerInput)
	if err != nil || first.OK || !first.PendingApproval || first.ApprovalID == "" {
		t.Fatalf("first capability result=%+v err=%v, want pending approval", first, err)
	}

	dealInput := json.RawMessage(`{"title":"Intent conflict deal","valueMinor":1000}`)
	conflict, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, createDealCapabilityID, "crm.write", intentID, "", ""), dealInput)
	if err != nil || conflict.OK || conflict.PendingApproval || !strings.Contains(conflict.Error, "action intent conflict") {
		t.Fatalf("different-capability reuse result=%+v err=%v, want action intent conflict", conflict, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND intent_id=$2`, fx.orgID, intentID); got != 1 {
		t.Fatalf("same-org capability conflict created %d approvals, want only the original pending row", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND intent_id=$2 AND capability_id=$3 AND status='pending'`, fx.orgID, intentID, createCustomerCapabilityID); got != 1 {
		t.Fatalf("original pending customer approval rows=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM deals WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("conflicting intent created %d deals, want none", got)
	}
}

func TestGoApprovalIntentIsIndependentAcrossOrganizations(t *testing.T) {
	fx := newExecutorFixture(t)
	intentID := executorUUID(t)
	fx.addPolicy("crm.*", "read", nil)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, requires_approval_for)
		VALUES ($1::uuid, 'crm.*', 'read', '[]'::jsonb)`, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"name":"Tenant scoped intent customer","preferredContactMethod":"email","doNotContact":false}`)

	first, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, createCustomerCapabilityID, "crm.write", intentID, "", ""), input)
	if err != nil || first.OK || !first.PendingApproval || first.ApprovalID == "" {
		t.Fatalf("first organization result=%+v err=%v, want pending approval", first, err)
	}
	secondClaims := approvalIntentSystemClaimsForOrg(t, fx, fx.otherOrgID, createCustomerCapabilityID, "crm.write", intentID)
	second, err := fx.executor.ExecuteSystem(fx.ctx, secondClaims, input)
	if err != nil || second.OK || !second.PendingApproval || second.ApprovalID == "" {
		t.Fatalf("second organization result=%+v err=%v, want independent pending approval", second, err)
	}
	if first.ApprovalID == second.ApprovalID {
		t.Fatalf("organizations shared approval ID %q, want distinct tenant rows", first.ApprovalID)
	}

	var firstOrgID, firstCapability, firstStatus, firstIntent string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, capability_id, status, intent_id FROM approvals WHERE id=$1::uuid`, first.ApprovalID).
		Scan(&firstOrgID, &firstCapability, &firstStatus, &firstIntent); err != nil {
		t.Fatal(err)
	}
	var secondOrgID, secondCapability, secondStatus, secondIntent string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, capability_id, status, intent_id FROM approvals WHERE id=$1::uuid`, second.ApprovalID).
		Scan(&secondOrgID, &secondCapability, &secondStatus, &secondIntent); err != nil {
		t.Fatal(err)
	}
	if firstOrgID != fx.orgID || secondOrgID != fx.otherOrgID ||
		firstCapability != createCustomerCapabilityID || secondCapability != createCustomerCapabilityID ||
		firstStatus != "pending" || secondStatus != "pending" || firstIntent != intentID || secondIntent != intentID {
		t.Fatalf("approval tenant rows first=(%q,%q,%q,%q) second=(%q,%q,%q,%q)",
			firstOrgID, firstCapability, firstStatus, firstIntent,
			secondOrgID, secondCapability, secondStatus, secondIntent)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE intent_id=$1 AND status='pending'`, intentID); got != 2 {
		t.Fatalf("shared intent has %d pending approvals across fixture organizations, want two", got)
	}
}

func approvalIntentSystemClaimsForOrg(t *testing.T, fx *executorFixture, orgID, capabilityID, permission, intentID string) SystemClaims {
	t.Helper()
	var jobID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO jobs (org_id, type, payload, max_attempts)
		VALUES ($1::uuid, $2, '{}'::jsonb, 3)
		RETURNING id::text`, orgID, capabilityID).Scan(&jobID); err != nil {
		t.Fatalf("insert system executor lease job for organization %s: %v", orgID, err)
	}
	const leaseOwner = "approval-intent-scope-test-owner"
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE jobs SET status='processing', lease_owner=$2, fencing_token=1,
			lease_expires_at=clock_timestamp() + interval '1 hour'
		WHERE id=$1::uuid AND org_id=$3::uuid`, jobID, leaseOwner, orgID); err != nil {
		t.Fatalf("claim system executor test job for organization %s: %v", orgID, err)
	}
	return SystemClaims{
		OrganizationID: orgID, CapabilityID: capabilityID, Permission: permission,
		IntentID: intentID, JobID: jobID, LeaseOwner: leaseOwner,
		FencingToken: 1, LeaseExtensionMillis: 180_000,
	}
}
