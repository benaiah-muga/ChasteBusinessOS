package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

func inventoryInt64Pointer(value int64) *int64 { return &value }

func TestInventoryItemsParsersMirrorZodContracts(t *testing.T) {
	cases := []struct {
		name     string
		parse    func(json.RawMessage) (any, error)
		raw      string
		wantJSON string
		output   any
		outputJS string
	}{
		{
			name:     "createItemFull",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryCreateItemInput(raw) },
			raw:      `{"sku":"INV-CHAIR","name":"Chair","kind":"service","unitLabel":"box","salePriceMinor":2500,"reorderPointThousandths":4000,"imageUrl":"https://cdn.example.test/chair.png","tags":["office","wood"],"barcode":"4006381333931","unknown":1}`,
			wantJSON: `{"sku":"INV-CHAIR","name":"Chair","kind":"service","unitLabel":"box","salePriceMinor":2500,"reorderPointThousandths":4000,"imageUrl":"https://cdn.example.test/chair.png","tags":["office","wood"],"barcode":"4006381333931"}`,
			output:   InventoryCreateItemOutput{ItemID: "11111111-1111-4111-8111-111111111111"},
			outputJS: `{"itemId":"11111111-1111-4111-8111-111111111111"}`,
		},
		{
			name:     "createItemDefaults",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryCreateItemInput(raw) },
			raw:      `{"name":"Desk","sku":"INV-DESK"}`,
			wantJSON: `{"sku":"INV-DESK","name":"Desk","kind":"goods","unitLabel":"unit","salePriceMinor":0,"reorderPointThousandths":0,"tags":[]}`,
		},
		{
			name:     "itemPatchFull",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryItemPatchInput(raw) },
			raw:      `{"sku":"INV-CHAIR","name":"Office Chair","unitLabel":"box","salePriceMinor":15000,"imageUrl":null,"tags":["office"],"barcode":null,"unknown":2}`,
			wantJSON: `{"barcode":null,"imageUrl":null,"name":"Office Chair","salePriceMinor":15000,"sku":"INV-CHAIR","tags":["office"],"unitLabel":"box"}`,
			output: InventoryUpdateItemOutput{SKU: "INV-CHAIR", Prior: InventoryItemPrior{
				SKU: "INV-CHAIR", NameSet: true, Name: crmStringPointer("Chair"),
				SalePriceMinorSet: true, SalePriceMinor: inventoryInt64Pointer(12000),
				BarcodeSet: true, Barcode: crmStringPointer("4006381333931"),
			}},
			outputJS: `{"sku":"INV-CHAIR","prior":{"barcode":"4006381333931","name":"Chair","salePriceMinor":12000,"sku":"INV-CHAIR"}}`,
		},
		{
			name:     "itemPatchMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryItemPatchInput(raw) },
			raw:      `{"sku":"INV-CHAIR"}`,
			wantJSON: `{"sku":"INV-CHAIR"}`,
		},
		{
			name:     "archiveItemDefault",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryArchiveItemInput(raw) },
			raw:      `{"sku":"INV-CHAIR","unknown":3}`,
			wantJSON: `{"sku":"INV-CHAIR","archive":true}`,
			output:   InventoryArchiveItemOutput{SKU: "INV-CHAIR", Archived: true},
			outputJS: `{"sku":"INV-CHAIR","archived":true}`,
		},
		{
			name:     "archiveItemRestore",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryArchiveItemInput(raw) },
			raw:      `{"sku":"INV-CHAIR","archive":false}`,
			wantJSON: `{"sku":"INV-CHAIR","archive":false}`,
			output:   InventoryArchiveItemOutput{SKU: "INV-CHAIR", Archived: false},
			outputJS: `{"sku":"INV-CHAIR","archived":false}`,
		},
		{
			name:     "createLocation",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryCreateLocationInput(raw) },
			raw:      `{"code":"WH-A","name":"Main warehouse","unknown":4}`,
			wantJSON: `{"code":"WH-A","name":"Main warehouse"}`,
			output:   InventoryCreateLocationOutput{LocationID: "11111111-1111-4111-8111-111111111111"},
			outputJS: `{"locationId":"11111111-1111-4111-8111-111111111111"}`,
		},
		{
			name:     "listLocations",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListLocationsInput(raw) },
			raw:      `{"unknown":5}`,
			wantJSON: `{}`,
			output: InventoryListLocationsOutput{Locations: []InventoryListLocationRow{
				{Code: "WH-A", Name: "Main warehouse"},
			}},
			outputJS: `{"locations":[{"code":"WH-A","name":"Main warehouse"}]}`,
		},
		{
			name:     "listLocationRecords",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListLocationRecordsInput(raw) },
			raw:      `{"ignored":true}`,
			wantJSON: `{}`,
			output: InventoryListLocationRecordsOutput{Locations: []InventoryLocationRecordRow{
				{ID: "11111111-1111-4111-8111-111111111111", OrgID: "22222222-2222-4222-8222-222222222222", Code: "WH-A", Name: "Main warehouse", CreatedAt: "2026-09-29T10:00:00.000Z"},
			}},
			outputJS: `{"locations":[{"id":"11111111-1111-4111-8111-111111111111","orgId":"22222222-2222-4222-8222-222222222222","code":"WH-A","name":"Main warehouse","createdAt":"2026-09-29T10:00:00.000Z"}]}`,
		},
		{
			name:     "lookupByBarcodeHit",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryLookupByBarcodeInput(raw) },
			raw:      `{"barcode":"4006381333931","unknown":6}`,
			wantJSON: `{"barcode":"4006381333931"}`,
			output: InventoryLookupByBarcodeOutput{Item: &InventoryBarcodeItem{
				ID: "11111111-1111-4111-8111-111111111111", SKU: "INV-CHAIR", Name: "Chair",
				UnitLabel: "unit", ImageURL: nil, Tags: []string{},
			}},
			outputJS: `{"item":{"id":"11111111-1111-4111-8111-111111111111","sku":"INV-CHAIR","name":"Chair","unitLabel":"unit","imageUrl":null,"tags":[]}}`,
		},
		{
			name:     "lookupByBarcodeMiss",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryLookupByBarcodeInput(raw) },
			raw:      `{"barcode":"4006381333931"}`,
			wantJSON: `{"barcode":"4006381333931"}`,
			output:   InventoryLookupByBarcodeOutput{Item: nil},
			outputJS: `{"item":null}`,
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

	longSKU := strings.Repeat("A", 41)
	longName := strings.Repeat("N", 121)
	longUnit := strings.Repeat("U", 21)
	longURL := "https://cdn.example.test/" + strings.Repeat("p", 480) + ".png"
	longBarcode := strings.Repeat("4", 65)
	tooManyTags := `{"sku":"A","name":"x","tags":[` + strings.Repeat(`"t",`, 20) + `"t"]}`
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"sku":null,"name":"x"}`,
		`{"sku":"","name":"x"}`,
		`{"sku":"` + longSKU + `","name":"x"}`,
		`{"sku":"A"}`,
		`{"sku":"A","name":null}`,
		`{"sku":"A","name":""}`,
		`{"sku":"A","name":"` + longName + `"}`,
		`{"sku":"A","name":"x","kind":"bundle"}`,
		`{"sku":"A","name":"x","kind":null}`,
		`{"sku":"A","name":"x","kind":5}`,
		`{"sku":"A","name":"x","unitLabel":null}`,
		`{"sku":"A","name":"x","unitLabel":"` + longUnit + `"}`,
		`{"sku":"A","name":"x","unitLabel":5}`,
		`{"sku":"A","name":"x","salePriceMinor":-1}`,
		`{"sku":"A","name":"x","salePriceMinor":1.5}`,
		`{"sku":"A","name":"x","salePriceMinor":"5"}`,
		`{"sku":"A","name":"x","salePriceMinor":null}`,
		`{"sku":"A","name":"x","reorderPointThousandths":-1}`,
		`{"sku":"A","name":"x","reorderPointThousandths":2.5}`,
		`{"sku":"A","name":"x","imageUrl":null}`,
		`{"sku":"A","name":"x","imageUrl":"not a url"}`,
		`{"sku":"A","name":"x","imageUrl":"http://"}`,
		`{"sku":"A","name":"x","imageUrl":"cdn.example.test/img.png"}`,
		`{"sku":"A","name":"x","imageUrl":"` + longURL + `"}`,
		`{"sku":"A","name":"x","imageUrl":7}`,
		`{"sku":"A","name":"x","tags":null}`,
		`{"sku":"A","name":"x","tags":"office"}`,
		`{"sku":"A","name":"x","tags":[5]}`,
		`{"sku":"A","name":"x","tags":[""]}`,
		`{"sku":"A","name":"x","tags":["` + strings.Repeat("t", 31) + `"]}`,
		tooManyTags,
		`{"sku":"A","name":"x","barcode":null}`,
		`{"sku":"A","name":"x","barcode":"ab"}`,
		`{"sku":"A","name":"x","barcode":"` + longBarcode + `"}`,
		`{"sku":"A","name":"x","barcode":5}`,
	} {
		if _, err := ParseInventoryCreateItemInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryCreateItemInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"sku":null}`,
		`{"sku":"A","name":""}`,
		`{"sku":"A","name":"` + longName + `"}`,
		`{"sku":"A","name":null}`,
		`{"sku":"A","name":5}`,
		`{"sku":"A","unitLabel":null}`,
		`{"sku":"A","unitLabel":"` + longUnit + `"}`,
		`{"sku":"A","unitLabel":5}`,
		`{"sku":"A","salePriceMinor":-1}`,
		`{"sku":"A","salePriceMinor":1.5}`,
		`{"sku":"A","salePriceMinor":null}`,
		`{"sku":"A","imageUrl":"not a url"}`,
		`{"sku":"A","imageUrl":7}`,
		`{"sku":"A","tags":null}`,
		`{"sku":"A","tags":[""]}`,
		`{"sku":"A","tags":"x"}`,
		`{"sku":"A","barcode":"ab"}`,
		`{"sku":"A","barcode":"` + longBarcode + `"}`,
		`{"sku":"A","barcode":5}`,
	} {
		if _, err := ParseInventoryItemPatchInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryItemPatchInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`{}`,
		`{"sku":null}`,
		`{"sku":""}`,
		`{"sku":"A","archive":null}`,
		`{"sku":"A","archive":"yes"}`,
		`{"sku":"A","archive":1}`,
	} {
		if _, err := ParseInventoryArchiveItemInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryArchiveItemInput accepted %.80s", raw)
		}
	}

	longCode := strings.Repeat("W", 21)
	longLocationName := strings.Repeat("L", 81)
	for _, raw := range []string{
		`{}`,
		`{"code":null,"name":"x"}`,
		`{"code":"","name":"x"}`,
		`{"code":"` + longCode + `","name":"x"}`,
		`{"code":"A"}`,
		`{"code":"A","name":null}`,
		`{"code":"A","name":""}`,
		`{"code":"A","name":"` + longLocationName + `"}`,
	} {
		if _, err := ParseInventoryCreateLocationInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryCreateLocationInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`[]`,
		`"{}"`,
		`{} trailing`,
	} {
		if _, err := ParseInventoryListLocationsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryListLocationsInput accepted %.80s", raw)
		}
	}

	for _, raw := range []string{
		`{}`,
		`{"barcode":null}`,
		`{"barcode":"ab"}`,
		`{"barcode":"` + longBarcode + `"}`,
		`{"barcode":5}`,
	} {
		if _, err := ParseInventoryLookupByBarcodeInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryLookupByBarcodeInput accepted %.80s", raw)
		}
	}

	minimals := map[string]string{
		inventoryCreateItemCapabilityID:      `{"sku":"S","name":"x"}`,
		inventoryUpdateItemCapabilityID:      `{"sku":"S"}`,
		inventoryRestoreItemCapabilityID:     `{"sku":"S","name":"x"}`,
		inventoryArchiveItemCapabilityID:     `{"sku":"S"}`,
		inventoryCreateLocationCapabilityID:  `{"code":"A","name":"x"}`,
		inventoryListLocationsCapabilityID:   `{}`,
		inventoryLookupByBarcodeCapabilityID: `{"barcode":"4006381333931"}`,
	}
	for capabilityID, raw := range minimals {
		if _, err := parseInventoryItemInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseInventoryItemInput(%s) error = %v", capabilityID, err)
		}
	}
	if _, err := parseInventoryItemInput("inventory.unknown", json.RawMessage(`{}`)); err == nil {
		t.Error("parseInventoryItemInput accepted an unsupported capability")
	}
}

