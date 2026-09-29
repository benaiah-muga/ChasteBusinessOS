package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoWave8IAMSettingsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "iam.admin")

	setInput := json.RawMessage(`{"modules":["pos","accounting"]}`)
	setClaims := waveModuleClaims(fx, iamSetModulesCapabilityID, "iam.admin", setInput, "human", "", "wave8-modules-set")
	set, err := fx.executor.Execute(fx.ctx, setClaims, iamSetModulesCapabilityID, setInput)
	if err != nil || !set.OK {
		t.Fatalf("setModules result=%+v err=%v", set, err)
	}
	var setOut IAMSetModulesOutput
	if err := json.Unmarshal(set.Data, &setOut); err != nil {
		t.Fatal(err)
	}
	if setOut.PreviousModules == nil || len(setOut.EnabledModules) < 3 {
		t.Fatalf("setModules output=%+v, want previous snapshot and protected union", setOut)
	}
	replay, err := fx.executor.Execute(fx.ctx, setClaims, iamSetModulesCapabilityID, setInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("setModules replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamSetModulesCapabilityID, "crm.write", setInput, "human", "", "wave8-modules-denied"), iamSetModulesCapabilityID, setInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: iam.admin") {
		t.Fatalf("setModules denied result=%+v err=%v, want permission failure", denied, err)
	}

	configInput := json.RawMessage(`{"module":"inventory","settings":{"defaultUnit":"pc"}}`)
	configured, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamSetModuleConfigCapabilityID, "iam.admin", configInput, "human", "", "wave8-config"), iamSetModuleConfigCapabilityID, configInput)
	if err != nil || !configured.OK {
		t.Fatalf("setModuleConfig result=%+v err=%v", configured, err)
	}
	if got := fx.count(`SELECT count(*) FROM module_settings WHERE org_id=$1::uuid AND module='inventory'`, fx.orgID); got != 1 {
		t.Fatalf("module settings rows=%d, want one", got)
	}

	fx.addAgentSession()
	fx.addPolicy(iamSetOrgBrandingCapabilityID, "read", nil)
	brandingInput := json.RawMessage(`{"accentColor":"#FF8800","layout":"modern"}`)
	approved := approveModuleWrite(t, fx, iamSetOrgBrandingCapabilityID, "iam.admin", brandingInput)
	var branding IAMSetOrgBrandingOutput
	if err := json.Unmarshal(approved.Data, &branding); err != nil {
		t.Fatal(err)
	}
	if !branding.Saved {
		t.Fatalf("setOrgBranding output=%+v, want saved", branding)
	}
	if got := fx.count(`SELECT count(*) FROM org_branding WHERE org_id=$1::uuid AND accent_color='#FF8800' AND layout='modern'`, fx.orgID); got != 1 {
		t.Fatalf("branding rows=%d, want one modern row", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, iamSetOrgBrandingCapabilityID); got != 1 {
		t.Fatalf("branding audit events=%d, want one", got)
	}
}

func TestGoWave8PurchasingReadsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.read")
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)

	performanceInput := json.RawMessage(`{}`)
	performance, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, purchasingSupplierPerformanceCapabilityID, "purchasing.read", performanceInput, "human", "", "wave8-performance"), purchasingSupplierPerformanceCapabilityID, performanceInput)
	if err != nil || !performance.OK {
		t.Fatalf("supplierPerformance result=%+v err=%v", performance, err)
	}
	var performanceOut PurchasingSupplierPerformanceOutput
	if err := json.Unmarshal(performance.Data, &performanceOut); err != nil {
		t.Fatal(err)
	}
	if len(performanceOut.Vendors) != 1 || performanceOut.Vendors[0].VendorName == "" {
		t.Fatalf("supplierPerformance output=%+v, want the seeded vendor", performanceOut)
	}
	replay, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, purchasingSupplierPerformanceCapabilityID, "purchasing.read", performanceInput, "human", "", "wave8-performance"), purchasingSupplierPerformanceCapabilityID, performanceInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("supplierPerformance replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	statementInput := json.RawMessage(`{"vendorId":"` + vendorID + `"}`)
	statement, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, purchasingSupplierStatementCapabilityID, "purchasing.read", statementInput, "human", "", "wave8-statement"), purchasingSupplierStatementCapabilityID, statementInput)
	if err != nil || !statement.OK {
		t.Fatalf("supplierStatement result=%+v err=%v", statement, err)
	}
	var statementOut PurchasingSupplierStatementOutput
	if err := json.Unmarshal(statement.Data, &statementOut); err != nil {
		t.Fatal(err)
	}
	if statementOut.ClosingBalanceMinor != 0 || len(statementOut.Rows) != 0 {
		t.Fatalf("supplierStatement output=%+v, want an empty statement for a vendor with no bills", statementOut)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, purchasingPriceHistoryCapabilityID, "crm.write", json.RawMessage(`{}`), "human", "", "wave8-history-denied"), purchasingPriceHistoryCapabilityID, json.RawMessage(`{}`))
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.read") {
		t.Fatalf("priceHistory denied result=%+v err=%v, want permission failure", denied, err)
	}
}
