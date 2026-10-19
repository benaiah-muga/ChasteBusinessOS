package capability

import (
	"encoding/json"
	"testing"
)

func TestPurchasingGetPurchaseOrderInputContract(t *testing.T) {
	input, err := ParsePurchasingGetPurchaseOrderInput(json.RawMessage(`{"poNumber":7}`))
	if err != nil || input.PONumber != 7 {
		t.Fatalf("input=%+v err=%v", input, err)
	}
	for name, raw := range map[string]string{
		"missing number": `{}`,
		"zero":           `{"poNumber":0}`,
		"negative":       `{"poNumber":-1}`,
		"fractional":     `{"poNumber":1.5}`,
		"unknown field":  `{"poNumber":1,"vendorId":"x"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParsePurchasingGetPurchaseOrderInput(json.RawMessage(raw)); err == nil {
				t.Fatalf("expected %s to be rejected", raw)
			}
		})
	}
}

func TestPurchasingGetPurchaseOrderReadsReceiptsAndRemaining(t *testing.T) {
	fx := newExecutorFixture(t)
	for _, permission := range []string{"purchasing.read", "purchasing.write"} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO role_permissions (role_id, permission_key, org_id)
			VALUES ($1::uuid, $2, $3::uuid)`, fx.roleID, permission, fx.orgID); err != nil {
			t.Fatal(err)
		}
	}
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Order read supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind)
		VALUES ($1::uuid, 'ORDER-READ-1', 'Order read item', 'goods')
		RETURNING id::text`, fx.orgID).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	var poID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo, ordered_at)
		VALUES ($1::uuid, $2::uuid, 1, 'partial', 'Accepted then remaining', now())
		RETURNING id::text`, fx.orgID, vendorID).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	var lineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position, item_id)
		VALUES ($1::uuid, 'Cement bag', 5000, 2000, 1, $2::uuid)
		RETURNING id::text`, poID, itemID).Scan(&lineID); err != nil {
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
		VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 3000, 0, 200)`, fx.orgID, receiptID, lineID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"poNumber":1}`)
	claims := fx.humanClaims(input, "get-purchase-order-"+executorUUID(t))
	claims.CapabilityID = purchasingGetPurchaseOrderCapabilityID
	claims.Permissions = []string{"purchasing.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, purchasingGetPurchaseOrderCapabilityID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("getPurchaseOrder refused: %s", result.Error)
	}
	var output PurchasingPurchaseOrderOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.PONumber != 1 || output.VendorName != "Order read supplier" || output.Status != "partial" || output.TotalMinor != 10000 {
		t.Fatalf("unexpected order header: %+v", output)
	}
	if len(output.Lines) != 1 || len(output.Receipts) != 1 {
		t.Fatalf("lines=%d receipts=%d, want one of each", len(output.Lines), len(output.Receipts))
	}
	line := output.Lines[0]
	if line.Quantity != 5000 || line.UnitPriceMinor != 2000 || line.LineTotalMinor != 10000 || line.AcceptedThousandths != 3000 || line.ReturnedThousandths != 200 || line.RemainingThousandths != 2200 {
		t.Fatalf("unexpected order line: %+v", line)
	}
	if output.FullyReceived || output.Backordered {
		t.Fatalf("fullyReceived=%t backordered=%t, want an open remainder", output.FullyReceived, output.Backordered)
	}

	otherRoleID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)
		ON CONFLICT DO NOTHING`, fx.otherOrgID, fx.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO roles (id, org_id, key, name, is_system)
		VALUES ($1::uuid, $2::uuid, 'fixture_reader', 'Fixture reader', true)`, otherRoleID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'purchasing.read', $2::uuid)`, otherRoleID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO user_roles (user_id, role_id, org_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)`, fx.userID, otherRoleID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	otherOrgInput := json.RawMessage(`{"poNumber":1}`)
	otherClaims := fx.humanClaims(otherOrgInput, "get-foreign-purchase-order-"+executorUUID(t))
	otherClaims.OrganizationID = fx.otherOrgID
	otherClaims.CapabilityID = purchasingGetPurchaseOrderCapabilityID
	otherClaims.Permissions = []string{"purchasing.read"}
	foreignResult, err := fx.executor.Execute(fx.ctx, otherClaims, purchasingGetPurchaseOrderCapabilityID, otherOrgInput)
	if err != nil {
		if err.Error() != "purchase order not found" {
			t.Fatalf("foreign order error=%v, want purchase order not found", err)
		}
	} else if foreignResult.OK || foreignResult.Error != "purchase order not found" {
		t.Fatalf("foreign order result=%+v, want purchase order not found", foreignResult)
	}
}

func TestPurchasingGetPurchaseOrderUsesServiceAcceptance(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'purchasing.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Service supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	var poID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status)
		VALUES ($1::uuid, $2::uuid, 2, 'partial')
		RETURNING id::text`, fx.orgID, vendorID).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position, service_accepted_thousandths)
		VALUES ($1::uuid, 'Setup service', 5000, 1000, 1, 2500)`, poID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"poNumber":2}`)
	claims := fx.humanClaims(input, "get-service-order-"+executorUUID(t))
	claims.CapabilityID = purchasingGetPurchaseOrderCapabilityID
	claims.Permissions = []string{"purchasing.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, purchasingGetPurchaseOrderCapabilityID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("getPurchaseOrder refused: %s", result.Error)
	}
	var output PurchasingPurchaseOrderOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Lines) != 1 || output.Lines[0].AcceptedThousandths != 2500 || output.Lines[0].RemainingThousandths != 2500 || output.FullyReceived {
		t.Fatalf("service order=%+v, want 2500 accepted and 2500 remaining", output)
	}
}
