package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestSystemPurchaseOrderRequiresVerifiedApproval(t *testing.T) {
	fx := newExecutorFixture(t)
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'System commitment supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"vendorId":"` + vendorID + `","lines":[{"description":"Committed stock","quantity":1000,"unitPriceMinor":5000}]}`)
	claims := fx.systemClaims(t, createPurchaseOrderCapabilityID, "purchasing.write", executorUUID(t), "", "")

	result, err := fx.executor.ExecuteSystem(fx.ctx, claims, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.OK || !strings.Contains(result.Error, "verified human approval") {
		t.Fatalf("system purchase order result=%+v, want a verified-approval refusal", result)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("system purchase order wrote %d orders, want zero", got)
	}
}

func TestCreatePurchaseOrderRejectsDeactivatedVendor(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'purchasing.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name, deactivated_at)
		VALUES ($1::uuid, 'Deactivated supplier', now())
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"vendorId":"` + vendorID + `","lines":[{"description":"Committed stock","quantity":1000,"unitPriceMinor":5000}]}`)
	claims := fx.humanClaims(input, "deactivated-vendor-"+executorUUID(t))
	claims.CapabilityID = createPurchaseOrderCapabilityID
	claims.Permissions = []string{"purchasing.write"}

	if _, err := fx.executor.Execute(fx.ctx, claims, createPurchaseOrderCapabilityID, input); err == nil || !strings.Contains(err.Error(), "vendor is deactivated") {
		t.Fatalf("deactivated vendor error=%v, want vendor is deactivated", err)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("deactivated vendor received %d orders, want zero", got)
	}
}

func TestSelectWinningQuoteRejectsDeactivatedVendor(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name, deactivated_at)
		VALUES ($1::uuid, 'Retired quote supplier', now())
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	requestID := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Retired supplier award", "Approved for quoting", "approved", nil, now.Add(-time.Hour))
	rfqID := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendorID, "quoted", crmInt64Pointer(4400), nil, &now)

	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: rfqID}, now)
		return struct{}{}, err
	})
	if err == nil || err.Error() != "vendor is deactivated" {
		t.Fatalf("quote award error=%v, want vendor is deactivated", err)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("deactivated vendor award wrote %d orders, want zero", got)
	}
}

func TestAgentPurchaseOrderReturnsPendingApprovalWithoutWriting(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'purchasing.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Agent commitment supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"vendorId":"` + vendorID + `","lines":[{"description":"Proposed stock","quantity":1000,"unitPriceMinor":5000}]}`)
	claims := fx.claims(input, "agent", fx.agentSession, executorUUID(t))
	claims.CapabilityID = createPurchaseOrderCapabilityID
	claims.Permissions = []string{"purchasing.write"}

	result, err := fx.executor.Execute(fx.ctx, claims, createPurchaseOrderCapabilityID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.PendingApproval || result.ApprovalID == "" {
		t.Fatalf("agent purchase order result=%+v, want a pending approval", result)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("agent purchase order wrote %d orders before approval, want zero", got)
	}
}
