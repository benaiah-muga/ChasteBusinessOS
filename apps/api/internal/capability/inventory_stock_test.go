package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestInventoryStockParsersMirrorZodContracts(t *testing.T) {
	uuid := "11111111-1111-4111-8111-111111111111"
	cases := []struct {
		name     string
		parse    func(json.RawMessage) (any, error)
		raw      string
		wantJSON string
		output   any
		outputJS string
	}{
		{
			name:     "adjustStock",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryAdjustStockInput(raw) },
			raw:      `{"sku":"INV-CHAIR","quantityDelta":-5000,"note":"count fix","lotCode":"LOT-9","locationCode":"WH-A","unknown":1}`,
			wantJSON: `{"sku":"INV-CHAIR","quantityDelta":-5000,"note":"count fix","lotCode":"LOT-9","locationCode":"WH-A"}`,
			output:   InventoryAdjustStockOutput{OnHandThousandths: 17000},
			outputJS: `{"onHandThousandths":17000}`,
		},
		{
			name:     "adjustStockMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryAdjustStockInput(raw) },
			raw:      `{"sku":"","quantityDelta":1000,"note":"abc"}`,
			wantJSON: `{"sku":"","quantityDelta":1000,"note":"abc"}`,
		},
		{
			name:     "createTransfer",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryCreateTransferInput(raw) },
			raw:      `{"fromLocationCode":"WH-A","toLocationCode":"WH-B","lines":[{"sku":"TRF-CHAIR","quantityThousandths":1000,"lotCode":"LOT-A"},{"sku":"TRF-DESK","quantityThousandths":2000}],"note":"rebalance","unknown":2}`,
			wantJSON: `{"fromLocationCode":"WH-A","toLocationCode":"WH-B","lines":[{"sku":"TRF-CHAIR","quantityThousandths":1000,"lotCode":"LOT-A"},{"sku":"TRF-DESK","quantityThousandths":2000}],"note":"rebalance"}`,
			output:   InventoryCreateTransferOutput{TransferID: uuid, Number: 3, Status: "pending"},
			outputJS: `{"transferId":"` + uuid + `","number":3,"status":"pending"}`,
		},
		{
			name:     "createTransferMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryCreateTransferInput(raw) },
			raw:      `{"fromLocationCode":"WH-A","toLocationCode":"WH-B","lines":[{"sku":"TRF-CHAIR","quantityThousandths":1000}]}`,
			wantJSON: `{"fromLocationCode":"WH-A","toLocationCode":"WH-B","lines":[{"sku":"TRF-CHAIR","quantityThousandths":1000}]}`,
		},
		{
			name:     "confirmTransfer",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryConfirmTransferInput(raw) },
			raw:      `{"transferId":"` + uuid + `","lines":[{"lineId":"22222222-2222-4222-8222-222222222222","quantityThousandths":18000}],"unknown":3}`,
			wantJSON: `{"transferId":"` + uuid + `","lines":[{"lineId":"22222222-2222-4222-8222-222222222222","quantityThousandths":18000}]}`,
			output:   InventoryConfirmTransferOutput{TransferID: uuid, Status: "partial", ConfirmedNowThousandths: 18000},
			outputJS: `{"transferId":"` + uuid + `","status":"partial","confirmedNowThousandths":18000}`,
		},
		{
			name:     "confirmTransferMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryConfirmTransferInput(raw) },
			raw:      `{"transferId":"` + uuid + `"}`,
			wantJSON: `{"transferId":"` + uuid + `"}`,
		},
		{
			name:     "cancelTransfer",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryCancelTransferInput(raw) },
			raw:      `{"transferId":"` + uuid + `"}`,
			wantJSON: `{"transferId":"` + uuid + `"}`,
			output:   InventoryCancelTransferOutput{Cancelled: true},
			outputJS: `{"cancelled":true}`,
		},
		{
			name:     "reverseTransfer",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryReverseTransferInput(raw) },
			raw:      `{"transferId":"` + uuid + `","unknown":1}`,
			wantJSON: `{"transferId":"` + uuid + `"}`,
			output:   InventoryReverseTransferOutput{Reversed: true, ReversalTransferID: uuid},
			outputJS: `{"reversed":true,"reversalTransferId":"` + uuid + `"}`,
		},
		{
			name:     "listTransfers",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListTransfersInput(raw) },
			raw:      `{"openOnly":true,"unknown":4}`,
			wantJSON: `{"openOnly":true}`,
			output: InventoryListTransfersOutput{Transfers: []InventoryListTransferItem{{
				ID: uuid, Number: 7, Status: "pending", Note: nil, CreatedAt: "2026-09-27T10:00:00.000Z",
			}}},
			outputJS: `{"transfers":[{"id":"` + uuid + `","number":7,"status":"pending","note":null,"createdAt":"2026-09-27T10:00:00.000Z"}]}`,
		},
		{
			name:     "listTransfersMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListTransfersInput(raw) },
			raw:      `{}`,
			wantJSON: `{}`,
			output:   InventoryListTransfersOutput{Transfers: []InventoryListTransferItem{}},
			outputJS: `{"transfers":[]}`,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := test.parse(json.RawMessage(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			got, err := marshalJS(parsed)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.wantJSON {
				t.Fatalf("parsed input = %s, want %s", got, test.wantJSON)
			}
			if test.output != nil {
				encoded, err := marshalJS(test.output)
				if err != nil {
					t.Fatal(err)
				}
				if string(encoded) != test.outputJS {
					t.Fatalf("output = %s, want %s", encoded, test.outputJS)
				}
			}
		})
	}

	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"sku":"S"}`,
		`{"sku":"S","quantityDelta":null,"note":"abc"}`,
		`{"sku":"S","quantityDelta":0,"note":"abc"}`,
		`{"sku":"S","quantityDelta":1.5,"note":"abc"}`,
		`{"sku":"S","quantityDelta":"5","note":"abc"}`,
		`{"sku":"S","quantityDelta":5}`,
		`{"sku":"S","quantityDelta":5,"note":null}`,
		`{"sku":"S","quantityDelta":5,"note":"ab"}`,
		`{"sku":"S","quantityDelta":5,"note":7}`,
		`{"sku":"S","quantityDelta":5,"note":"abc","lotCode":null}`,
		`{"sku":"S","quantityDelta":5,"note":"abc","lotCode":""}`,
		`{"sku":"S","quantityDelta":5,"note":"abc","lotCode":"12345678901234567890123456789012345678901"}`,
		`{"sku":"S","quantityDelta":5,"note":"abc","locationCode":null}`,
		`{"sku":"S","quantityDelta":5,"note":"abc","locationCode":""}`,
		`{"sku":"S","quantityDelta":5,"note":"abc","locationCode":"123456789012345678901"}`,
	} {
		if _, err := ParseInventoryAdjustStockInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryAdjustStockInput accepted %s", raw)
		}
	}
	tooManyLines := make([]string, 51)
	for i := range tooManyLines {
		tooManyLines[i] = `{"sku":"S","quantityThousandths":1}`
	}
	tooManyLinesRaw := `{"fromLocationCode":"A","toLocationCode":"B","lines":[` + strings.Join(tooManyLines, ",") + `]}`
	for _, raw := range append([]string{
		`[]`,
		`{}`,
		`{"fromLocationCode":null,"toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1}]}`,
		`{"fromLocationCode":"","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1}]}`,
		`{"fromLocationCode":"123456789012345678901","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1}]}`,
		`{"fromLocationCode":"A","lines":[{"sku":"S","quantityThousandths":1}]}`,
		`{"fromLocationCode":"A","toLocationCode":null,"lines":[{"sku":"S","quantityThousandths":1}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B"}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":null}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":"all"}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[null]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"quantityThousandths":1}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"","quantityThousandths":1}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":null,"quantityThousandths":1}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S"}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":0}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":-5}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1.5}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1,"lotCode":""}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1,"lotCode":null}]}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1}],"note":null}`,
		`{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1}],"note":"123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901"}`,
		tooManyLinesRaw,
	}, tooManyLinesRaw) {
		if _, err := ParseInventoryCreateTransferInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryCreateTransferInput accepted %.80s", raw)
		}
	}
	lineID := "33333333-3333-4333-8333-333333333333"
	for _, raw := range []string{
		`{}`,
		`{"transferId":null}`,
		`{"transferId":"nope"}`,
		`{"transferId":"` + uuid + `","lines":null}`,
		`{"transferId":"` + uuid + `","lines":"all"}`,
		`{"transferId":"` + uuid + `","lines":[null]}`,
		`{"transferId":"` + uuid + `","lines":[{"quantityThousandths":1000}]}`,
		`{"transferId":"` + uuid + `","lines":[{"lineId":"nope","quantityThousandths":1000}]}`,
		`{"transferId":"` + uuid + `","lines":[{"lineId":"` + lineID + `"}]}`,
		`{"transferId":"` + uuid + `","lines":[{"lineId":"` + lineID + `","quantityThousandths":0}]}`,
		`{"transferId":"` + uuid + `","lines":[{"lineId":"` + lineID + `","quantityThousandths":-5}]}`,
		`{"transferId":"` + uuid + `","lines":[{"lineId":"` + lineID + `","quantityThousandths":1.5}]}`,
	} {
		if _, err := ParseInventoryConfirmTransferInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryConfirmTransferInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"transferId":null}`,
		`{"transferId":"nope"}`,
	} {
		if _, err := ParseInventoryCancelTransferInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryCancelTransferInput accepted %s", raw)
		}
		if _, err := ParseInventoryReverseTransferInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryReverseTransferInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{"openOnly":"yes"}`,
		`{"openOnly":null}`,
		`{"openOnly":1}`,
	} {
		if _, err := ParseInventoryListTransfersInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryListTransfersInput accepted %s", raw)
		}
	}

	minimals := map[string]string{
		inventoryAdjustStockCapabilityID:     `{"sku":"S","quantityDelta":5,"note":"abc"}`,
		inventoryCreateTransferCapabilityID:  `{"fromLocationCode":"A","toLocationCode":"B","lines":[{"sku":"S","quantityThousandths":1}]}`,
		inventoryConfirmTransferCapabilityID: `{"transferId":"` + uuid + `"}`,
		inventoryReverseTransferCapabilityID: `{"transferId":"` + uuid + `"}`,
		inventoryCancelTransferCapabilityID:  `{"transferId":"` + uuid + `"}`,
		inventoryListTransfersCapabilityID:   `{}`,
	}
	for capabilityID, raw := range minimals {
		if _, err := parseInventoryStockInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseInventoryStockInput(%s) error = %v", capabilityID, err)
		}
	}
	if _, err := parseInventoryStockInput("inventory.unknown", json.RawMessage(`{}`)); err == nil {
		t.Error("parseInventoryStockInput accepted an unsupported capability")
	}
}

func inventoryTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func inventoryInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, action func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, action)
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func inventoryErrInOrgTx(t *testing.T, fx *executorFixture, orgID string, action func(tx pgx.Tx) error) error {
	t.Helper()
	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, action(tx)
	})
	return err
}

func seedInventoryItemID(t *testing.T, fx *executorFixture, orgID, sku string) string {
	t.Helper()
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM items WHERE org_id=$1::uuid AND sku=$2`, orgID, sku).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func seedInventoryStockLocation(t *testing.T, fx *executorFixture, orgID, code, name string) string {
	t.Helper()
	var locationID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO stock_locations (org_id, code, name) VALUES ($1::uuid, $2, $3)
		RETURNING id::text`, orgID, code, name).Scan(&locationID); err != nil {
		t.Fatal(err)
	}
	return locationID
}

func seedInventoryStockAt(t *testing.T, fx *executorFixture, orgID, itemID, locationID string, quantityThousandths int64) {
	t.Helper()
	var locationArg any
	if locationID != "" {
		locationArg = locationID
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, location_id, actor_type)
		VALUES ($1::uuid, $2::uuid, $3, 'adjustment', 'opening count', $4::uuid, 'system')`,
		orgID, itemID, quantityThousandths, locationArg); err != nil {
		t.Fatal(err)
	}
}

func seedInventoryTransferRow(t *testing.T, fx *executorFixture, orgID string, number int64, fromLocationID, toLocationID, status string, createdAt time.Time) string {
	t.Helper()
	var transferID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO stock_transfers (org_id, number, from_location_id, to_location_id, status, created_at)
		VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6)
		RETURNING id::text`, orgID, number, fromLocationID, toLocationID, status, createdAt).Scan(&transferID); err != nil {
		t.Fatal(err)
	}
	return transferID
}