type inventoryItemsRow struct {
	kind      string
	unitLabel string
	salePrice int64
	reorder   int64
	imageURL  *string
	tags      []string
	barcode   *string
	archived  *time.Time
}

func inventoryItemsLoadRow(t *testing.T, fx *executorFixture, orgID, sku string) inventoryItemsRow {
	t.Helper()
	var row inventoryItemsRow
	var rawTags []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT kind, unit_label, sale_price_minor, reorder_point_thousandths, image_url, tags, barcode, archived_at
		FROM items WHERE org_id=$1::uuid AND sku=$2`, orgID, sku).
		Scan(&row.kind, &row.unitLabel, &row.salePrice, &row.reorder, &row.imageURL, &rawTags, &row.barcode, &row.archived); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rawTags, &row.tags); err != nil {
		t.Fatal(err)
	}
	return row
}

func inventoryItemsBalance(t *testing.T, fx *executorFixture, orgID, itemID string) int64 {
	t.Helper()
	return inventoryInOrgTx(t, fx, orgID, func(tx pgx.Tx) (int64, error) {
		var total int64
		err := tx.QueryRow(fx.ctx, `
			SELECT COALESCE(SUM(quantity), 0) FROM stock_balances
			WHERE org_id=$1::uuid AND item_id=$2::uuid`, orgID, itemID).Scan(&total)
		return total, err
	})
}

func inventoryItemsCreateInput(t *testing.T, raw string) InventoryCreateItemInput {
	t.Helper()
	input, err := ParseInventoryCreateItemInput(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return input
}

func TestInventoryItemsCreateUpdateArchiveLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	foreignClaims := authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human", ActorID: claims.ActorID}
	now := time.Date(2026, 9, 28, 9, 30, 0, 0, time.UTC)
	imageURL := "https://cdn.example.test/chair.png"
	barcode := "4006381333931"

	created := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t,
			`{"sku":"ITM-CHAIR","name":"Chair","salePriceMinor":12000,"reorderPointThousandths":5000,"imageUrl":"https://cdn.example.test/chair.png","tags":["office","wood"],"barcode":"4006381333931"}`))
	})
	if !isUUID(created.ItemID) {
		t.Fatalf("createItem output = %+v, want a UUID itemId", created)
	}
	encoded, err := marshalJS(created)
	if err != nil || string(encoded) != fmt.Sprintf(`{"itemId":%q}`, created.ItemID) {
		t.Fatalf("createItem output JSON = %s, %v", encoded, err)
	}
	row := inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-CHAIR")
	if row.kind != "goods" || row.unitLabel != "unit" || row.salePrice != 12000 || row.reorder != 5000 ||
		row.imageURL == nil || *row.imageURL != imageURL || row.barcode == nil || *row.barcode != barcode ||
		len(row.tags) != 2 || row.tags[0] != "office" || row.tags[1] != "wood" || row.archived != nil {
		t.Fatalf("created row = %+v, want the full catalog row", row)
	}
	seedSalesStock(t, fx, fx.orgID, created.ItemID, 25000)

	defaults := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t, `{"sku":"ITM-DEFAULT","name":"Bare item"}`))
	})
	defaultRow := inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-DEFAULT")
	if defaults.ItemID == "" || defaultRow.kind != "goods" || defaultRow.unitLabel != "unit" ||
		defaultRow.salePrice != 0 || defaultRow.reorder != 0 || defaultRow.barcode != nil ||
		defaultRow.imageURL != nil || len(defaultRow.tags) != 0 {
		t.Fatalf("defaults row = %+v (%+v), want zod defaults applied", defaultRow, defaults)
	}

	service := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t,
			`{"sku":"ITM-INSTALL","name":"Install service","kind":"service","reorderPointThousandths":5000}`))
	})
	serviceRow := inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-INSTALL")
	if service.ItemID == "" || serviceRow.kind != "service" || serviceRow.reorder != 0 {
		t.Fatalf("service row = %+v (%+v), want the reorder point dropped at the boundary", serviceRow, service)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t, `{"sku":"ITM-CHAIR","name":"Duplicate"}`))
		return err
	})
	if err == nil || err.Error() != `SKU "ITM-CHAIR" already exists` {
		t.Fatalf("duplicate sku error = %v, want the TS duplicate refusal", err)
	}
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t, `{"sku":"ITM-DESK","name":"Desk","barcode":"4006381333931"}`))
		return err
	})
	if err == nil || err.Error() != fmt.Sprintf("barcode %q is already on another item", barcode) {
		t.Fatalf("duplicate barcode error = %v, want the TS barcode refusal", err)
	}
	foreign := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, foreignClaims, inventoryItemsCreateInput(t,
			`{"sku":"ITM-CHAIR","name":"Foreign chair","barcode":"4006381333931"}`))
	})
	if !isUUID(foreign.ItemID) || foreign.ItemID == created.ItemID {
		t.Fatalf("foreign create = %+v, want the same SKU and barcode allowed in another organization", foreign)
	}

	patched := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryUpdateItemOutput, error) {
		return inventoryUpdateItem(fx.ctx, tx, claims, InventoryItemPatchInput{
			SKU: "ITM-CHAIR", Name: crmStringPointer("Office Chair"),
			SalePriceMinor: inventoryInt64Pointer(15000),
		})
	})
	encoded, err = marshalJS(patched)
	if err != nil {
		t.Fatal(err)
	}
	wantPrior := `{"sku":"ITM-CHAIR","prior":{"name":"Chair","salePriceMinor":12000,"sku":"ITM-CHAIR"}}`
	if string(encoded) != wantPrior {
		t.Fatalf("update output = %s, want %s", encoded, wantPrior)
	}
	row = inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-CHAIR")
	if row.salePrice != 15000 || row.barcode == nil || *row.barcode != barcode ||
		row.unitLabel != "unit" || len(row.tags) != 2 || row.imageURL == nil || *row.imageURL != imageURL {
		t.Fatalf("patched row = %+v, want name and price changed and the rest untouched", row)
	}

	deskBarcode := "4000000000006"
	deskCreated := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t,
			`{"sku":"ITM-DESK","name":"Desk","barcode":"4000000000006"}`))
	})
	if !isUUID(deskCreated.ItemID) {
		t.Fatalf("desk create = %+v, want success", deskCreated)
	}
	seedSalesStock(t, fx, fx.orgID, deskCreated.ItemID, 9000)

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryUpdateItem(fx.ctx, tx, claims, InventoryItemPatchInput{
			SKU: "ITM-CHAIR", Barcode: &deskBarcode, BarcodeSet: true,
		})
		return err
	})
	if err == nil || err.Error() != fmt.Sprintf("barcode %q is already on another item", deskBarcode) {
		t.Fatalf("patch dupe barcode error = %v, want the TS barcode refusal", err)
	}
	same := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryUpdateItemOutput, error) {
		return inventoryUpdateItem(fx.ctx, tx, claims, InventoryItemPatchInput{
			SKU: "ITM-CHAIR", Barcode: &barcode, BarcodeSet: true,
		})
	})
	if !same.Prior.BarcodeSet || same.Prior.Barcode == nil || *same.Prior.Barcode != barcode {
		t.Fatalf("own-barcode patch = %+v, want it accepted with the prior captured", same)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryUpdateItem(fx.ctx, tx, claims, InventoryItemPatchInput{SKU: "NOPE", Name: crmStringPointer("x")})
		return err
	})
	if err == nil || err.Error() != "no item with SKU NOPE" {
		t.Fatalf("unknown sku patch error = %v, want the TS refusal", err)
	}
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryUpdateItem(fx.ctx, tx, claims, InventoryItemPatchInput{SKU: "ITM-CHAIR"})
		return err
	})
	if err == nil || err.Error() != "nothing to update" {
		t.Fatalf("empty patch error = %v, want the TS refusal", err)
	}

	cleared := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryUpdateItemOutput, error) {
		return inventoryUpdateItem(fx.ctx, tx, claims, InventoryItemPatchInput{SKU: "ITM-CHAIR", BarcodeSet: true})
	})
	encoded, err = marshalJS(cleared)
	if err != nil {
		t.Fatal(err)
	}
	wantCleared := `{"sku":"ITM-CHAIR","prior":{"barcode":"4006381333931","sku":"ITM-CHAIR"}}`
	if string(encoded) != wantCleared {
		t.Fatalf("clear output = %s, want %s", encoded, wantCleared)
	}
	row = inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-CHAIR")
	if row.barcode != nil {
		t.Fatalf("barcode after clear = %v, want NULL", row.barcode)
	}

	restored := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryUpdateItemOutput, error) {
		return inventoryRestoreItem(fx.ctx, tx, claims, InventoryItemPatchInput{
			SKU: "ITM-CHAIR", Name: crmStringPointer("Chair"),
			SalePriceMinor: inventoryInt64Pointer(12000), Barcode: &barcode, BarcodeSet: true,
		})
	})
	encoded, err = marshalJS(restored)
	if err != nil {
		t.Fatal(err)
	}
	wantRestoredPrior := `{"sku":"ITM-CHAIR","prior":{"barcode":null,"name":"Office Chair","salePriceMinor":15000,"sku":"ITM-CHAIR"}}`
	if string(encoded) != wantRestoredPrior {
		t.Fatalf("restore output = %s, want %s", encoded, wantRestoredPrior)
	}
	row = inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-CHAIR")
	if row.salePrice != 12000 || row.barcode == nil || *row.barcode != barcode {
		t.Fatalf("restored row = %+v, want the update undone", row)
	}

	archiveInput, err := ParseInventoryArchiveItemInput(json.RawMessage(`{"sku":"ITM-DESK"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !archiveInput.Archive {
		t.Fatal("archive input default = false, want zod default true")
	}
	archived := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryArchiveItemOutput, error) {
		return inventoryArchiveItem(fx.ctx, tx, claims, archiveInput, now)
	})
	encoded, err = marshalJS(archived)
	if err != nil || string(encoded) != `{"sku":"ITM-DESK","archived":true}` {
		t.Fatalf("archive output = %s, %v", encoded, err)
	}
	deskRow := inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-DESK")
	if deskRow.archived == nil || !deskRow.archived.Equal(now) {
		t.Fatalf("archived_at = %v, want %v", deskRow.archived, now)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, deskCreated.ItemID); got != 1 {
		t.Fatalf("movements after archive = %d, want the ledger untouched", got)
	}
	if got := inventoryItemsBalance(t, fx, fx.orgID, deskCreated.ItemID); got != 9000 {
		t.Fatalf("stock balance after archive = %d, want 9000", got)
	}

	unarchived := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryArchiveItemOutput, error) {
		return inventoryArchiveItem(fx.ctx, tx, claims, InventoryArchiveItemInput{SKU: "ITM-DESK", Archive: false}, now)
	})
	if unarchived.SKU != "ITM-DESK" || unarchived.Archived {
		t.Fatalf("unarchive output = %+v, want archived false", unarchived)
	}
	deskRow = inventoryItemsLoadRow(t, fx, fx.orgID, "ITM-DESK")
	if deskRow.archived != nil {
		t.Fatalf("archived_at after restore = %v, want NULL", deskRow.archived)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryArchiveItem(fx.ctx, tx, claims, InventoryArchiveItemInput{SKU: "NOPE"}, now)
		return err
	})
	if err == nil || err.Error() != `SKU "NOPE" not found` {
		t.Fatalf("unknown archive error = %v, want the TS refusal", err)
	}

	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, created.ItemID); got != 1 {
		t.Fatalf("chair movements after lifecycle = %d, want updates and archives to never touch the ledger", got)
	}
	if got := inventoryItemsBalance(t, fx, fx.orgID, created.ItemID); got != 25000 {
		t.Fatalf("chair balance after lifecycle = %d, want 25000", got)
	}
}

