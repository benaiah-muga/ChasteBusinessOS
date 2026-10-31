package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestInventoryReplenishmentPlanInputContract(t *testing.T) {
	defaults, err := ParseInventoryReplenishmentPlanInput(json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if defaults.LookbackDays != 90 || defaults.ReviewDays != 7 || defaults.LeadTimeDays != 14 || defaults.ServiceLevel != "95" || defaults.IncludeSufficient {
		t.Fatalf("unexpected defaults: %+v", defaults)
	}

	full, err := ParseInventoryReplenishmentPlanInput(json.RawMessage(`{"sku":"SKU-1","lookbackDays":30,"reviewDays":3,"leadTimeDays":21,"serviceLevel":"98","includeSufficient":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if full.SKU != "SKU-1" || full.LookbackDays != 30 || full.ReviewDays != 3 || full.LeadTimeDays != 21 || full.ServiceLevel != "98" || !full.IncludeSufficient {
		t.Fatalf("unexpected parsed input: %+v", full)
	}

	for name, raw := range map[string]string{
		"unknown field":        `{"horizonDays":30}`,
		"empty sku":            `{"sku":"   "}`,
		"short lookback":       `{"lookbackDays":6}`,
		"long lookback":        `{"lookbackDays":366}`,
		"negative review":      `{"reviewDays":-1}`,
		"zero lead time":       `{"leadTimeDays":0}`,
		"unsupported level":    `{"serviceLevel":"99.9"}`,
		"null include flag":    `{"includeSufficient":null}`,
		"string include flag":  `{"includeSufficient":"true"}`,
		"fractional lookback":  `{"lookbackDays":30.5}`,
		"quoted numeric field": `{"lookbackDays":"30"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseInventoryReplenishmentPlanInput(json.RawMessage(raw)); err == nil {
				t.Fatalf("expected %s to be rejected", raw)
			}
		})
	}
}

func TestInventoryReplenishmentPlanRegistration(t *testing.T) {
	spec, ok := capabilitySpecs[inventoryReplenishmentPlanCapabilityID]
	if !ok {
		t.Fatal("capability spec is missing")
	}
	if spec.module != "inventory" || spec.permission != "inventory.read" || spec.risk != "read" || spec.humanOnly {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	if !supportedCapability(inventoryReplenishmentPlanCapabilityID) {
		t.Fatal("capability is not dispatched by the executor")
	}
	if !strings.HasPrefix(inventoryReplenishmentPlanCapabilityID, "inventory.") {
		t.Fatalf("capability id %q is outside the inventory module", inventoryReplenishmentPlanCapabilityID)
	}

	tool := findAgentTool(t, AgentTools(map[string]bool{"inventory.read": true}), inventoryReplenishmentPlanCapabilityID)
	if tool.Permission != "inventory.read" || tool.Risk != "read" {
		t.Fatalf("unexpected agent tool: %+v", tool)
	}
	assertUsefulAgentToolContract(t, tool)

	if findAgentToolOrNil(AgentTools(map[string]bool{"crm.read": true}), inventoryReplenishmentPlanCapabilityID) != nil {
		t.Fatal("replenishment plan was advertised without inventory.read")
	}

	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
		t.Fatal(err)
	}
	if _, ok := schema.Properties["includeSufficient"]; !ok {
		t.Fatalf("agent schema is missing includeSufficient: %s", tool.InputSchema)
	}
}

func findAgentTool(t *testing.T, tools []AgentToolSpec, id string) AgentToolSpec {
	t.Helper()
	tool := findAgentToolOrNil(tools, id)
	if tool == nil {
		t.Fatalf("agent tool %s was not advertised", id)
	}
	return *tool
}

func findAgentToolOrNil(tools []AgentToolSpec, id string) *AgentToolSpec {
	for index := range tools {
		if tools[index].ID == id {
			return &tools[index]
		}
	}
	return nil
}

func TestInventoryReplenishmentPlanExecutorReadsLiveRecordsAndScopesTenant(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'inventory.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	lowItem := seedReplenishmentItem(t, fx, fx.orgID, "LOW-1", "Low stock item", 10_000)
	incomingItem := seedReplenishmentItem(t, fx, fx.orgID, "INCOMING-1", "Covered by incoming item", 10_000)
	seedReplenishmentItem(t, fx, fx.otherOrgID, "OTHER-1", "Other tenant item", 10_000)

	now := time.Now().UTC()
	seedReplenishmentMovement(t, fx, fx.orgID, lowItem, 35_000, "purchase", int64Pointer(500), now.AddDate(0, 0, -40))
	for day := 0; day < 30; day++ {
		seedReplenishmentMovement(t, fx, fx.orgID, lowItem, -1_000, "sale", nil, now.AddDate(0, 0, -day))
	}
	seedReplenishmentMovement(t, fx, fx.orgID, incomingItem, 2_000, "purchase", int64Pointer(700), now.AddDate(0, 0, -40))

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_reservations (org_id, item_id, quantity_thousandths, reason, status, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 2000, 'customer order', 'open', 'human')`, fx.orgID, lowItem); err != nil {
		t.Fatal(err)
	}

	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Replenishment supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	var poID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status)
		VALUES ($1::uuid, $2::uuid, 1, 'ordered')
		RETURNING id::text`, fx.orgID, vendorID).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, item_id, position)
		VALUES ($1::uuid, 'Incoming replenishment', 20000, 700, $2::uuid, 1)`, poID, incomingItem); err != nil {
		t.Fatal(err)
	}

	beforePOs := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID)
	beforeMovements := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid`, fx.orgID)
	beforeReservations := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid`, fx.orgID)

	input := json.RawMessage(`{"lookbackDays":30,"reviewDays":7,"leadTimeDays":14,"serviceLevel":"95"}`)
	claims := fx.humanClaims(input, "replenishment-plan-"+executorUUID(t))
	claims.CapabilityID = inventoryReplenishmentPlanCapabilityID
	claims.Permissions = []string{"inventory.read"}

	result, err := fx.executor.Execute(fx.ctx, claims, inventoryReplenishmentPlanCapabilityID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("planner refused: %s", result.Error)
	}
	var output InventoryReplenishmentPlanOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.Currency != "USD" {
		t.Fatalf("currency=%q, want USD", output.Currency)
	}
	if output.Summary.Evaluated != 2 || output.Summary.ActionRequired != 1 || output.Summary.CoveredByIncoming != 1 || output.Summary.HistoryInsufficient != 1 {
		t.Fatalf("unexpected summary: %+v", output.Summary)
	}
	if len(output.Items) != 2 {
		t.Fatalf("items=%d, want 2 (low stock and covered incoming)", len(output.Items))
	}

	var low, incoming *InventoryReplenishmentItem
	for index := range output.Items {
		switch output.Items[index].SKU {
		case "LOW-1":
			low = &output.Items[index]
		case "INCOMING-1":
			incoming = &output.Items[index]
		case "OTHER-1":
			t.Fatal("planner leaked another tenant's item")
		}
	}
	if low == nil || incoming == nil {
		t.Fatalf("missing expected plan items: %+v", output.Items)
	}
	if low.OnHandThousandths != 5_000 || low.ReservedThousandths != 2_000 || low.AvailableThousandths != 3_000 {
		t.Fatalf("unexpected low-stock position: %+v", low)
	}
	wantSuggested := low.TargetStockThousandths - low.AvailableThousandths - low.IncomingThousandths
	if wantSuggested < 0 {
		wantSuggested = 0
	}
	if low.SuggestedOrderQtyThousandths != wantSuggested || low.SuggestedOrderQtyThousandths <= 0 {
		t.Fatalf("suggested=%d, want %d from target=%d available=%d incoming=%d", low.SuggestedOrderQtyThousandths, wantSuggested, low.TargetStockThousandths, low.AvailableThousandths, low.IncomingThousandths)
	}
	if low.Status != "reorder" || low.HistoryInsufficient {
		t.Fatalf("unexpected low-stock status: %+v", low)
	}
	wantCost, err := inventoryJsRoundProductDiv(low.SuggestedOrderQtyThousandths, 500, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if low.EstimatedCostMinor != wantCost {
		t.Fatalf("estimated cost=%d, want %d", low.EstimatedCostMinor, wantCost)
	}
	if low.DaysOfCover == nil || *low.DaysOfCover <= 0 {
		t.Fatalf("days of cover=%v, want a positive value", low.DaysOfCover)
	}
	if low.Evidence.ReorderPointSource != "demand_model" || low.Evidence.UnitCostSource != "latest_recorded" {
		t.Fatalf("unexpected evidence: %+v", low.Evidence)
	}

	if incoming.IncomingThousandths != 20_000 || incoming.SuggestedOrderQtyThousandths != 0 || incoming.Status != "covered_by_incoming" {
		t.Fatalf("incoming item was not covered: %+v", incoming)
	}
	if !incoming.HistoryInsufficient || incoming.Evidence.OpenPurchaseOrders != 1 {
		t.Fatalf("unexpected incoming evidence: %+v", incoming)
	}

	if after := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID); after != beforePOs {
		t.Fatalf("planner created a purchase order: before=%d after=%d", beforePOs, after)
	}
	if after := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid`, fx.orgID); after != beforeMovements {
		t.Fatalf("planner wrote stock movements: before=%d after=%d", beforeMovements, after)
	}
	if after := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid`, fx.orgID); after != beforeReservations {
		t.Fatalf("planner wrote stock reservations: before=%d after=%d", beforeReservations, after)
	}
	// The executor still writes its audit ledger entry and action receipt for
	// the intent. The assertion above is deliberately scoped to domain tables.

	foreignInput := json.RawMessage(`{"sku":"OTHER-1"}`)
	foreignClaims := fx.humanClaims(foreignInput, "replenishment-foreign-"+executorUUID(t))
	foreignClaims.CapabilityID = inventoryReplenishmentPlanCapabilityID
	foreignClaims.Permissions = []string{"inventory.read"}
	foreignResult, err := fx.executor.Execute(fx.ctx, foreignClaims, inventoryReplenishmentPlanCapabilityID, foreignInput)
	if err != nil {
		t.Fatal(err)
	}
	if !foreignResult.OK {
		t.Fatalf("foreign sku probe refused: %s", foreignResult.Error)
	}
	var foreignOutput InventoryReplenishmentPlanOutput
	if err := json.Unmarshal(foreignResult.Data, &foreignOutput); err != nil {
		t.Fatal(err)
	}
	if len(foreignOutput.Items) != 0 || foreignOutput.Summary.Evaluated != 0 {
		t.Fatalf("foreign sku returned tenant data: %+v", foreignOutput)
	}

	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM role_permissions WHERE role_id=$1::uuid AND permission_key='inventory.read'`, fx.roleID); err != nil {
		t.Fatal(err)
	}
	denied, err := fx.executor.Execute(fx.ctx, claims, inventoryReplenishmentPlanCapabilityID, input)
	if err != nil {
		t.Fatal(err)
	}
	if denied.OK {
		t.Fatal("planner executed without inventory.read")
	}
}