func seedInventoryTransferLine(t *testing.T, fx *executorFixture, orgID, transferID, itemID string, quantity, confirmed int64, lotID *string) string {
	t.Helper()
	var lineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO stock_transfer_lines (org_id, transfer_id, item_id, quantity_thousandths, confirmed_thousandths, lot_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)
		RETURNING id::text`, orgID, transferID, itemID, quantity, confirmed, lotID).Scan(&lineID); err != nil {
		t.Fatal(err)
	}
	return lineID
}

func TestInventoryStockAdjustAppendsLedgerAndGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "INV-CHAIR", "goods")
	seedSalesItem(t, fx, fx.orgID, "INV-INSTALL", "service")
	locationID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-A", "Main warehouse")
	seedInventoryStockLocation(t, fx, fx.otherOrgID, "WH-X", "Foreign only warehouse")

	created := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryAdjustStockOutput, error) {
		return inventoryAdjustStock(fx.ctx, tx, claims, InventoryAdjustStockInput{
			SKU: "INV-CHAIR", QuantityDelta: 20000, Note: "opening count fix",
			LotCode: crmStringPointer("LOT-9"), LocationCode: crmStringPointer("WH-A"),
		})
	})
	if created.OnHandThousandths != 20000 {
		t.Fatalf("adjust output = %+v, want 20000 on hand", created)
	}
	encoded, err := marshalJS(created)
	if err != nil || string(encoded) != `{"onHandThousandths":20000}` {
		t.Fatalf("adjust output JSON = %s, %v", encoded, err)
	}
	var movement struct {
		Delta     int64
		Reason    string
		Note      string
		RefType   *string
		RefID     *string
		UnitCost  *int64
		Location  *string
		Lot       *string
		ActorType string
		ActorID   *string
	}
	var movementID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, quantity_delta, reason, note, ref_type, ref_id::text, unit_cost_minor, location_id::text, lot_id::text, actor_type, actor_id::text
		FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid AND reason='adjustment' AND note='opening count fix'`,
		fx.orgID, itemID).
		Scan(&movementID, &movement.Delta, &movement.Reason, &movement.Note, &movement.RefType, &movement.RefID,
			&movement.UnitCost, &movement.Location, &movement.Lot, &movement.ActorType, &movement.ActorID); err != nil {
		t.Fatal(err)
	}
	if movement.Delta != 20000 || movement.Reason != "adjustment" ||
		movement.RefType != nil || movement.RefID != nil || movement.UnitCost != nil ||
		movement.Location == nil || *movement.Location != locationID ||
		movement.Lot == nil || movement.ActorType != "human" || movement.ActorID == nil || *movement.ActorID != fx.userID {
		t.Fatalf("stock movement = %+v, want attributed adjustment leg bound to the location and lot", movement)
	}
	var lotID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM lots WHERE org_id=$1::uuid AND item_id=$2::uuid AND lot_code='LOT-9'`,
		fx.orgID, itemID).Scan(&lotID); err != nil {
		t.Fatal(err)
	}
	if movement.Lot == nil || *movement.Lot != lotID {
		t.Fatalf("movement lot = %v, want the created lot %s", movement.Lot, lotID)
	}
	var balance int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid AND location_id=$3::uuid`,
		fx.orgID, itemID, locationID).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if balance != 20000 {
		t.Fatalf("projected balance = %d, want 20000", balance)
	}

	again := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryAdjustStockOutput, error) {
		return inventoryAdjustStock(fx.ctx, tx, claims, InventoryAdjustStockInput{
			SKU: "INV-CHAIR", QuantityDelta: 5000, Note: "found a pallet", LotCode: crmStringPointer("LOT-9"),
		})
	})
	if again.OnHandThousandths != 25000 {
		t.Fatalf("second adjust = %+v, want 25000 on hand reusing the lot", again)
	}
	var lotCount int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM lots WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID).Scan(&lotCount); err != nil {
		t.Fatal(err)
	}
	if lotCount != 1 {
		t.Fatalf("lot rows = %d, want the single reused lot", lotCount)
	}

	outward := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryAdjustStockOutput, error) {
		return inventoryAdjustStock(fx.ctx, tx, claims, InventoryAdjustStockInput{
			SKU: "INV-CHAIR", QuantityDelta: -8000, Note: "breakage write-off", LocationCode: crmStringPointer("WH-A"),
		})
	})
	if outward.OnHandThousandths != 17000 {
		t.Fatalf("outward adjust = %+v, want 17000 on hand", outward)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid AND location_id=$3::uuid`,
		fx.orgID, itemID, locationID).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if balance != 12000 {
		t.Fatalf("location balance after outward = %d, want 12000", balance)
	}
	var orgWide int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid`,
		fx.orgID, itemID).Scan(&orgWide); err != nil {
		t.Fatal(err)
	}
	if orgWide != 17000 {
		t.Fatalf("org-wide balance after outward = %d, want 17000", orgWide)
	}

	cases := []struct {
		name  string
		input InventoryAdjustStockInput
		want  string
	}{
		{
			name:  "location overdraw",
			input: InventoryAdjustStockInput{SKU: "INV-CHAIR", QuantityDelta: -13000, Note: "too much at once", LocationCode: crmStringPointer("WH-A")},
			want:  "cannot move 13000 thousandths from this location: only 12000 on hand there",
		},
		{
			name:  "org overdraw",
			input: InventoryAdjustStockInput{SKU: "INV-CHAIR", QuantityDelta: -999999, Note: "way too much"},
			want:  "cannot move 999999 thousandths of stock that is not there: only 17000 on hand for this item",
		},
		{
			name:  "service item",
			input: InventoryAdjustStockInput{SKU: "INV-INSTALL", QuantityDelta: 1000, Note: "nothing to stock"},
			want:  `"INV-INSTALL name" is a service; there is nothing to stock`,
		},
		{
			name:  "unknown sku",
			input: InventoryAdjustStockInput{SKU: "NOPE", QuantityDelta: 1000, Note: "no such thing"},
			want:  "no item with SKU NOPE",
		},
		{
			name:  "foreign location",
			input: InventoryAdjustStockInput{SKU: "INV-CHAIR", QuantityDelta: 1000, Note: "other org bin", LocationCode: crmStringPointer("WH-X")},
			want:  "no location with code WH-X",
		},
		{
			name:  "lot on outward",
			input: InventoryAdjustStockInput{SKU: "INV-CHAIR", QuantityDelta: -1, Note: "lot belongs inward", LotCode: crmStringPointer("LOT-9")},
			want:  "lotCode applies only to inward corrections",
		},
	}
	for _, test := range cases {
		err := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
			_, err := inventoryAdjustStock(fx.ctx, tx, claims, test.input)
			return err
		})
		if err == nil || err.Error() != test.want {
			t.Fatalf("%s error = %v, want %q", test.name, err, test.want)
		}
	}

	// Migration 0049 makes the ledger append-only: even the fixture owner
	// cannot rewrite a movement without the maintenance context.
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE stock_movements SET quantity_delta = 1 WHERE id = $1::uuid`, movementID); err == nil {
		t.Fatal("updated an immutable stock movement, want refusal")
	} else if !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("ledger mutation error = %v, want the immutability refusal", err)
	}
	var unchanged int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT quantity_delta FROM stock_movements WHERE id = $1::uuid`, movementID).Scan(&unchanged); err != nil {
		t.Fatal(err)
	}
	if unchanged != 20000 {
		t.Fatalf("movement delta after refused update = %d, want 20000", unchanged)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID); got != 3 {
		t.Fatalf("movements after refused adjustments = %d, want the three committed legs", got)
	}
}

