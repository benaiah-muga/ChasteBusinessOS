package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

func TestInventoryImportsParsersMirrorZodContracts(t *testing.T) {
	uuid := executorUUID(t)
	cases := []struct {
		name     string
		parse    func(json.RawMessage) (any, error)
		raw      string
		wantJSON string
		output   any
		outputJS string
	}{
		{
			name:     "importItemsTrimsAndKeepsFields",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryImportItemsInput(raw) },
			raw:      `{"rows":[{"rowNumber":1,"sku":" IMP-CHAIR ","name":" Chair ","kind":"service","unitLabel":" box ","salePriceMinor":2500,"reorderPointThousandths":4000,"barcode":" 4006381333931 ","tags":[" office ","wood"],"unknown":1}]}`,
			wantJSON: `{"rows":[{"rowNumber":1,"sku":"IMP-CHAIR","name":"Chair","kind":"service","unitLabel":"box","salePriceMinor":2500,"reorderPointThousandths":4000,"barcode":"4006381333931","tags":["office","wood"]}]}`,
			output: InventoryImportItemsOutput{
				CreatedIDs:           []string{uuid},
				Imported:             1,
				SkippedDuplicateRows: []int64{2, 3},
			},
			outputJS: `{"createdIds":["` + uuid + `"],"imported":1,"skippedDuplicateRows":[2,3]}`,
		},
		{
			name:     "importItemsDefaults",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryImportItemsInput(raw) },
			raw:      `{"rows":[{"rowNumber":7,"sku":"IMP-DESK","name":"Desk","salePriceMinor":0}]}`,
			wantJSON: `{"rows":[{"rowNumber":7,"sku":"IMP-DESK","name":"Desk","kind":"goods","unitLabel":"unit","salePriceMinor":0,"reorderPointThousandths":0,"tags":[]}]}`,
		},
		{
			name:     "importItemsBarcodeNullDrops",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryImportItemsInput(raw) },
			raw:      `{"rows":[{"rowNumber":2,"sku":"IMP-NB","name":"No barcode","salePriceMinor":100,"barcode":null}]}`,
			wantJSON: `{"rows":[{"rowNumber":2,"sku":"IMP-NB","name":"No barcode","kind":"goods","unitLabel":"unit","salePriceMinor":100,"reorderPointThousandths":0,"tags":[]}]}`,
		},
		{
			name:     "undoItemImport",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryUndoItemImportInput(raw) },
			raw:      `{"itemIds":["` + uuid + `"],"unknown":2}`,
			wantJSON: `{"itemIds":["` + uuid + `"]}`,
			output:   InventoryUndoItemImportOutput{ItemIDs: []string{uuid}, Archived: 2},
			outputJS: `{"itemIds":["` + uuid + `"],"archived":2}`,
		},
		{
			name:     "restoreItemImport",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryRestoreItemImportInput(raw) },
			raw:      `{"itemIds":["` + uuid + `"]}`,
			wantJSON: `{"itemIds":["` + uuid + `"]}`,
			output:   InventoryRestoreItemImportOutput{ItemIDs: []string{uuid}, Restored: 1},
			outputJS: `{"itemIds":["` + uuid + `"],"restored":1}`,
		},
		{
			name:     "reserveStock",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryReserveStockInput(raw) },
			raw:      `{"sku":"RES-ITEM","quantityThousandths":10000,"reason":"SO-1042","unknown":3}`,
			wantJSON: `{"sku":"RES-ITEM","quantityThousandths":10000,"reason":"SO-1042"}`,
			output:   InventoryReserveStockOutput{ReservationID: uuid, AvailableAfterThousandths: 15000},
			outputJS: `{"reservationId":"` + uuid + `","availableAfterThousandths":15000}`,
		},
		{
			name:     "releaseReservation",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryReleaseReservationInput(raw) },
			raw:      `{"reservationId":"` + uuid + `","unknown":4}`,
			wantJSON: `{"reservationId":"` + uuid + `"}`,
			output:   InventoryReleaseReservationOutput{Released: true},
			outputJS: `{"released":true}`,
		},
		{
			name:     "listReservationsDefaultsOpenOnly",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListReservationsInput(raw) },
			raw:      `{"unknown":5}`,
			wantJSON: `{"openOnly":true}`,
		},
		{
			name:     "listReservationsAll",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListReservationsInput(raw) },
			raw:      `{"openOnly":false}`,
			wantJSON: `{"openOnly":false}`,
			output: InventoryListReservationsOutput{Reservations: []InventoryListReservationRow{{
				ID: uuid, OrgID: uuid, ItemID: uuid, SKU: "RES-ITEM", QuantityThousandths: 15000, Reason: "SO-1042", Status: "open",
				RefType: nil, RefID: nil, CreatedByActorType: nil, CreatedByActorID: nil, ReleasedAt: nil,
				CreatedAt: "2026-09-28T10:00:00.000Z",
			}}},
			outputJS: `{"reservations":[{"id":"` + uuid + `","orgId":"` + uuid + `","itemId":"` + uuid + `","sku":"RES-ITEM","quantityThousandths":15000,"reason":"SO-1042","refType":null,"refId":null,"status":"open","createdByActorType":null,"createdByActorId":null,"releasedAt":null,"createdAt":"2026-09-28T10:00:00.000Z"}]}`,
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

	promiseCases := []struct {
		onHand, reserved, want int64
	}{
		{0, 5, 0},
		{10, -3, 10},
		{10, 3, 7},
		{10, 0, 10},
		{5, 7, 0},
	}
	for _, promise := range promiseCases {
		if got := inventoryAvailableToPromise(promise.onHand, promise.reserved); got != promise.want {
			t.Errorf("inventoryAvailableToPromise(%d, %d) = %d, want %d", promise.onHand, promise.reserved, got, promise.want)
		}
	}

	longSKU := strings.Repeat("A", 41)
	longName := strings.Repeat("N", 121)
	longUnit := strings.Repeat("U", 21)
	longBarcode := strings.Repeat("4", 65)
	longTag := strings.Repeat("t", 31)
	longReason := strings.Repeat("r", 201)
	tooManyTags := `{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":[` + strings.Repeat(`"t",`, 20) + `"t"]}`
	tooManyRows := &strings.Builder{}
	tooManyRows.WriteString(`{"rows":[`)
	for index := 0; index < 5001; index++ {
		if index > 0 {
			tooManyRows.WriteString(",")
		}
		fmt.Fprintf(tooManyRows, `{"rowNumber":%d,"sku":"S%d","name":"x","salePriceMinor":0}`, index+1, index)
	}
	tooManyRows.WriteString(`]}`)
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"rows":null}`,
		`{"rows":"x"}`,
		`{"rows":{}}`,
		`{"rows":[]}`,
		`{"rows":[5]}`,
		`{"rows":[{}]}`,
		`{"rows":[{"sku":"A","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":0,"sku":"A","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":-1,"sku":"A","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1.5,"sku":"A","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":"1","sku":"A","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":null,"sku":"A","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":null,"name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"   ","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"` + longSKU + `","name":"x","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":null,"salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"` + longName + `","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","kind":"bundle","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","kind":null,"salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","kind":5,"salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","unitLabel":null,"salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","unitLabel":"","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","unitLabel":"` + longUnit + `","salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","unitLabel":5,"salePriceMinor":0}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x"}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":-1}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":1.5}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":"5"}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":null}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"reorderPointThousandths":-1}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"reorderPointThousandths":2.5}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"barcode":"ab"}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"barcode":"` + longBarcode + `"}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"barcode":5}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":null}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":"office"}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":[5]}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":[null]}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":[""]}]}`,
		`{"rows":[{"rowNumber":1,"sku":"A","name":"x","salePriceMinor":0,"tags":["` + longTag + `"]}]}`,
		tooManyTags,
		tooManyRows.String(),
	} {
		if _, err := ParseInventoryImportItemsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryImportItemsInput accepted %.80s", raw)
		}
	}

	tooManyIDs := &strings.Builder{}
	tooManyIDs.WriteString(`{"itemIds":[`)
	for index := 0; index < 5001; index++ {
		if index > 0 {
			tooManyIDs.WriteString(",")
		}
		tooManyIDs.WriteString(`"` + executorUUID(t) + `"`)
	}
	tooManyIDs.WriteString(`]}`)
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"itemIds":null}`,
		`{"itemIds":"x"}`,
		`{"itemIds":{}}`,
		`{"itemIds":[]}`,
		`{"itemIds":[null]}`,
		`{"itemIds":["not-a-uuid"]}`,
		`{"itemIds":["` + uuid + `","nope"]}`,
		tooManyIDs.String(),
	} {
		if _, err := ParseInventoryUndoItemImportInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryUndoItemImportInput accepted %.80s", raw)
		}
		if _, err := ParseInventoryRestoreItemImportInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryRestoreItemImportInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"quantityThousandths":1,"reason":"SO-1"}`,
		`{"sku":null,"quantityThousandths":1,"reason":"SO-1"}`,
		`{"sku":"A","reason":"SO-1"}`,
		`{"sku":"A","quantityThousandths":0,"reason":"SO-1"}`,
		`{"sku":"A","quantityThousandths":-1,"reason":"SO-1"}`,
		`{"sku":"A","quantityThousandths":1.5,"reason":"SO-1"}`,
		`{"sku":"A","quantityThousandths":"5","reason":"SO-1"}`,
		`{"sku":"A","quantityThousandths":null,"reason":"SO-1"}`,
		`{"sku":"A","quantityThousandths":1}`,
		`{"sku":"A","quantityThousandths":1,"reason":null}`,
		`{"sku":"A","quantityThousandths":1,"reason":"SO"}`,
		`{"sku":"A","quantityThousandths":1,"reason":"` + longReason + `"}`,
	} {
		if _, err := ParseInventoryReserveStockInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryReserveStockInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"reservationId":null}`,
		`{"reservationId":"nope"}`,
		`{"reservationId":5}`,
	} {
		if _, err := ParseInventoryReleaseReservationInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryReleaseReservationInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`[]`,
		`{"openOnly":null}`,
		`{"openOnly":"yes"}`,
		`{"openOnly":1}`,
	} {
		if _, err := ParseInventoryListReservationsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryListReservationsInput accepted %.80s", raw)
		}
	}

	minimals := map[string]string{
		inventoryImportItemsCapabilityID:        `{"rows":[{"rowNumber":1,"sku":"S","name":"x","salePriceMinor":0}]}`,
		inventoryUndoItemImportCapabilityID:     `{"itemIds":["` + uuid + `"]}`,
		inventoryRestoreItemImportCapabilityID:  `{"itemIds":["` + uuid + `"]}`,
		inventoryReserveStockCapabilityID:       `{"sku":"S","quantityThousandths":1,"reason":"SO-1"}`,
		inventoryReleaseReservationCapabilityID: `{"reservationId":"` + uuid + `"}`,
		inventoryListReservationsCapabilityID:   `{}`,
	}
	for capabilityID, raw := range minimals {
		if _, err := parseInventoryImportInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseInventoryImportInput(%s) error = %v", capabilityID, err)
		}
	}
	if _, err := parseInventoryImportInput("inventory.unknown", json.RawMessage(`{}`)); err == nil {
		t.Error("parseInventoryImportInput accepted an unsupported capability")
	}
}

