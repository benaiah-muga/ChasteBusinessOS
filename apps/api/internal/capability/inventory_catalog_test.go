package capability

import (
	"encoding/json"
	"testing"
)

func TestInventoryListItemMetadataParsesAndMarshals(t *testing.T) {
	parsed, err := ParseInventoryListItemMetadataInput(json.RawMessage(`{"ignored":true}`))
	if err != nil {
		t.Fatal(err)
	}
	input, err := marshalJS(parsed)
	if err != nil || string(input) != `{}` {
		t.Fatalf("parsed input=%s err=%v, want empty object", input, err)
	}
	barcode := "4006381333931"
	output := InventoryListItemMetadataOutput{Items: []InventoryItemMetadataRow{
		{ID: "11111111-1111-4111-8111-111111111111", SKU: "CAT-A", Kind: "goods", UnitLabel: "box", SalePriceMinor: 12500, Barcode: &barcode},
		{ID: "22222222-2222-4222-8222-222222222222", SKU: "CAT-B", Kind: "service", UnitLabel: "hour", SalePriceMinor: 0},
	}}
	encoded, err := marshalJS(output)
	want := `{"items":[{"id":"11111111-1111-4111-8111-111111111111","sku":"CAT-A","kind":"goods","unitLabel":"box","salePriceMinor":12500,"barcode":"4006381333931"},{"id":"22222222-2222-4222-8222-222222222222","sku":"CAT-B","kind":"service","unitLabel":"hour","salePriceMinor":0,"barcode":null}]}`
	if err != nil || string(encoded) != want {
		t.Fatalf("metadata output=%s err=%v, want %s", encoded, err, want)
	}
}

func TestInventoryListItemMetadataExecutionIsOrganizationScoped(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'inventory.read', $2::uuid) ON CONFLICT DO NOTHING`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	localA := seedSalesItem(t, fx, fx.orgID, "CATALOG-A", "goods")
	localB := seedSalesItem(t, fx, fx.orgID, "CATALOG-B", "service")
	foreign := seedSalesItem(t, fx, fx.otherOrgID, "CATALOG-A", "service")
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE items SET unit_label='box', sale_price_minor=12500, barcode='4006381333931' WHERE id=$1::uuid`, localA); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE items SET unit_label='hour', sale_price_minor=0, barcode=NULL WHERE id=$1::uuid`, localB); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE items SET unit_label='foreign', sale_price_minor=98765, barcode='4006381333931' WHERE id=$1::uuid`, foreign); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	claims := fx.humanClaims(input, "")
	claims.CapabilityID = inventoryListItemMetadataCapabilityID
	claims.Permissions = []string{"inventory.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, inventoryListItemMetadataCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("list item metadata result=%+v err=%v", result, err)
	}
	var output InventoryListItemMetadataOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode item metadata %s: %v", result.Data, err)
	}
	if len(output.Items) != 2 {
		t.Fatalf("item metadata rows=%+v, want only two local items", output.Items)
	}
	first := output.Items[0]
	if first.ID != localA || first.SKU != "CATALOG-A" || first.Kind != "goods" || first.UnitLabel != "box" || first.SalePriceMinor != 12500 || first.Barcode == nil || *first.Barcode != "4006381333931" {
		t.Fatalf("first local item metadata=%+v", first)
	}
	second := output.Items[1]
	if second.ID != localB || second.SKU != "CATALOG-B" || second.Kind != "service" || second.UnitLabel != "hour" || second.SalePriceMinor != 0 || second.Barcode != nil {
		t.Fatalf("second local item metadata=%+v", second)
	}
	for _, item := range output.Items {
		if got := fx.count(`SELECT count(*) FROM items WHERE id=$1::uuid AND org_id=$2::uuid`, item.ID, fx.orgID); got != 1 {
			t.Fatalf("returned item %s is not owned by the active organization", item.ID)
		}
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed'`, fx.orgID, inventoryListItemMetadataCapabilityID); got != 1 {
		t.Fatalf("catalog read audit rows=%d, want one", got)
	}
}
