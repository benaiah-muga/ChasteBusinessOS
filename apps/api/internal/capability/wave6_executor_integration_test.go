package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoWave6PurchasingLifecycleGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.write")
	grantWavePermission(t, fx, "purchasing.read")
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo)
		VALUES ($1::uuid, $2::uuid, 1, 'open', 'Wave6 lifecycle order')`, fx.orgID, vendorID); err != nil {
		t.Fatal(err)
	}

	receiptsInput := json.RawMessage(`{"poNumber":1}`)
	receipts, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, listReceiptsCapabilityID, "purchasing.read", receiptsInput, "human", "", "wave6-receipts"), listReceiptsCapabilityID, receiptsInput)
	if err != nil || !receipts.OK {
		t.Fatalf("listReceipts result=%+v err=%v", receipts, err)
	}
	var receiptsOut ListReceiptsOutput
	if err := json.Unmarshal(receipts.Data, &receiptsOut); err != nil {
		t.Fatal(err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, closePurchaseOrderCapabilityID, "crm.write", receiptsInput, "human", "", "wave6-close-denied"), closePurchaseOrderCapabilityID, receiptsInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.write") {
		t.Fatalf("closePurchaseOrder denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(closePurchaseOrderCapabilityID, "read", nil)
	closeInput := json.RawMessage(`{"poNumber":1}`)
	approved := approveModuleWrite(t, fx, closePurchaseOrderCapabilityID, "purchasing.write", closeInput)
	var closed ClosePurchaseOrderOutput
	if err := json.Unmarshal(approved.Data, &closed); err != nil {
		t.Fatal(err)
	}
	if !closed.Closed {
		t.Fatalf("closePurchaseOrder output=%+v, want closed", closed)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND vendor_id=$2::uuid AND status='closed'`, fx.orgID, vendorID); got != 1 {
		t.Fatalf("closed purchase orders=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, closePurchaseOrderCapabilityID); got != 1 {
		t.Fatalf("close audit events=%d, want one", got)
	}
}

func TestGoWave6InventoryValuationGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	grantWavePermission(t, fx, "inventory.read")
	grantWavePermission(t, fx, "inventory.write")
	grantWavePermission(t, fx, "inventory.admin")
	seedInventoryValuationAccounts(t, fx, fx.orgID)
	itemID := seedInventoryValuationItem(t, fx, fx.orgID, "SKU-W6", "goods", 4000, 1000, nil)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 5000, "purchase", nil, nil, nil, "system", time.Now().UTC())

	reportInput := json.RawMessage(`{}`)
	report, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryStockReportCapabilityID, "inventory.read", reportInput, "human", "", "wave6-stock-report"), inventoryStockReportCapabilityID, reportInput)
	if err != nil || !report.OK {
		t.Fatalf("stockReport result=%+v err=%v", report, err)
	}
	var reportOut InventoryStockReportOutput
	if err := json.Unmarshal(report.Data, &reportOut); err != nil {
		t.Fatal(err)
	}
	if len(reportOut.Items) != 1 || reportOut.Items[0].OnHandThousandths != 5000 {
		t.Fatalf("stockReport output=%+v, want one item at 5000 thousandths", reportOut)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryRebuildStockProjectionsCapabilityID, "inventory.read", reportInput, "human", "", "wave6-rebuild-denied"), inventoryRebuildStockProjectionsCapabilityID, reportInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: inventory.admin") {
		t.Fatalf("rebuildStockProjections denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(inventoryRebuildStockProjectionsCapabilityID, "read", nil)
	approved := approveModuleWrite(t, fx, inventoryRebuildStockProjectionsCapabilityID, "inventory.admin", reportInput)
	var rebuilt InventoryRebuildStockProjectionsOutput
	if err := json.Unmarshal(approved.Data, &rebuilt); err != nil {
		t.Fatal(err)
	}
	if rebuilt.Rows < 1 || rebuilt.TotalQuantityThousandths != 5000 {
		t.Fatalf("rebuildStockProjections output=%+v, want the ledger truth restored", rebuilt)
	}
}

func TestGoWave6ReportsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")
	customerID := seedReportsCustomer(t, fx, fx.orgID, "Wave6 Customer")
	seedReportsInvoice(t, fx, fx.orgID, customerID, 1, "sent", "USD", 200000, 0, 200000, 0, 0, nil, nil, nil)

	agingInput := json.RawMessage(`{}`)
	agingClaims := waveModuleClaims(fx, arAgingCapabilityID, "accounting.read", agingInput, "human", "", "wave6-aging")
	aging, err := fx.executor.Execute(fx.ctx, agingClaims, arAgingCapabilityID, agingInput)
	if err != nil || !aging.OK {
		t.Fatalf("arAging result=%+v err=%v", aging, err)
	}
	var agingOut ArAgingOutput
	if err := json.Unmarshal(aging.Data, &agingOut); err != nil {
		t.Fatal(err)
	}
	replay, err := fx.executor.Execute(fx.ctx, agingClaims, arAgingCapabilityID, agingInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("arAging replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, arAgingCapabilityID, "crm.write", agingInput, "human", "", "wave6-aging-denied"), arAgingCapabilityID, agingInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("arAging denied result=%+v err=%v, want permission failure", denied, err)
	}

	statementInput := json.RawMessage(`{"customerId":"` + customerID + `"}`)
	statement, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, customerStatementCapabilityID, "accounting.read", statementInput, "human", "", "wave6-statement"), customerStatementCapabilityID, statementInput)
	if err != nil || !statement.OK {
		t.Fatalf("customerStatement result=%+v err=%v", statement, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, customerStatementCapabilityID); got != 1 {
		t.Fatalf("statement audit events=%d, want one", got)
	}
}