func seedReplenishmentItem(t *testing.T, fx *executorFixture, orgID, sku, name string, reorderPoint int64) string {
	t.Helper()
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind, reorder_point_thousandths)
		VALUES ($1::uuid, $2, $3, 'goods', $4)
		RETURNING id::text`, orgID, sku, name, reorderPoint).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func seedReplenishmentMovement(t *testing.T, fx *executorFixture, orgID, itemID string, delta int64, reason string, unitCost *int64, at time.Time) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, unit_cost_minor, actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'human', $6)`, orgID, itemID, delta, reason, unitCost, at); err != nil {
		t.Fatal(err)
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}

func TestInventoryReplenishmentPlanIncomingUsesPurchasingOutstandingFormula(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'inventory.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	itemID := seedReplenishmentItem(t, fx, fx.orgID, "RECEIPT-1", "Partial receipt item", 10_000)

	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Partial receipt supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	var poID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status)
		VALUES ($1::uuid, $2::uuid, 1, 'partial')
		RETURNING id::text`, fx.orgID, vendorID).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	var poLineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, item_id, position)
		VALUES ($1::uuid, 'Partial receipt line', 10000, 500, $2::uuid, 1)
		RETURNING id::text`, poID, itemID).Scan(&poLineID); err != nil {
		t.Fatal(err)
	}
	var receiptID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO goods_receipts (org_id, po_id, number, received_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 1, 'human')
		RETURNING id::text`, fx.orgID, poID).Scan(&receiptID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, returned_thousandths)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 4000, 1000, 500)`, fx.orgID, receiptID, poLineID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"sku":"RECEIPT-1","lookbackDays":30,"leadTimeDays":14,"reviewDays":7}`)
	claims := fx.humanClaims(input, "replenishment-receipt-"+executorUUID(t))
	claims.CapabilityID = inventoryReplenishmentPlanCapabilityID
	claims.Permissions = []string{"inventory.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, inventoryReplenishmentPlanCapabilityID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("planner refused: %s", result.Error)
	}
	var output InventoryReplenishmentPlanOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Items) != 1 {
		t.Fatalf("items=%d, want 1", len(output.Items))
	}
	item := output.Items[0]
	// 10000 ordered - (4000 accepted - 500 returned + 1000 rejected) = 5500.
	if item.IncomingThousandths != 5_500 {
		t.Fatalf("incoming=%d, want 5500", item.IncomingThousandths)
	}
	if item.TargetStockThousandths != 10_000 || item.SuggestedOrderQtyThousandths != 4_500 {
		t.Fatalf("target=%d suggested=%d, want 10000 and 4500", item.TargetStockThousandths, item.SuggestedOrderQtyThousandths)
	}
}