// inventoryImportsCleanup removes the rows these tests create in reverse
// dependency order, before the fixture's organization cascade runs.
func inventoryImportsCleanup(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		tx, err := fx.owner.Begin(ctx)
		if err != nil {
			t.Errorf("begin inventory imports cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable inventory imports cleanup ledger maintenance: %v", err)
			return
		}
		for _, orgID := range []string{fx.orgID, fx.otherOrgID} {
			for _, statement := range []string{
				`DELETE FROM stock_reservations WHERE org_id = $1::uuid`,
				`DELETE FROM stock_movements WHERE org_id = $1::uuid`,
				`DELETE FROM stock_balances WHERE org_id = $1::uuid`,
				`DELETE FROM items WHERE org_id = $1::uuid`,
			} {
				if _, err := tx.Exec(ctx, statement, orgID); err != nil {
					t.Errorf("inventory imports cleanup: %v", err)
					return
				}
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Errorf("commit inventory imports cleanup: %v", err)
		}
	})
}

func TestInventoryImportsBatchLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	inventoryImportsCleanup(t, fx)
	claims := inventoryTestClaims(fx)
	foreignClaims := authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human", ActorID: claims.ActorID}
	now := time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)

	existing := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, InventoryCreateItemInput{
			SKU: "IMP-EXIST", Name: "Existing", Barcode: crmStringPointer("4006381333931"),
		})
	})
	if !isUUID(existing.ItemID) {
		t.Fatalf("seed item = %+v, want success", existing)
	}

	importInput, err := ParseInventoryImportItemsInput(json.RawMessage(`{"rows":[` +
		`{"rowNumber":1,"sku":"IMP-NEW","name":"New goods","salePriceMinor":1500,"reorderPointThousandths":2500,"tags":["alpha"]},` +
		`{"rowNumber":2,"sku":"imp-exist","name":"Duplicate of the seeded SKU","salePriceMinor":100},` +
		`{"rowNumber":3,"sku":"IMP-BAR","name":"Duplicate of the seeded barcode","salePriceMinor":100,"barcode":"4006381333931"},` +
		`{"rowNumber":4,"sku":"  IMP-SPACE  ","name":"Kept as written","salePriceMinor":200},` +
		`{"rowNumber":5,"sku":"IMP-SVC","name":"Install service","kind":"service","salePriceMinor":9000,"reorderPointThousandths":7000,"barcode":"4000000000006","tags":[" install "]},` +
		`{"rowNumber":6,"sku":"IMP-SPACE","name":"Duplicate inside the batch","salePriceMinor":300},` +
		`{"rowNumber":7,"sku":"IMP-KEEP","name":"Stays open","salePriceMinor":500}` +
		`]}`))
	if err != nil {
		t.Fatal(err)
	}
	imported := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryImportItemsOutput, error) {
		return inventoryImportItems(fx.ctx, tx, claims, importInput)
	})
	if len(imported.CreatedIDs) != 4 || imported.Imported != 4 {
		t.Fatalf("import output = %+v, want four created rows", imported)
	}
	if fmt.Sprint(imported.SkippedDuplicateRows) != "[2 3 6]" {
		t.Fatalf("skipped rows = %v, want [2 3 6]", imported.SkippedDuplicateRows)
	}
	sortedCreated := append([]string(nil), imported.CreatedIDs...)
	sort.Strings(sortedCreated)
	encoded, err := marshalJS(InventoryImportItemsOutput{
		CreatedIDs: sortedCreated, Imported: 4, SkippedDuplicateRows: []int64{2, 3, 6},
	})
	if err != nil || string(encoded) != fmt.Sprintf(`{"createdIds":["%s","%s","%s","%s"],"imported":4,"skippedDuplicateRows":[2,3,6]}`,
		sortedCreated[0], sortedCreated[1], sortedCreated[2], sortedCreated[3]) {
		t.Fatalf("import output JSON = %s, %v", encoded, err)
	}

	goods := inventoryItemsLoadRow(t, fx, fx.orgID, "IMP-NEW")
	if goods.kind != "goods" || goods.unitLabel != "unit" || goods.salePrice != 1500 || goods.reorder != 2500 ||
		goods.barcode != nil || len(goods.tags) != 1 || goods.tags[0] != "alpha" || goods.archived != nil {
		t.Fatalf("IMP-NEW row = %+v, want the zod defaults and explicit fields", goods)
	}
	service := inventoryItemsLoadRow(t, fx, fx.orgID, "IMP-SVC")
	if service.kind != "service" || service.salePrice != 9000 || service.reorder != 0 ||
		service.barcode != nil || len(service.tags) != 1 || service.tags[0] != "install" {
		t.Fatalf("IMP-SVC row = %+v, want the reorder point and barcode dropped and tags trimmed", service)
	}
	if row := inventoryItemsLoadRow(t, fx, fx.orgID, "IMP-SPACE"); row.salePrice != 200 {
		t.Fatalf("IMP-SPACE row = %+v, want the first batch occurrence inserted once", row)
	}

	foreignInput, err := ParseInventoryImportItemsInput(json.RawMessage(`{"rows":[{"rowNumber":1,"sku":"IMP-NEW","name":"Foreign twin","salePriceMinor":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	foreign := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryImportItemsOutput, error) {
		return inventoryImportItems(fx.ctx, tx, foreignClaims, foreignInput)
	})
	if len(foreign.CreatedIDs) != 1 || foreign.Imported != 1 {
		t.Fatalf("foreign import = %+v, want the same SKU allowed in another organization", foreign)
	}

	seedSalesStock(t, fx, fx.orgID, imported.CreatedIDs[0], 12000)
	inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryArchiveItemOutput, error) {
		return inventoryArchiveItem(fx.ctx, tx, claims, InventoryArchiveItemInput{SKU: "IMP-KEEP", Archive: true}, now.Add(-time.Hour))
	})
	keepRow := inventoryItemsLoadRow(t, fx, fx.orgID, "IMP-KEEP")
	if keepRow.archived == nil || !keepRow.archived.Equal(now.Add(-time.Hour)) {
		t.Fatalf("IMP-KEEP archived_at = %v, want the earlier archive timestamp", keepRow.archived)
	}

	undoIDs := append(append([]string(nil), imported.CreatedIDs...), foreign.CreatedIDs[0])
	undone := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryUndoItemImportOutput, error) {
		return inventoryUndoItemImport(fx.ctx, tx, claims, InventoryUndoItemImportInput{ItemIDs: undoIDs}, now)
	})
	if undone.Archived != 3 || len(undone.ItemIDs) != 3 {
		t.Fatalf("undo output = %+v, want the three unarchived batch rows archived", undone)
	}
	sort.Strings(undone.ItemIDs)
	encoded, err = marshalJS(undone)
	if err != nil || string(encoded) != fmt.Sprintf(`{"itemIds":["%s","%s","%s"],"archived":3}`,
		undone.ItemIDs[0], undone.ItemIDs[1], undone.ItemIDs[2]) {
		t.Fatalf("undo output JSON = %s, %v", encoded, err)
	}
	for _, sku := range []string{"IMP-NEW", "IMP-SPACE", "IMP-SVC"} {
		if row := inventoryItemsLoadRow(t, fx, fx.orgID, sku); row.archived == nil || !row.archived.Equal(now) {
			t.Fatalf("%s archived_at = %v, want %v", sku, row.archived, now)
		}
	}
	if row := inventoryItemsLoadRow(t, fx, fx.orgID, "IMP-KEEP"); !row.archived.Equal(now.Add(-time.Hour)) {
		t.Fatalf("IMP-KEEP archived_at after undo = %v, want the earlier timestamp preserved", row.archived)
	}
	var foreignArchivedAt *time.Time
	foreignItemID := foreign.CreatedIDs[0]
	if err := fx.owner.QueryRow(fx.ctx, `SELECT archived_at FROM items WHERE id = $1::uuid`, foreignItemID).Scan(&foreignArchivedAt); err != nil || foreignArchivedAt != nil {
		t.Fatalf("foreign item archived_at = %v, %v, want NULL (undo scoped to its organization)", foreignArchivedAt, err)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, imported.CreatedIDs[0]); got != 1 {
		t.Fatalf("movements after undo = %d, want the seeded adjustment preserved", got)
	}
	if got := inventoryItemsBalance(t, fx, fx.orgID, imported.CreatedIDs[0]); got != 12000 {
		t.Fatalf("balance after undo = %d, want 12000", got)
	}

	repeat := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryUndoItemImportOutput, error) {
		return inventoryUndoItemImport(fx.ctx, tx, claims, InventoryUndoItemImportInput{ItemIDs: imported.CreatedIDs}, now)
	})
	if repeat.Archived != 0 || len(repeat.ItemIDs) != 0 {
		t.Fatalf("repeat undo = %+v, want a no-op", repeat)
	}
	encoded, err = marshalJS(repeat)
	if err != nil || string(encoded) != `{"itemIds":[],"archived":0}` {
		t.Fatalf("repeat undo JSON = %s, %v", encoded, err)
	}

	bogusUUID := executorUUID(t)
	restoreIDs := append(append([]string(nil), imported.CreatedIDs...), foreign.CreatedIDs[0], bogusUUID)
	restored := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryRestoreItemImportOutput, error) {
		return inventoryRestoreItemImport(fx.ctx, tx, fx.orgID, InventoryRestoreItemImportInput{ItemIDs: restoreIDs})
	})
	if restored.Restored != 4 || len(restored.ItemIDs) != 4 {
		t.Fatalf("restore output = %+v, want the four archived batch rows restored", restored)
	}
	sort.Strings(restored.ItemIDs)
	encoded, err = marshalJS(restored)
	if err != nil || string(encoded) != fmt.Sprintf(`{"itemIds":["%s","%s","%s","%s"],"restored":4}`,
		restored.ItemIDs[0], restored.ItemIDs[1], restored.ItemIDs[2], restored.ItemIDs[3]) {
		t.Fatalf("restore output JSON = %s, %v", encoded, err)
	}
	for _, sku := range []string{"IMP-NEW", "IMP-SPACE", "IMP-SVC", "IMP-KEEP"} {
		if row := inventoryItemsLoadRow(t, fx, fx.orgID, sku); row.archived != nil {
			t.Fatalf("%s archived_at after restore = %v, want NULL", sku, row.archived)
		}
	}
	repeatRestore := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryRestoreItemImportOutput, error) {
		return inventoryRestoreItemImport(fx.ctx, tx, fx.orgID, InventoryRestoreItemImportInput{ItemIDs: imported.CreatedIDs})
	})
	if repeatRestore.Restored != 0 || len(repeatRestore.ItemIDs) != 0 {
		t.Fatalf("repeat restore = %+v, want a no-op", repeatRestore)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, imported.CreatedIDs[0]); got != 1 {
		t.Fatalf("movements after restore = %d, want the ledger untouched by import lifecycle", got)
	}
}

func TestInventoryImportsReservations(t *testing.T) {
	fx := newExecutorFixture(t)
	inventoryImportsCleanup(t, fx)
	claims := inventoryTestClaims(fx)
	foreignClaims := authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human", ActorID: claims.ActorID}
	releaseNow := time.Date(2026, 9, 28, 11, 0, 0, 0, time.UTC)

	item := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, InventoryCreateItemInput{SKU: "RES-ITEM", Name: "Stocked item"})
	})
	if !isUUID(item.ItemID) {
		t.Fatalf("seed item = %+v, want success", item)
	}
	seedSalesStock(t, fx, fx.orgID, item.ItemID, 25000)
	foreignItem := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, foreignClaims, InventoryCreateItemInput{SKU: "RES-ITEM", Name: "Foreign item"})
	})
	if !isUUID(foreignItem.ItemID) {
		t.Fatalf("foreign seed item = %+v, want success", foreignItem)
	}

	first := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryReserveStockOutput, error) {
		return inventoryReserveStock(fx.ctx, tx, claims, InventoryReserveStockInput{SKU: "RES-ITEM", QuantityThousandths: 10000, Reason: "SO-1042"})
	})
	if !isUUID(first.ReservationID) || first.AvailableAfterThousandths != 15000 {
		t.Fatalf("first reservation = %+v, want 15000 thousandths left", first)
	}
	encoded, err := marshalJS(first)
	if err != nil || string(encoded) != fmt.Sprintf(`{"reservationId":%q,"availableAfterThousandths":15000}`, first.ReservationID) {
		t.Fatalf("reserve output = %s, %v", encoded, err)
	}
	var status, reason, actorType string
	var quantity int64
	var actorID *string
	var releasedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, quantity_thousandths, reason, created_by_actor_type, created_by_actor_id, released_at
		FROM stock_reservations WHERE id = $1::uuid`, first.ReservationID).
		Scan(&status, &quantity, &reason, &actorType, &actorID, &releasedAt); err != nil {
		t.Fatal(err)
	}
	if status != "open" || quantity != 10000 || reason != "SO-1042" || actorType != "human" ||
		actorID == nil || *actorID != *claims.ActorID || releasedAt != nil {
		t.Fatalf("reservation row = open=%s qty=%d reason=%s actor=%s/%v released=%v, want an open human claim", status, quantity, reason, actorType, actorID, releasedAt)
	}

	second := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryReserveStockOutput, error) {
		return inventoryReserveStock(fx.ctx, tx, claims, InventoryReserveStockInput{SKU: "RES-ITEM", QuantityThousandths: 15000, Reason: "WO-9"})
	})
	if !isUUID(second.ReservationID) || second.AvailableAfterThousandths != 0 {
		t.Fatalf("second reservation = %+v, want available drained to zero", second)
	}
	oversell := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReserveStock(fx.ctx, tx, claims, InventoryReserveStockInput{SKU: "RES-ITEM", QuantityThousandths: 1, Reason: "SO-1"})
		return err
	})
	if oversell == nil || oversell.Error() != "only 0 thousandths available to promise (25000 on hand, 25000 reserved)" {
		t.Fatalf("oversell error = %v, want the TS availability refusal", oversell)
	}
	unknown := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReserveStock(fx.ctx, tx, claims, InventoryReserveStockInput{SKU: "RES-MISSING", QuantityThousandths: 1, Reason: "SO-1"})
		return err
	})
	if unknown == nil || unknown.Error() != "no item with SKU RES-MISSING" {
		t.Fatalf("unknown sku error = %v, want the TS refusal", unknown)
	}
	foreignEmpty := inventoryErrInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) error {
		_, err := inventoryReserveStock(fx.ctx, tx, foreignClaims, InventoryReserveStockInput{SKU: "RES-ITEM", QuantityThousandths: 1, Reason: "SO-2"})
		return err
	})
	if foreignEmpty == nil || foreignEmpty.Error() != "only 0 thousandths available to promise (0 on hand, 0 reserved)" {
		t.Fatalf("foreign reserve error = %v, want availability scoped to the organization", foreignEmpty)
	}

	released := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryReleaseReservationOutput, error) {
		return inventoryReleaseReservation(fx.ctx, tx, fx.orgID, InventoryReleaseReservationInput{ReservationID: first.ReservationID}, releaseNow)
	})
	encoded, err = marshalJS(released)
	if err != nil || string(encoded) != `{"released":true}` {
		t.Fatalf("release output = %s, %v", encoded, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, released_at FROM stock_reservations WHERE id = $1::uuid`, first.ReservationID).
		Scan(&status, &releasedAt); err != nil {
		t.Fatal(err)
	}
	if status != "released" || releasedAt == nil || !releasedAt.Equal(releaseNow) {
		t.Fatalf("released row = %s at %v, want released at %v", status, releasedAt, releaseNow)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, item.ItemID); got != 1 {
		t.Fatalf("movements after release = %d, want reservations to never touch the ledger", got)
	}

	twice := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReleaseReservation(fx.ctx, tx, fx.orgID, InventoryReleaseReservationInput{ReservationID: first.ReservationID}, releaseNow)
		return err
	})
	if twice == nil || twice.Error() != "reservation is released, only open ones can be released" {
		t.Fatalf("double release error = %v, want the TS lifecycle guard", twice)
	}
	bogusUUID := executorUUID(t)
	missing := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReleaseReservation(fx.ctx, tx, fx.orgID, InventoryReleaseReservationInput{ReservationID: bogusUUID}, releaseNow)
		return err
	})
	if missing == nil || missing.Error() != "no reservation "+bogusUUID {
		t.Fatalf("missing reservation error = %v, want the TS refusal", missing)
	}
	crossOrg := inventoryErrInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) error {
		_, err := inventoryReleaseReservation(fx.ctx, tx, fx.otherOrgID, InventoryReleaseReservationInput{ReservationID: second.ReservationID}, releaseNow)
		return err
	})
	if crossOrg == nil || crossOrg.Error() != "no reservation "+second.ReservationID {
		t.Fatalf("cross-org release error = %v, want the reservation invisible across organizations", crossOrg)
	}

	openList := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryListReservationsOutput, error) {
		return inventoryListReservations(fx.ctx, tx, fx.orgID, InventoryListReservationsInput{OpenOnly: true})
	})
	if len(openList.Reservations) != 1 || openList.Reservations[0].ID != second.ReservationID ||
		openList.Reservations[0].SKU != "RES-ITEM" || openList.Reservations[0].QuantityThousandths != 15000 ||
		openList.Reservations[0].Reason != "WO-9" || openList.Reservations[0].Status != "open" ||
		len(openList.Reservations[0].CreatedAt) != 24 || !strings.HasSuffix(openList.Reservations[0].CreatedAt, "Z") {
		t.Fatalf("open list = %+v, want only the open reservation with an ISO createdAt", openList.Reservations)
	}
	allList := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryListReservationsOutput, error) {
		return inventoryListReservations(fx.ctx, tx, fx.orgID, InventoryListReservationsInput{OpenOnly: false})
	})
	if len(allList.Reservations) != 2 ||
		allList.Reservations[0].ID != second.ReservationID || allList.Reservations[0].Status != "open" ||
		allList.Reservations[1].ID != first.ReservationID || allList.Reservations[1].Status != "released" {
		t.Fatalf("all list = %+v, want newest first across statuses", allList.Reservations)
	}
	encoded, err = marshalJS(allList)
	wantAll := fmt.Sprintf(`{"reservations":[{"id":%q,"orgId":%q,"itemId":%q,"sku":"RES-ITEM","quantityThousandths":15000,"reason":"WO-9","refType":null,"refId":null,"status":"open","createdByActorType":"human","createdByActorId":%q,"releasedAt":null,"createdAt":%q},{"id":%q,"orgId":%q,"itemId":%q,"sku":"RES-ITEM","quantityThousandths":10000,"reason":"SO-1042","refType":null,"refId":null,"status":"released","createdByActorType":"human","createdByActorId":%q,"releasedAt":%q,"createdAt":%q}]}`,
		second.ReservationID, fx.orgID, item.ItemID, fx.userID, allList.Reservations[0].CreatedAt,
		first.ReservationID, fx.orgID, item.ItemID, fx.userID, releaseNow.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"), allList.Reservations[1].CreatedAt)
	if err != nil || string(encoded) != wantAll {
		t.Fatalf("all list JSON = %s, %v", encoded, err)
	}
	foreignList := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryListReservationsOutput, error) {
		return inventoryListReservations(fx.ctx, tx, fx.otherOrgID, InventoryListReservationsInput{OpenOnly: false})
	})
	encoded, err = marshalJS(foreignList)
	if err != nil || string(encoded) != `{"reservations":[]}` {
		t.Fatalf("foreign list = %s, %v, want organization-scoped emptiness", encoded, err)
	}
}