func TestInventoryItemsLocationsAndBarcodeLookup(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := inventoryTestClaims(fx)
	foreignClaims := authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human", ActorID: claims.ActorID}
	scanBarcode := "4006381333931"

	empty := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryListLocationsOutput, error) {
		return inventoryListLocations(fx.ctx, tx, fx.otherOrgID, InventoryListLocationsInput{})
	})
	encoded, err := marshalJS(empty)
	if err != nil || string(encoded) != `{"locations":[]}` {
		t.Fatalf("empty list output = %s, %v", encoded, err)
	}

	first := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateLocationOutput, error) {
		return inventoryCreateLocation(fx.ctx, tx, claims, InventoryCreateLocationInput{Code: "WH-A", Name: "Main warehouse"})
	})
	if !isUUID(first.LocationID) {
		t.Fatalf("createLocation output = %+v, want a UUID locationId", first)
	}
	encoded, err = marshalJS(first)
	if err != nil || string(encoded) != fmt.Sprintf(`{"locationId":%q}`, first.LocationID) {
		t.Fatalf("createLocation output JSON = %s, %v", encoded, err)
	}
	second := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateLocationOutput, error) {
		return inventoryCreateLocation(fx.ctx, tx, claims, InventoryCreateLocationInput{Code: "WH-B", Name: "Second warehouse"})
	})
	if !isUUID(second.LocationID) || second.LocationID == first.LocationID {
		t.Fatalf("second location = %+v, want a distinct row", second)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryCreateLocation(fx.ctx, tx, claims, InventoryCreateLocationInput{Code: "WH-A", Name: "Another"})
		return err
	})
	if err == nil || err.Error() != `location code "WH-A" already exists` {
		t.Fatalf("duplicate location error = %v, want the TS duplicate refusal", err)
	}
	foreignLocation := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryCreateLocationOutput, error) {
		return inventoryCreateLocation(fx.ctx, tx, foreignClaims, InventoryCreateLocationInput{Code: "WH-A", Name: "Foreign warehouse"})
	})
	if !isUUID(foreignLocation.LocationID) {
		t.Fatalf("foreign location = %+v, want the same code allowed in another organization", foreignLocation)
	}

	local := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryListLocationsOutput, error) {
		return inventoryListLocations(fx.ctx, tx, fx.orgID, InventoryListLocationsInput{})
	})
	if len(local.Locations) != 2 ||
		local.Locations[0].Code != "WH-A" || local.Locations[0].Name != "Main warehouse" ||
		local.Locations[1].Code != "WH-B" || local.Locations[1].Name != "Second warehouse" {
		t.Fatalf("local locations = %+v, want code-ascending order", local.Locations)
	}
	encoded, err = marshalJS(local)
	if err != nil || string(encoded) != `{"locations":[{"code":"WH-A","name":"Main warehouse"},{"code":"WH-B","name":"Second warehouse"}]}` {
		t.Fatalf("local list output = %s, %v", encoded, err)
	}
	foreign := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryListLocationsOutput, error) {
		return inventoryListLocations(fx.ctx, tx, fx.otherOrgID, InventoryListLocationsInput{})
	})
	if len(foreign.Locations) != 1 || foreign.Locations[0].Code != "WH-A" || foreign.Locations[0].Name != "Foreign warehouse" {
		t.Fatalf("foreign locations = %+v, want only the foreign row", foreign.Locations)
	}

	scanned := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, claims, inventoryItemsCreateInput(t,
			`{"sku":"ITM-SCAN","name":"Scanner","barcode":"4006381333931","imageUrl":"https://cdn.example.test/scanner.png","tags":["scan"]}`))
	})
	if !isUUID(scanned.ItemID) {
		t.Fatalf("scan item = %+v, want success", scanned)
	}
	foreignScan := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryCreateItemOutput, error) {
		return inventoryCreateItem(fx.ctx, tx, foreignClaims, inventoryItemsCreateInput(t,
			`{"sku":"ITM-SCAN","name":"Foreign scanner","barcode":"4006381333931"}`))
	})
	if !isUUID(foreignScan.ItemID) {
		t.Fatalf("foreign scan item = %+v, want success", foreignScan)
	}

	hit := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryLookupByBarcodeOutput, error) {
		return inventoryLookupByBarcode(fx.ctx, tx, fx.orgID, InventoryLookupByBarcodeInput{Barcode: scanBarcode})
	})
	if hit.Item == nil || hit.Item.ID != scanned.ItemID || hit.Item.SKU != "ITM-SCAN" ||
		hit.Item.Name != "Scanner" || hit.Item.UnitLabel != "unit" ||
		hit.Item.ImageURL == nil || *hit.Item.ImageURL != "https://cdn.example.test/scanner.png" ||
		len(hit.Item.Tags) != 1 || hit.Item.Tags[0] != "scan" {
		t.Fatalf("barcode hit = %+v, want the local item", hit.Item)
	}
	encoded, err = marshalJS(hit)
	if err != nil || string(encoded) != fmt.Sprintf(`{"item":{"id":%q,"sku":"ITM-SCAN","name":"Scanner","unitLabel":"unit","imageUrl":"https://cdn.example.test/scanner.png","tags":["scan"]}}`, scanned.ItemID) {
		t.Fatalf("hit output = %s, %v", encoded, err)
	}
	foreignHit := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryLookupByBarcodeOutput, error) {
		return inventoryLookupByBarcode(fx.ctx, tx, fx.otherOrgID, InventoryLookupByBarcodeInput{Barcode: scanBarcode})
	})
	if foreignHit.Item == nil || foreignHit.Item.ID != foreignScan.ItemID || foreignHit.Item.Name != "Foreign scanner" {
		t.Fatalf("foreign hit = %+v, want the foreign item", foreignHit.Item)
	}
	miss := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryLookupByBarcodeOutput, error) {
		return inventoryLookupByBarcode(fx.ctx, tx, fx.orgID, InventoryLookupByBarcodeInput{Barcode: "9999999999999"})
	})
	if miss.Item != nil {
		t.Fatalf("miss = %+v, want an explicit null", miss.Item)
	}
	encoded, err = marshalJS(miss)
	if err != nil || string(encoded) != `{"item":null}` {
		t.Fatalf("miss output = %s, %v", encoded, err)
	}

	inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryArchiveItemOutput, error) {
		return inventoryArchiveItem(fx.ctx, tx, claims, InventoryArchiveItemInput{SKU: "ITM-SCAN"}, time.Now().UTC())
	})
	archivedHit := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryLookupByBarcodeOutput, error) {
		return inventoryLookupByBarcode(fx.ctx, tx, fx.orgID, InventoryLookupByBarcodeInput{Barcode: scanBarcode})
	})
	if archivedHit.Item == nil || archivedHit.Item.ID != scanned.ItemID {
		t.Fatalf("archived lookup = %+v, want the archived item still found as the TS lookup does not filter it", archivedHit.Item)
	}
}