func TestInventoryStockTransferLifecycleConfirmsThroughLedger(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "TRF-CHAIR", "goods")
	fromID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-A", "Source warehouse")
	toID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-B", "Destination warehouse")
	seedInventoryStockAt(t, fx, fx.orgID, itemID, fromID, 100000)
	now := time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)
	later := now.Add(time.Hour)

	created := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 30000, LotCode: crmStringPointer("LOT-A")}},
			Note:  crmStringPointer("rebalance before the promo"),
		})
	})
	if !isUUID(created.TransferID) || created.Number != 1 || created.Status != "pending" {
		t.Fatalf("createTransfer output = %+v, want pending transfer number 1", created)
	}
	encoded, err := marshalJS(created)
	if err != nil || string(encoded) != fmt.Sprintf(`{"transferId":%q,"number":1,"status":"pending"}`, created.TransferID) {
		t.Fatalf("createTransfer output JSON = %s, %v", encoded, err)
	}
	var transfer struct {
		OrgID     string
		Status    string
		Note      string
		ActorType string
		ActorID   *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, status, note, created_by_actor_type, created_by_actor_id::text
		FROM stock_transfers WHERE id=$1::uuid`, created.TransferID).
		Scan(&transfer.OrgID, &transfer.Status, &transfer.Note, &transfer.ActorType, &transfer.ActorID); err != nil {
		t.Fatal(err)
	}
	if transfer.OrgID != fx.orgID || transfer.Status != "pending" || transfer.Note != "rebalance before the promo" ||
		transfer.ActorType != "human" || transfer.ActorID == nil || *transfer.ActorID != fx.userID {
		t.Fatalf("stored transfer = %+v, want org-scoped pending draft attributed to the actor", transfer)
	}
	var lotID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM lots WHERE org_id=$1::uuid AND item_id=$2::uuid AND lot_code='LOT-A'`, fx.orgID, itemID).Scan(&lotID); err != nil {
		t.Fatal(err)
	}
	var lineID string
	var lineQuantity, lineConfirmed int64
	var lineLot *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, quantity_thousandths, confirmed_thousandths, lot_id::text
		FROM stock_transfer_lines WHERE transfer_id=$1::uuid`, created.TransferID).
		Scan(&lineID, &lineQuantity, &lineConfirmed, &lineLot); err != nil {
		t.Fatal(err)
	}
	if lineQuantity != 30000 || lineConfirmed != 0 || lineLot == nil || *lineLot != lotID {
		t.Fatalf("stored transfer line = (%s,%d,%d,%v), want 30000 unconfirmed on LOT-A", lineID, lineQuantity, lineConfirmed, lineLot)
	}

	partial := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryConfirmTransferOutput, error) {
		lines := []InventoryConfirmTransferLineInput{{LineID: lineID, QuantityThousandths: 18000}}
		return inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: created.TransferID, Lines: &lines}, now)
	})
	if partial.Status != "partial" || partial.ConfirmedNowThousandths != 18000 || partial.TransferID != created.TransferID {
		t.Fatalf("partial confirm = %+v, want 18000 confirmed now at partial", partial)
	}
	assertTransferBalances(t, fx, itemID, map[string]int64{fromID: 82000, toID: 18000})
	var confirmed int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT confirmed_thousandths FROM stock_transfer_lines WHERE id=$1::uuid`, lineID).Scan(&confirmed); err != nil {
		t.Fatal(err)
	}
	if confirmed != 18000 {
		t.Fatalf("line confirmed = %d, want 18000", confirmed)
	}
	var legCount int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*) FROM stock_movements
		WHERE org_id=$1::uuid AND item_id=$2::uuid AND reason='transfer' AND ref_type='stock_transfer' AND ref_id=$3::uuid`,
		fx.orgID, itemID, created.TransferID).Scan(&legCount); err != nil {
		t.Fatal(err)
	}
	if legCount != 2 {
		t.Fatalf("transfer legs = %d, want the paired out/in legs", legCount)
	}
	var outDelta, inDelta int64
	var outLocation, inLocation string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity_delta, location_id::text FROM stock_movements
		WHERE org_id=$1::uuid AND ref_id=$2::uuid AND reason='transfer' AND quantity_delta < 0`,
		fx.orgID, created.TransferID).Scan(&outDelta, &outLocation); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity_delta, location_id::text FROM stock_movements
		WHERE org_id=$1::uuid AND ref_id=$2::uuid AND reason='transfer' AND quantity_delta > 0`,
		fx.orgID, created.TransferID).Scan(&inDelta, &inLocation); err != nil {
		t.Fatal(err)
	}
	if outDelta != -18000 || outLocation != fromID || inDelta != 18000 || inLocation != toID {
		t.Fatalf("legs = (%d at %s, %d at %s), want -18000 at source and 18000 at destination", outDelta, outLocation, inDelta, inLocation)
	}
	var partialStatus string
	var confirmedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, confirmed_at FROM stock_transfers WHERE id=$1::uuid`, created.TransferID).Scan(&partialStatus, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	if partialStatus != "partial" || confirmedAt != nil {
		t.Fatalf("partial transfer state = %s/%v, want partial with null confirmedAt", partialStatus, confirmedAt)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCancelTransfer(fx.ctx, tx, fx.orgID, InventoryCancelTransferInput{TransferID: created.TransferID}, now)
		return err
	})
	if err == nil || err.Error() != "transfer is partial; only untouched drafts can be cancelled - reverse it instead" {
		t.Fatalf("partial cancel error = %v, want status guard", err)
	}

	full := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryConfirmTransferOutput, error) {
		return inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: created.TransferID}, later)
	})
	if full.Status != "confirmed" || full.ConfirmedNowThousandths != 12000 {
		t.Fatalf("full confirm = %+v, want the remaining 12000 confirmed", full)
	}
	assertTransferBalances(t, fx, itemID, map[string]int64{fromID: 70000, toID: 30000})
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, confirmed_at FROM stock_transfers WHERE id=$1::uuid`, created.TransferID).Scan(&partialStatus, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	if partialStatus != "confirmed" || confirmedAt == nil || !confirmedAt.Equal(later) {
		t.Fatalf("confirmed transfer state = %s/%v, want confirmed at the passed now", partialStatus, confirmedAt)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: created.TransferID}, later)
		return err
	})
	if err == nil || err.Error() != "transfer is already fully confirmed" {
		t.Fatalf("re-confirm error = %v, want fully-confirmed guard", err)
	}

	second := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 30000}},
		})
	})
	if second.Number != 2 {
		t.Fatalf("second transfer number = %d, want 2", second.Number)
	}
	foreignLine := executorUUID(t)
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		lines := []InventoryConfirmTransferLineInput{{LineID: foreignLine, QuantityThousandths: 1000}}
		_, err := inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: second.TransferID, Lines: &lines}, now)
		return err
	})
	if err == nil || err.Error() != "confirmation references a line that does not belong to this transfer" {
		t.Fatalf("foreign line confirm error = %v, want foreign-line refusal", err)
	}
	var secondLineID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM stock_transfer_lines WHERE transfer_id=$1::uuid`, second.TransferID).Scan(&secondLineID); err != nil {
		t.Fatal(err)
	}
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		lines := []InventoryConfirmTransferLineInput{{LineID: secondLineID, QuantityThousandths: 40000}}
		_, err := inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: second.TransferID, Lines: &lines}, now)
		return err
	})
	if err == nil || err.Error() != "confirm quantity must be between 1 and 30000 thousandths for this line" {
		t.Fatalf("over-quantity confirm error = %v, want remaining guard", err)
	}
	unknown := executorUUID(t)
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: unknown}, now)
		return err
	})
	if err == nil || err.Error() != "no transfer "+unknown {
		t.Fatalf("unknown confirm error = %v, want no transfer", err)
	}

	third := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-B", ToLocationCode: "WH-A",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 50000}},
		})
	})
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: third.TransferID}, now)
		return err
	})
	if err == nil || err.Error() != "insufficient stock at source location: 30000 thousandths on hand, 50000 requested" {
		t.Fatalf("infeasible confirm error = %v, want source availability refusal", err)
	}
	assertTransferBalances(t, fx, itemID, map[string]int64{fromID: 70000, toID: 30000})
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID); got != 5 {
		t.Fatalf("movements after refused confirms = %d, want opening plus the four committed transfer legs", got)
	}
}