func TestGoWave6FxGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	grantWavePermission(t, fx, "accounting.read")
	grantWavePermission(t, fx, "accounting.post")
	seedAccountingFxBase(t, fx, fx.orgID)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "KES", 1, 130, time.Now().UTC().Add(-24*time.Hour))
	seedAccountingFxInvoice(t, fx, fx.orgID, "KES", "sent", 13000000, 0, 0, nil, nil, nil, nil)

	exposureInput := json.RawMessage(`{}`)
	exposureClaims := waveModuleClaims(fx, unrealizedFxExposureCapabilityID, "accounting.read", exposureInput, "human", "", "wave6-exposure")
	exposure, err := fx.executor.Execute(fx.ctx, exposureClaims, unrealizedFxExposureCapabilityID, exposureInput)
	if err != nil || !exposure.OK {
		t.Fatalf("unrealizedFxExposure result=%+v err=%v", exposure, err)
	}
	var exposureOut UnrealizedFxExposureOutput
	if err := json.Unmarshal(exposure.Data, &exposureOut); err != nil {
		t.Fatal(err)
	}
	if len(exposureOut.Exposures) != 1 || exposureOut.Exposures[0].Currency != "KES" {
		t.Fatalf("unrealizedFxExposure output=%+v, want one KES row", exposureOut)
	}
	replay, err := fx.executor.Execute(fx.ctx, exposureClaims, unrealizedFxExposureCapabilityID, exposureInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("unrealizedFxExposure replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, unrealizedFxExposureCapabilityID, "crm.write", exposureInput, "human", "", "wave6-exposure-denied"), unrealizedFxExposureCapabilityID, exposureInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("unrealizedFxExposure denied result=%+v err=%v, want permission failure", denied, err)
	}
}

func TestGoWave6SystemMoneyExecutionRequiresVerifiedHumanApproval(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	grantWavePermission(t, fx, "inventory.write")
	seedInventoryValuationAccounts(t, fx, fx.orgID)
	itemID := seedInventoryValuationItem(t, fx, fx.orgID, "SKU-APPROVAL", "goods", 0, 0, nil)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 1000, "purchase", inventoryValuationIntPointer(1000), nil, nil, "human", time.Now().UTC())
	fx.addAgentSession()

	input := json.RawMessage(`{}`)
	pending, err := fx.executor.Execute(fx.ctx, waveModuleClaims(
		fx, inventoryPostValuationSummaryCapabilityID, "inventory.write", input, "agent", fx.agentSession, ""),
		inventoryPostValuationSummaryCapabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval || pending.ApprovalID == "" {
		t.Fatalf("agent valuation result=%+v err=%v, want pending approval", pending, err)
	}

	systemClaims := SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   inventoryPostValuationSummaryCapabilityID,
		Permission:     "inventory.write",
		IntentID:       executorUUID(t),
	}
	withoutApproval, err := fx.executor.ExecuteSystem(fx.ctx, systemClaims, input)
	if err != nil || withoutApproval.OK || withoutApproval.Error != "system money actions require a verified human approval" {
		t.Fatalf("system valuation without approval=%+v err=%v", withoutApproval, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type=$2`, fx.orgID, inventoryValuationSourceType); got != 0 {
		t.Fatalf("unapproved system valuation posted %d entries, want none", got)
	}

	systemClaims.ApprovedApprovalID = pending.ApprovalID
	unapproved, err := fx.executor.ExecuteSystem(fx.ctx, systemClaims, input)
	if err != nil || unapproved.OK || unapproved.Error != approvalVerificationError {
		t.Fatalf("system valuation with still-pending approval=%+v err=%v", unapproved, err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET status='executing' WHERE id=$1::uuid AND org_id=$2::uuid`, pending.ApprovalID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	wrongInput := json.RawMessage(`{"memo":"Different approved action"}`)
	substituted, err := fx.executor.ExecuteSystem(fx.ctx, systemClaims, wrongInput)
	if err != nil || substituted.OK || substituted.Error != approvalVerificationError {
		t.Fatalf("system valuation with substituted payload=%+v err=%v", substituted, err)
	}

	approved, err := fx.executor.ExecuteSystem(fx.ctx, systemClaims, input)
	if err != nil || !approved.OK {
		t.Fatalf("system valuation with exact human approval=%+v err=%v", approved, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type=$2`, fx.orgID, inventoryValuationSourceType); got != 1 {
		t.Fatalf("approved system valuation posted %d entries, want one", got)
	}
}