func TestInventoryListLocationRecordsExecutionPreservesLegacyRowsAndScope(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'inventory.read', $2::uuid) ON CONFLICT DO NOTHING`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	localIDs := []string{executorUUID(t), executorUUID(t)}
	foreignID := executorUUID(t)
	for _, row := range []struct {
		id, orgID, code, name string
	}{
		{localIDs[1], fx.orgID, "WH-Z", "Last warehouse"},
		{foreignID, fx.otherOrgID, "WH-A", "Foreign warehouse"},
		{localIDs[0], fx.orgID, "WH-A", "Main warehouse"},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO stock_locations (id, org_id, code, name) VALUES ($1::uuid, $2::uuid, $3, $4)`, row.id, row.orgID, row.code, row.name); err != nil {
			t.Fatal(err)
		}
	}

	input := json.RawMessage(`{}`)
	claims := fx.humanClaims(input, "")
	claims.CapabilityID = inventoryListLocationRecordsCapabilityID
	claims.Permissions = []string{"inventory.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, inventoryListLocationRecordsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("list location records result=%+v err=%v", result, err)
	}
	var output InventoryListLocationRecordsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode location records %s: %v", result.Data, err)
	}
	if len(output.Locations) != 2 {
		t.Fatalf("location records = %+v, want only two local rows", output.Locations)
	}
	for index, want := range []struct{ id, code, name string }{
		{localIDs[0], "WH-A", "Main warehouse"},
		{localIDs[1], "WH-Z", "Last warehouse"},
	} {
		got := output.Locations[index]
		if got.ID != want.id || got.OrgID != fx.orgID || got.Code != want.code || got.Name != want.name {
			t.Fatalf("location record %d = %+v, want id/org/code/name %s/%s/%s/%s", index, got, want.id, fx.orgID, want.code, want.name)
		}
		var createdAt time.Time
		if err := fx.owner.QueryRow(fx.ctx, `SELECT created_at FROM stock_locations WHERE id=$1::uuid`, want.id).Scan(&createdAt); err != nil {
			t.Fatal(err)
		}
		wantCreatedAt := createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		if got.CreatedAt != wantCreatedAt {
			t.Fatalf("createdAt = %q, want legacy millisecond ISO %q", got.CreatedAt, wantCreatedAt)
		}
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed'`, fx.orgID, inventoryListLocationRecordsCapabilityID); got != 1 {
		t.Fatalf("location-record read audit rows=%d, want one", got)
	}

	legacyInput := json.RawMessage(`{}`)
	legacyClaims := fx.humanClaims(legacyInput, "")
	legacyClaims.CapabilityID = inventoryListLocationsCapabilityID
	legacyClaims.Permissions = []string{"inventory.read"}
	legacyResult, err := fx.executor.Execute(fx.ctx, legacyClaims, inventoryListLocationsCapabilityID, legacyInput)
	if err != nil || !legacyResult.OK {
		t.Fatalf("routine location list result=%+v err=%v", legacyResult, err)
	}
	if string(legacyResult.Data) != `{"locations":[{"code":"WH-A","name":"Main warehouse"},{"code":"WH-Z","name":"Last warehouse"}]}` {
		t.Fatalf("routine location-list output = %s, want unchanged code/name-only shape", legacyResult.Data)
	}
}