func TestInventoryStockConcurrentConfirmIsExactOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "TRF-RACE", "goods")
	fromID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-RACE-A", "Race source")
	toID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-RACE-B", "Race destination")
	seedInventoryStockAt(t, fx, fx.orgID, itemID, fromID, 10000)
	created := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-RACE-A", ToLocationCode: "WH-RACE-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-RACE", QuantityThousandths: 7000}},
		})
	})

	start := make(chan struct{})
	ready := sync.WaitGroup{}
	ready.Add(2)
	results := make(chan error, 2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (InventoryConfirmTransferOutput, error) {
				return inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: created.TransferID}, time.Now().UTC())
			})
			results <- err
		}()
	}
	ready.Wait()
	close(start)
	first, second := <-results, <-results
	if (first == nil) == (second == nil) {
		t.Fatalf("confirm outcomes = (%v, %v), want exactly one success", first, second)
	}
	failure := first
	if failure == nil {
		failure = second
	}
	if failure.Error() != "transfer is already fully confirmed" {
		t.Fatalf("losing confirm error = %v, want already-confirmed guard", failure)
	}
	assertTransferBalances(t, fx, itemID, map[string]int64{fromID: 3000, toID: 7000})
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND ref_id=$2::uuid AND reason='transfer'`, fx.orgID, created.TransferID); got != 2 {
		t.Fatalf("concurrent confirmation movement legs = %d, want one paired transfer", got)
	}
}

func TestInventoryStockReverseTransferRestoresStock(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "TRF-REVERSE", "goods")
	fromID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-REV-A", "Reversal source")
	toID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-REV-B", "Reversal destination")
	seedInventoryStockAt(t, fx, fx.orgID, itemID, fromID, 12000)
	created := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-REV-A", ToLocationCode: "WH-REV-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-REVERSE", QuantityThousandths: 9000}},
		})
	})
	_ = inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryConfirmTransferOutput, error) {
		return inventoryConfirmTransfer(fx.ctx, tx, claims, InventoryConfirmTransferInput{TransferID: created.TransferID}, time.Now().UTC())
	})

	reversed := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryReverseTransferOutput, error) {
		return inventoryReverseTransfer(fx.ctx, tx, claims, InventoryReverseTransferInput{TransferID: created.TransferID}, time.Now().UTC())
	})
	if !reversed.Reversed || !isUUID(reversed.ReversalTransferID) {
		t.Fatalf("reverse output = %+v, want successful mirrored transfer", reversed)
	}
	assertTransferBalances(t, fx, itemID, map[string]int64{fromID: 12000, toID: 0})
	var originalStatus, mirrorStatus, reversalOf string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM stock_transfers WHERE id=$1::uuid`, created.TransferID).Scan(&originalStatus); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, reversal_of_id::text FROM stock_transfers WHERE id=$1::uuid`, reversed.ReversalTransferID).Scan(&mirrorStatus, &reversalOf); err != nil {
		t.Fatal(err)
	}
	if originalStatus != "reversed" || mirrorStatus != "confirmed" || reversalOf != created.TransferID {
		t.Fatalf("original/mirror state = %s/%s of %s, want reversed/confirmed of original %s", originalStatus, mirrorStatus, reversalOf, created.TransferID)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND ref_id=$2::uuid AND reason='transfer'`, fx.orgID, reversed.ReversalTransferID); got != 2 {
		t.Fatalf("reversal movement legs = %d, want one paired return transfer", got)
	}
	if err := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReverseTransfer(fx.ctx, tx, claims, InventoryReverseTransferInput{TransferID: created.TransferID}, time.Now().UTC())
		return err
	}); err == nil || err.Error() != "transfer "+created.TransferID+" has already been reversed" {
		t.Fatalf("second reverse error = %v, want already-reversed guard", err)
	}
}

func assertTransferBalances(t *testing.T, fx *executorFixture, itemID string, want map[string]int64) {
	t.Helper()
	for locationID, quantity := range want {
		var got int64
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT COALESCE(SUM(quantity), 0) FROM stock_balances
			WHERE org_id=$1::uuid AND item_id=$2::uuid AND location_id=$3::uuid`,
			fx.orgID, itemID, locationID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != quantity {
			t.Fatalf("balance at %s = %d, want %d", locationID, got, quantity)
		}
	}
}

func TestInventoryStockTransferCancelListAndTenants(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	foreignClaims := authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human", ActorID: claims.ActorID}
	seedSalesItem(t, fx, fx.orgID, "TRF-CHAIR", "goods")
	seedSalesItem(t, fx, fx.otherOrgID, "TRF-CHAIR", "goods")
	seedInventoryStockLocation(t, fx, fx.orgID, "WH-A", "Local source")
	seedInventoryStockLocation(t, fx, fx.orgID, "WH-B", "Local destination")
	seedInventoryStockLocation(t, fx, fx.otherOrgID, "WH-A", "Foreign source")
	seedInventoryStockLocation(t, fx, fx.otherOrgID, "WH-B", "Foreign destination")
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)

	err := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-A",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 1000}},
		})
		return err
	})
	if err == nil || err.Error() != "source and destination locations must differ" {
		t.Fatalf("same-location create error = %v, want differ guard", err)
	}
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "NOPE", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 1000}},
		})
		return err
	})
	if err == nil || err.Error() != "no location with code NOPE" {
		t.Fatalf("unknown source create error = %v, want location refusal", err)
	}
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "NOPE", QuantityThousandths: 1000}},
		})
		return err
	})
	if err == nil || err.Error() != "no item with SKU NOPE" {
		t.Fatalf("unknown sku create error = %v, want item refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM stock_transfers WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("refused creates stored %d transfers, want none", got)
	}

	first := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 1000}},
			Note:  crmStringPointer("cycle shelf"),
		})
	})
	second := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, claims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 2000}},
		})
	})
	foreign := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryCreateTransferOutput, error) {
		return inventoryCreateTransfer(fx.ctx, tx, foreignClaims, InventoryCreateTransferInput{
			FromLocationCode: "WH-A", ToLocationCode: "WH-B",
			Lines: []InventoryTransferLineInput{{SKU: "TRF-CHAIR", QuantityThousandths: 5000}},
		})
	})
	if first.Number != 1 || second.Number != 2 {
		t.Fatalf("local numbers = (%d, %d), want per-org sequence 1 then 2", first.Number, second.Number)
	}
	if foreign.Number != 1 {
		t.Fatalf("foreign number = %d, want an independent sequence", foreign.Number)
	}

	cancelled := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCancelTransferOutput, error) {
		return inventoryCancelTransfer(fx.ctx, tx, fx.orgID, InventoryCancelTransferInput{TransferID: first.TransferID}, now)
	})
	if !cancelled.Cancelled {
		t.Fatalf("cancel output = %+v, want cancelled", cancelled)
	}
	encoded, err := marshalJS(cancelled)
	if err != nil || string(encoded) != `{"cancelled":true}` {
		t.Fatalf("cancel output JSON = %s, %v", encoded, err)
	}
	var status string
	var cancelledAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, cancelled_at FROM stock_transfers WHERE id=$1::uuid`, first.TransferID).Scan(&status, &cancelledAt); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || cancelledAt == nil || !cancelledAt.Equal(now) {
		t.Fatalf("cancelled transfer = %s/%v, want cancelled at the passed now", status, cancelledAt)
	}
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCancelTransfer(fx.ctx, tx, fx.orgID, InventoryCancelTransferInput{TransferID: first.TransferID}, now)
		return err
	})
	if err == nil || err.Error() != "transfer is cancelled; only untouched drafts can be cancelled - reverse it instead" {
		t.Fatalf("re-cancel error = %v, want status guard", err)
	}

	var secondFromID, secondToID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT from_location_id::text, to_location_id::text FROM stock_transfers WHERE id=$1::uuid`, second.TransferID).Scan(&secondFromID, &secondToID); err != nil {
		t.Fatal(err)
	}
	itemID := seedInventoryItemID(t, fx, fx.orgID, "TRF-CHAIR")
	movedID := seedInventoryTransferRow(t, fx, fx.orgID, 3, secondFromID, secondToID, "pending", now)
	seedInventoryTransferLine(t, fx, fx.orgID, movedID, itemID, 10000, 5000, nil)
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCancelTransfer(fx.ctx, tx, fx.orgID, InventoryCancelTransferInput{TransferID: movedID}, now)
		return err
	})
	if err == nil || err.Error() != "quantity already moved; reverse the transfer instead" {
		t.Fatalf("moved cancel error = %v, want moved guard", err)
	}

	base := time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)
	pending := seedInventoryTransferRow(t, fx, fx.orgID, 4, secondFromID, secondToID, "pending", base.Add(2*time.Hour))
	partial := seedInventoryTransferRow(t, fx, fx.orgID, 5, secondFromID, secondToID, "partial", base.Add(time.Hour))
	confirmed := seedInventoryTransferRow(t, fx, fx.orgID, 6, secondFromID, secondToID, "confirmed", base)
	foreignPending := seedInventoryTransferRow(t, fx, fx.otherOrgID, 9, secondFromID, secondToID, "pending", base.Add(3*time.Hour))

	all := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryListTransfersOutput, error) {
		return inventoryListTransfers(fx.ctx, tx, fx.orgID, InventoryListTransfersInput{})
	})
	byID := make(map[string]InventoryListTransferItem, len(all.Transfers))
	for index, row := range all.Transfers {
		if row.ID == foreign.TransferID {
			t.Fatalf("foreign org transfer leaked into the local listing at index %d", index)
		}
		byID[row.ID] = row
	}
	if len(all.Transfers) != 6 {
		t.Fatalf("listTransfers = %d rows, want the six local transfers", len(all.Transfers))
	}
	for _, id := range []string{first.TransferID, second.TransferID, movedID, pending, partial, confirmed} {
		if _, ok := byID[id]; !ok {
			t.Fatalf("listTransfers missing local transfer %s, got %+v", id, all.Transfers)
		}
	}
	indexOf := func(id string) int {
		for index, row := range all.Transfers {
			if row.ID == id {
				return index
			}
		}
		return -1
	}
	if indexOf(pending) > indexOf(partial) || indexOf(partial) > indexOf(confirmed) {
		t.Fatalf("listTransfers order = %+v, want newest first", all.Transfers)
	}
	if row := byID[pending]; row.Number != 4 || row.Status != "pending" || row.Note != nil || row.CreatedAt != "2026-09-20T10:00:00.000Z" {
		t.Fatalf("hand-seeded pending row = %+v, want number 4 pending with null note", row)
	}
	if row := byID[first.TransferID]; row.Number != 1 || row.Status != "cancelled" || row.Note == nil || *row.Note != "cycle shelf" {
		t.Fatalf("cancelled row = %+v, want number 1 cancelled with its note", row)
	}
	if row := byID[second.TransferID]; row.Number != 2 || row.Status != "pending" || row.Note != nil {
		t.Fatalf("pending create row = %+v, want number 2 pending with null note", row)
	}
	newestEncoded, err := marshalJS(byID[pending])
	if err != nil {
		t.Fatal(err)
	}
	wantPending := fmt.Sprintf(`{"id":%q,"number":4,"status":"pending","note":null,"createdAt":"2026-09-20T10:00:00.000Z"}`, pending)
	if string(newestEncoded) != wantPending {
		t.Fatalf("list row JSON = %s, want %s", newestEncoded, wantPending)
	}

	open := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryListTransfersOutput, error) {
		return inventoryListTransfers(fx.ctx, tx, fx.orgID, InventoryListTransfersInput{OpenOnly: true})
	})
	if len(open.Transfers) != 4 {
		t.Fatalf("openOnly list = %d rows, want the four pending and partial transfers", len(open.Transfers))
	}
	openIDs := make(map[string]int, len(open.Transfers))
	for index, row := range open.Transfers {
		openIDs[row.ID] = index
		if row.ID == first.TransferID || row.ID == confirmed {
			t.Fatalf("openOnly list included closed transfer %s", row.ID)
		}
	}
	for _, id := range []string{second.TransferID, movedID, pending, partial} {
		if _, ok := openIDs[id]; !ok {
			t.Fatalf("openOnly list missing open transfer %s, got %+v", id, open.Transfers)
		}
	}
	if openIDs[pending] > openIDs[partial] {
		t.Fatalf("openOnly order = %+v, want newest first", open.Transfers)
	}

	foreignList := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryListTransfersOutput, error) {
		return inventoryListTransfers(fx.ctx, tx, fx.otherOrgID, InventoryListTransfersInput{OpenOnly: true})
	})
	if len(foreignList.Transfers) != 2 || foreignList.Transfers[0].ID != foreign.TransferID || foreignList.Transfers[1].ID != foreignPending {
		t.Fatalf("foreign list = %+v, want only the two foreign open transfers", foreignList.Transfers)
	}
	for _, row := range foreignList.Transfers {
		if row.ID == second.TransferID || row.ID == movedID {
			t.Fatalf("local transfer %s leaked into the foreign listing", row.ID)
		}
	}
	if got := fx.count(`SELECT count(*) FROM stock_transfer_lines WHERE transfer_id=$1::uuid`, first.TransferID); got != 1 {
		t.Fatalf("cancelled transfer lines = %d, want the draft line retained for history", got)
	}
}
