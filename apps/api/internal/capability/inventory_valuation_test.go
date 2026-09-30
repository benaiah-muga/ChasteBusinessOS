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

func cleanupInventoryValuationFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin inventory valuation fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable inventory valuation fixture ledger cleanup: %v", err)
			return
		}
		steps := []struct {
			label string
			query string
		}{
			{"journal lines", `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = $1::uuid)`},
			{"journal entries", `DELETE FROM journal_entries WHERE org_id = $1::uuid`},
			{"stock movements", `DELETE FROM stock_movements WHERE org_id = $1::uuid`},
			{"stock reservations", `DELETE FROM stock_reservations WHERE org_id = $1::uuid`},
			{"stock balances", `DELETE FROM stock_balances WHERE org_id = $1::uuid`},
			{"lots", `DELETE FROM lots WHERE org_id = $1::uuid`},
			{"items", `DELETE FROM items WHERE org_id = $1::uuid`},
			{"accounts", `DELETE FROM accounts WHERE org_id = $1::uuid`},
			{"stock locations", `DELETE FROM stock_locations WHERE org_id = $1::uuid`},
		}
		for _, orgID := range []string{fx.orgID, fx.otherOrgID} {
			for _, step := range steps {
				if _, err := tx.Exec(fx.ctx, step.query, orgID); err != nil {
					t.Errorf("delete inventory valuation fixture %s: %v", step.label, err)
					return
				}
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit inventory valuation fixture cleanup: %v", err)
		}
	})
}

func seedInventoryValuationAccounts(t *testing.T, fx *executorFixture, orgID string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1200', 'Inventory', 'asset'),
		($1::uuid, '5000', 'Cost of Goods Sold', 'expense')`, orgID); err != nil {
		t.Fatal(err)
	}
}

func seedInventoryValuationMovement(t *testing.T, fx *executorFixture, orgID, itemID string, quantityDelta int64, reason string, unitCostMinor *int64, lotID, locationID *string, actorType string, createdAt time.Time) string {
	t.Helper()
	var movementID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, unit_cost_minor, lot_id, location_id, actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9)
		RETURNING id::text`,
		orgID, itemID, quantityDelta, reason, unitCostMinor, lotID, locationID, actorType, createdAt).Scan(&movementID); err != nil {
		t.Fatal(err)
	}
	return movementID
}

func seedInventoryValuationNotedMovement(t *testing.T, fx *executorFixture, orgID, itemID string, quantityDelta int64, reason, note, refType, actorType string, createdAt time.Time, lotID, locationID *string) string {
	t.Helper()
	var movementID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, ref_type, lot_id, location_id, actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10)
		RETURNING id::text`,
		orgID, itemID, quantityDelta, reason, note, refType, lotID, locationID, actorType, createdAt).Scan(&movementID); err != nil {
		t.Fatal(err)
	}
	return movementID
}

func seedInventoryValuationArchiveItem(t *testing.T, fx *executorFixture, itemID string, archivedAt time.Time) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE items SET archived_at = $2 WHERE id = $1::uuid`, itemID, archivedAt); err != nil {
		t.Fatal(err)
	}
}

func seedInventoryValuationLot(t *testing.T, fx *executorFixture, orgID, itemID, lotCode string, createdAt time.Time) string {
	t.Helper()
	var lotID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO lots (org_id, item_id, lot_code, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4)
		RETURNING id::text`, orgID, itemID, lotCode, createdAt).Scan(&lotID); err != nil {
		t.Fatal(err)
	}
	return lotID
}

func seedInventoryValuationReservation(t *testing.T, fx *executorFixture, orgID, itemID, status string, quantityThousandths int64) string {
	t.Helper()
	var reservationID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO stock_reservations (org_id, item_id, quantity_thousandths, reason, status)
		VALUES ($1::uuid, $2::uuid, $3, 'SO-1042', $4)
		RETURNING id::text`, orgID, itemID, quantityThousandths, status).Scan(&reservationID); err != nil {
		t.Fatal(err)
	}
	return reservationID
}

func seedInventoryValuationItem(t *testing.T, fx *executorFixture, orgID, sku, kind string, salePriceMinor, reorderPointThousandths int64, tags []string) string {
	t.Helper()
	if tags == nil {
		tags = []string{}
	}
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind, unit_label, sale_price_minor, reorder_point_thousandths, tags)
		VALUES ($1::uuid, $2, $3, $4, 'each', $5, $6, $7::jsonb)
		RETURNING id::text`,
		orgID, sku, sku+" name", kind, salePriceMinor, reorderPointThousandths, tags).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func inventoryValuationIntPointer(value int64) *int64 { return &value }

func inventoryValuationStringPointer(value string) *string { return &value }

func inventoryValuationGLLines(t *testing.T, fx *executorFixture, entryID string) map[string][2]int64 {
	t.Helper()
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl JOIN accounts a ON jl.account_id = a.id
		WHERE jl.entry_id = $1::uuid ORDER BY a.code`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	lines := make(map[string][2]int64)
	for rows.Next() {
		var code string
		var debit, credit int64
		if err := rows.Scan(&code, &debit, &credit); err != nil {
			t.Fatal(err)
		}
		lines[code] = [2]int64{debit, credit}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func TestInventoryValuationParsersMirrorZodContracts(t *testing.T) {
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
			name:     "postValuationSummaryDefaultMemo",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryPostValuationSummaryInput(raw) },
			raw:      `{}`,
			wantJSON: `{"memo":"Inventory valuation summary - stock ledger to GL"}`,
		},
		{
			name:     "postValuationSummaryExplicitMemo",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryPostValuationSummaryInput(raw) },
			raw:      `{"memo":"Quarter close valuation","unknown":1}`,
			wantJSON: `{"memo":"Quarter close valuation"}`,
			output:   InventoryPostValuationSummaryOutput{Posted: true, EntryID: &uuid, VarianceMinor: -400, LedgerValueMinor: 4000, GLBalanceMinor: 4400},
			outputJS: `{"posted":true,"entryId":"` + uuid + `","varianceMinor":-400,"ledgerValueMinor":4000,"glBalanceMinor":4400}`,
		},
		{
			name:     "postValuationSummaryNoOp",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryPostValuationSummaryInput(raw) },
			raw:      `{"memo":"abc"}`,
			wantJSON: `{"memo":"abc"}`,
			output:   InventoryPostValuationSummaryOutput{Posted: false, EntryID: nil, VarianceMinor: 0, LedgerValueMinor: 4400, GLBalanceMinor: 4400},
			outputJS: `{"posted":false,"entryId":null,"varianceMinor":0,"ledgerValueMinor":4400,"glBalanceMinor":4400}`,
		},
		{
			name:     "reverseValuationSummary",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryReverseValuationSummaryInput(raw) },
			raw:      `{"entryId":"` + uuid + `","unknown":1}`,
			wantJSON: `{"entryId":"` + uuid + `"}`,
			output:   InventoryReverseValuationSummaryOutput{Reversed: true, ReversalEntryID: uuid},
			outputJS: `{"reversed":true,"reversalEntryId":"` + uuid + `"}`,
		},
		{
			name:     "stockReport",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryStockReportInput(raw) },
			raw:      `{"belowReorderOnly":true,"unknown":1}`,
			wantJSON: `{"belowReorderOnly":true}`,
			output: InventoryStockReportOutput{Items: []InventoryStockReportItem{{
				SKU: "VAL-A", Name: "VAL-A name", Kind: "goods", UnitLabel: "each", SalePriceMinor: 2500,
				ImageURL: nil, Tags: []string{}, Barcode: nil,
				OnHandThousandths: 12000, ValueMinor: 12000, AvgUnitCostMinor: 1000,
				ReservedThousandths: 3000, AvailableThousandths: 9000,
				ReorderPointThousandths: 8000, ReorderNeeded: false,
			}}, TotalValueMinor: 12000},
			outputJS: `{"items":[{"sku":"VAL-A","name":"VAL-A name","kind":"goods","unitLabel":"each","salePriceMinor":2500,"imageUrl":null,"tags":[],"barcode":null,"onHandThousandths":12000,"valueMinor":12000,"avgUnitCostMinor":1000,"reservedThousandths":3000,"availableThousandths":9000,"reorderPointThousandths":8000,"reorderNeeded":false}],"totalValueMinor":12000}`,
		},
		{
			name:     "stockReportMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryStockReportInput(raw) },
			raw:      `{}`,
			wantJSON: `{}`,
		},
		{
			name:     "itemHistory",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryItemHistoryInput(raw) },
			raw:      `{"sku":"VAL-A","limit":10,"unknown":1}`,
			wantJSON: `{"sku":"VAL-A","limit":10}`,
			output: InventoryItemHistoryOutput{Movements: []InventoryItemHistoryMovement{{
				ID: uuid, QuantityDelta: -2000, Reason: "sale", Note: nil, RefType: nil, UnitCostMinor: nil,
				LotCode: nil, LocationCode: nil, ActorType: "system", CreatedAt: "2026-09-01T10:00:00.000Z",
			}}},
			outputJS: `{"movements":[{"id":"` + uuid + `","quantityDelta":-2000,"reason":"sale","note":null,"refType":null,"unitCostMinor":null,"lotCode":null,"locationCode":null,"actorType":"system","createdAt":"2026-09-01T10:00:00.000Z"}]}`,
		},
		{
			name:     "itemHistoryDefaultLimit",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryItemHistoryInput(raw) },
			raw:      `{"sku":"VAL-A"}`,
			wantJSON: `{"sku":"VAL-A","limit":50}`,
		},
		{
			name:     "listLots",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryListLotsInput(raw) },
			raw:      `{"unknown":1}`,
			wantJSON: `{}`,
			output:   InventoryListLotsOutput{Lots: []InventoryListLotRow{{ID: uuid, SKU: "VAL-A", LotCode: "LOT-1", BalanceThousandths: 3000, ExpiresAt: inventoryValuationStringPointer("2026-10-01T00:00:00.000Z")}}},
			outputJS: `{"lots":[{"id":"` + uuid + `","sku":"VAL-A","lotCode":"LOT-1","balanceThousandths":3000,"expiresAt":"2026-10-01T00:00:00.000Z"}]}`,
		},
		{
			name:     "rebuildStockProjections",
			parse:    func(raw json.RawMessage) (any, error) { return ParseInventoryRebuildStockProjectionsInput(raw) },
			raw:      `{"unknown":1}`,
			wantJSON: `{}`,
			output:   InventoryRebuildStockProjectionsOutput{Rows: 2, TotalQuantityThousandths: 11000},
			outputJS: `{"rows":2,"totalQuantityThousandths":11000}`,
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

	longMemo := strings.Repeat("m", 301)
	for _, raw := range []string{
		`[]`,
		`{"memo":null}`,
		`{"memo":"ab"}`,
		`{"memo":7}`,
		`{"memo":"` + longMemo + `"}`,
	} {
		if _, err := ParseInventoryPostValuationSummaryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryPostValuationSummaryInput accepted %.40s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"entryId":null}`,
		`{"entryId":"nope"}`,
		`{"entryId":"11111111-1111-0111-8111-111111111111"}`,
	} {
		if _, err := ParseInventoryReverseValuationSummaryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryReverseValuationSummaryInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`{"belowReorderOnly":"yes"}`,
		`{"belowReorderOnly":null}`,
		`{"belowReorderOnly":1}`,
	} {
		if _, err := ParseInventoryStockReportInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryStockReportInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"limit":10}`,
		`{"sku":null}`,
		`{"sku":"VAL-A","limit":0}`,
		`{"sku":"VAL-A","limit":201}`,
		`{"sku":"VAL-A","limit":1.5}`,
		`{"sku":"VAL-A","limit":"5"}`,
		`{"sku":"VAL-A","limit":null}`,
	} {
		if _, err := ParseInventoryItemHistoryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryItemHistoryInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`[1]`,
	} {
		if _, err := ParseInventoryListLotsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryListLotsInput accepted %s", raw)
		}
		if _, err := ParseInventoryRebuildStockProjectionsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseInventoryRebuildStockProjectionsInput accepted %s", raw)
		}
	}

	minimals := map[string]string{
		inventoryPostValuationSummaryCapabilityID:    `{}`,
		inventoryReverseValuationSummaryCapabilityID: `{"entryId":"` + uuid + `"}`,
		inventoryStockReportCapabilityID:             `{}`,
		inventoryItemHistoryCapabilityID:             `{"sku":"VAL-A"}`,
		inventoryListLotsCapabilityID:                `{}`,
		inventoryRebuildStockProjectionsCapabilityID: `{}`,
	}
	for capabilityID, raw := range minimals {
		if _, err := parseInventoryValuationInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseInventoryValuationInput(%s) error = %v", capabilityID, err)
		}
	}
	if _, err := parseInventoryValuationInput("inventory.unknown", json.RawMessage(`{}`)); err == nil {
		t.Error("parseInventoryValuationInput accepted an unsupported capability")
	}
}

func TestInventoryValuationPostSummaryReconcilesGLToLedger(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	claims := inventoryTestClaims(fx)
	seedInventoryValuationAccounts(t, fx, fx.orgID)
	itemID := seedSalesItem(t, fx, fx.orgID, "VAL-CHAIR", "goods")
	base := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 10000, "purchase", inventoryValuationIntPointer(1500), nil, nil, "system", base)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 5000, "purchase", inventoryValuationIntPointer(1000), nil, nil, "system", base.Add(time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, -6000, "sale", nil, nil, nil, "system", base.Add(2*time.Hour))
	now := base.Add(24 * time.Hour)

	seedGLBalance := func(code string, amount int64) {
		t.Helper()
		inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
			_, err := postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
				OrgID: fx.orgID, Memo: "Seed GL balance", SourceType: "manual",
				Currency: "USD", PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID,
				Lines: []JournalEntryLineInput{
					{AccountCode: code, DebitMinor: amount},
					{AccountCode: "5000", CreditMinor: amount},
				},
			})
			return struct{}{}, err
		})
	}
	seedGLBalance("1200", 10000)

	parsedInput, err := ParseInventoryPostValuationSummaryInput(json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if parsedInput.Memo != "Inventory valuation summary - stock ledger to GL" {
		t.Fatalf("default memo = %q, want the zod default", parsedInput.Memo)
	}
	posted := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryPostValuationSummaryOutput, error) {
		return inventoryPostValuationSummary(fx.ctx, tx, claims, parsedInput, now)
	})
	// 15000 + 5000 in, then a 6000 sale leaves 9000 thousandths at 12000 minor.
	if !posted.Posted || posted.EntryID == nil || !isUUID(*posted.EntryID) {
		t.Fatalf("post output = %+v, want a posted entry", posted)
	}
	if posted.LedgerValueMinor != 12000 || posted.GLBalanceMinor != 10000 || posted.VarianceMinor != 2000 {
		t.Fatalf("post amounts = %+v, want ledger 12000 vs GL 10000 (variance 2000)", posted)
	}
	var entry struct {
		Memo       string
		SourceType string
		Currency   string
		ActorType  string
		PostedAt   time.Time
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, currency, posted_by_actor_type, posted_at
		FROM journal_entries WHERE id = $1::uuid`, *posted.EntryID).
		Scan(&entry.Memo, &entry.SourceType, &entry.Currency, &entry.ActorType, &entry.PostedAt); err != nil {
		t.Fatal(err)
	}
	if entry.Memo != "Inventory valuation summary - stock ledger to GL" || entry.SourceType != "inventory-valuation" ||
		entry.Currency != "USD" || entry.ActorType != "human" || !entry.PostedAt.Equal(now) {
		t.Fatalf("posted entry = %+v, want the valuation summary stamped by the actor and now", entry)
	}
	lines := inventoryValuationGLLines(t, fx, *posted.EntryID)
	if lines["1200"] != [2]int64{2000, 0} || lines["5000"] != [2]int64{0, 2000} {
		t.Fatalf("summary lines = %v, want DR 1200 2000 / CR 5000 2000", lines)
	}
	glBalance := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (int64, error) {
		return inventoryGLAccountBalanceMinor(fx.ctx, tx, fx.orgID, "1200")
	})
	if glBalance != 12000 {
		t.Fatalf("GL balance after posting = %d, want 12000", glBalance)
	}

	replay := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryPostValuationSummaryOutput, error) {
		return inventoryPostValuationSummary(fx.ctx, tx, claims, parsedInput, now)
	})
	if replay.Posted || replay.EntryID != nil || replay.VarianceMinor != 0 {
		t.Fatalf("replay post = %+v, want an explicit no-op", replay)
	}
	encoded, err := marshalJS(replay)
	if err != nil || string(encoded) != `{"posted":false,"entryId":null,"varianceMinor":0,"ledgerValueMinor":12000,"glBalanceMinor":12000}` {
		t.Fatalf("no-op JSON = %s, %v", encoded, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='inventory-valuation'`, fx.orgID); got != 1 {
		t.Fatalf("valuation summaries = %d, want only the one posted entry", got)
	}

	seedGLBalance("1200", 3000)
	shrinkage := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryPostValuationSummaryOutput, error) {
		return inventoryPostValuationSummary(fx.ctx, tx, claims, InventoryPostValuationSummaryInput{Memo: "shrinkage check"}, now)
	})
	if !shrinkage.Posted || shrinkage.EntryID == nil || shrinkage.VarianceMinor != -3000 || shrinkage.LedgerValueMinor != 12000 || shrinkage.GLBalanceMinor != 15000 {
		t.Fatalf("shrinkage post = %+v, want variance -3000 against GL 15000", shrinkage)
	}
	lines = inventoryValuationGLLines(t, fx, *shrinkage.EntryID)
	if lines["5000"] != [2]int64{3000, 0} || lines["1200"] != [2]int64{0, 3000} {
		t.Fatalf("shrinkage lines = %v, want DR 5000 3000 / CR 1200 3000", lines)
	}

	foreignItem := seedSalesItem(t, fx, fx.otherOrgID, "VAL-FOREIGN", "goods")
	seedInventoryValuationMovement(t, fx, fx.otherOrgID, foreignItem, 1000, "purchase", inventoryValuationIntPointer(100), nil, nil, "system", base)
	err = inventoryErrInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) error {
		_, err := inventoryPostValuationSummary(fx.ctx, tx, foreignOrgClaims(fx, claims), InventoryPostValuationSummaryInput{Memo: "no chart here"}, now)
		return err
	})
	if err == nil || err.Error() != "account 1200 does not belong to this organization or does not exist" {
		t.Fatalf("foreign org post error = %v, want missing account refusal", err)
	}
}

func foreignOrgClaims(fx *executorFixture, claims authbridge.CapabilityClaims) authbridge.CapabilityClaims {
	return authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: claims.ActorType, ActorID: claims.ActorID}
}

func TestInventoryValuationReverseSummaryMirrorsAndGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	claims := inventoryTestClaims(fx)
	seedInventoryValuationAccounts(t, fx, fx.orgID)
	itemID := seedSalesItem(t, fx, fx.orgID, "VAL-REV", "goods")
	base := time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC)
	now := base.Add(24 * time.Hour)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 20000, "purchase", inventoryValuationIntPointer(1000), nil, nil, "system", base)
	inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Seed GL balance", SourceType: "manual",
			Currency: "USD", PostedAt: base, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1200", DebitMinor: 17000},
				{AccountCode: "5000", CreditMinor: 17000},
			},
		})
		return struct{}{}, err
	})
	summary := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryPostValuationSummaryOutput, error) {
		return inventoryPostValuationSummary(fx.ctx, tx, claims, InventoryPostValuationSummaryInput{Memo: "month close"}, now)
	})
	if !summary.Posted || summary.EntryID == nil {
		t.Fatalf("summary = %+v, want a posted entry", summary)
	}

	reversed := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryReverseValuationSummaryOutput, error) {
		return inventoryReverseValuationSummary(fx.ctx, tx, claims, InventoryReverseValuationSummaryInput{EntryID: *summary.EntryID}, now.Add(time.Hour))
	})
	if !reversed.Reversed || !isUUID(reversed.ReversalEntryID) {
		t.Fatalf("reverse output = %+v, want a mirrored entry", reversed)
	}
	var reversal struct {
		Memo         string
		SourceType   string
		ReversalOfID string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, reversal_of_id::text
		FROM journal_entries WHERE id = $1::uuid`, reversed.ReversalEntryID).
		Scan(&reversal.Memo, &reversal.SourceType, &reversal.ReversalOfID); err != nil {
		t.Fatal(err)
	}
	if reversal.Memo != "Reversal: month close" || reversal.SourceType != "inventory-valuation-reversal" || reversal.ReversalOfID != *summary.EntryID {
		t.Fatalf("reversal entry = %+v, want the mirrored summary bound to its original", reversal)
	}
	lines := inventoryValuationGLLines(t, fx, reversed.ReversalEntryID)
	if lines["1200"] != [2]int64{0, 3000} || lines["5000"] != [2]int64{3000, 0} {
		t.Fatalf("reversal lines = %v, want the exact mirrored entry", lines)
	}
	glBalance := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (int64, error) {
		return inventoryGLAccountBalanceMinor(fx.ctx, tx, fx.orgID, "1200")
	})
	if glBalance != 17000 {
		t.Fatalf("GL balance after reversal = %d, want the pre-posting 17000", glBalance)
	}

	err := inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReverseValuationSummary(fx.ctx, tx, claims, InventoryReverseValuationSummaryInput{EntryID: *summary.EntryID}, now.Add(time.Hour))
		return err
	})
	if err == nil || err.Error() != "entry "+*summary.EntryID+" has already been reversed" {
		t.Fatalf("second reverse error = %v, want already-reversed guard", err)
	}

	manual := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Manual entry", SourceType: "manual",
			Currency: "USD", PostedAt: base, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1200", DebitMinor: 100},
				{AccountCode: "5000", CreditMinor: 100},
			},
		})
	})
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReverseValuationSummary(fx.ctx, tx, claims, InventoryReverseValuationSummaryInput{EntryID: manual}, now.Add(time.Hour))
		return err
	})
	if err == nil || err.Error() != "entry "+manual+" is not an inventory valuation summary" {
		t.Fatalf("foreign source type error = %v, want source-type guard", err)
	}

	unknown := executorUUID(t)
	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryReverseValuationSummary(fx.ctx, tx, claims, InventoryReverseValuationSummaryInput{EntryID: unknown}, now.Add(time.Hour))
		return err
	})
	if err == nil || err.Error() != "no journal entry "+unknown {
		t.Fatalf("unknown entry error = %v, want no journal entry", err)
	}
}

func TestInventoryValuationStockReportAggregatesLedgerTruth(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	itemA := seedInventoryValuationItem(t, fx, fx.orgID, "VAL-A", "goods", 2500, 8000, []string{"promo"})
	itemB := seedInventoryValuationItem(t, fx, fx.orgID, "VAL-B", "goods", 0, 2000, nil)
	seedInventoryValuationItem(t, fx, fx.orgID, "VAL-SVC", "service", 5000, 0, nil)
	itemOld := seedInventoryValuationItem(t, fx, fx.orgID, "VAL-OLD", "goods", 1000, 0, nil)
	foreignItem := seedInventoryValuationItem(t, fx, fx.otherOrgID, "VAL-A", "goods", 100, 0, nil)
	locationID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-A", "Report warehouse")

	base := time.Date(2026, 9, 3, 8, 0, 0, 0, time.UTC)
	seedInventoryValuationArchiveItem(t, fx, itemOld, base.Add(5*time.Hour))
	lotID := seedInventoryValuationLot(t, fx, fx.orgID, itemA, "LOT-A", base)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemA, 20000, "purchase", inventoryValuationIntPointer(1000), &lotID, &locationID, "system", base.Add(time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemA, -5000, "transfer", nil, nil, &locationID, "system", base.Add(2*time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemA, 5000, "transfer", nil, nil, nil, "system", base.Add(3*time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemA, -8000, "sale", nil, nil, nil, "human", base.Add(4*time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemB, 1000, "adjustment", nil, nil, nil, "system", base.Add(time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemOld, 40000, "purchase", inventoryValuationIntPointer(9000), nil, nil, "system", base.Add(time.Hour))
	seedInventoryValuationMovement(t, fx, fx.otherOrgID, foreignItem, 7000, "purchase", inventoryValuationIntPointer(500), nil, nil, "system", base.Add(time.Hour))
	seedInventoryValuationReservation(t, fx, fx.orgID, itemA, "open", 3000)
	seedInventoryValuationReservation(t, fx, fx.orgID, itemA, "released", 5000)
	seedInventoryValuationReservation(t, fx, fx.otherOrgID, foreignItem, "open", 7000)

	report := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryStockReportOutput, error) {
		return inventoryStockReport(fx.ctx, tx, fx.orgID, InventoryStockReportInput{})
	})
	if len(report.Items) != 3 {
		t.Fatalf("stockReport items = %+v, want the three live local items", report.Items)
	}
	// VAL-A: 20000 at 1000, value-neutral transfer legs, then an 8000 sale
	// leaves 12000 thousandths at 12000 minor. VAL-B's uncosted adjustment
	// replays at the replay's average (zero here).
	if report.TotalValueMinor != 12000 {
		t.Fatalf("totalValueMinor = %d, want 12000", report.TotalValueMinor)
	}
	bySKU := make(map[string]InventoryStockReportItem, len(report.Items))
	for index, row := range report.Items {
		if row.SKU == "VAL-OLD" {
			t.Fatalf("archived item leaked into the report at index %d", index)
		}
		bySKU[row.SKU] = row
	}
	if report.Items[0].SKU != "VAL-A" || report.Items[1].SKU != "VAL-B" || report.Items[2].SKU != "VAL-SVC" {
		t.Fatalf("stockReport order = %s,%s,%s, want sku ascending", report.Items[0].SKU, report.Items[1].SKU, report.Items[2].SKU)
	}
	rowA := bySKU["VAL-A"]
	if rowA.OnHandThousandths != 12000 || rowA.ValueMinor != 12000 || rowA.AvgUnitCostMinor != 1000 {
		t.Fatalf("VAL-A row = %+v, want 12000 on hand at 12000 minor (avg 1000)", rowA)
	}
	if rowA.ReservedThousandths != 3000 || rowA.AvailableThousandths != 9000 {
		t.Fatalf("VAL-A availability = %+v, want 3000 reserved and 9000 available", rowA)
	}
	if rowA.ReorderNeeded || rowA.ReorderPointThousandths != 8000 {
		t.Fatalf("VAL-A reorder = %+v, want no reorder above the point", rowA)
	}
	rowB := bySKU["VAL-B"]
	if rowB.OnHandThousandths != 1000 || rowB.ValueMinor != 0 || rowB.AvgUnitCostMinor != 0 {
		t.Fatalf("VAL-B row = %+v, want the uncosted adjustment replayed at zero value", rowB)
	}
	if !rowB.ReorderNeeded {
		t.Fatalf("VAL-B reorder = %+v, want reorder at 1000 against point 2000", rowB)
	}
	rowSVC := bySKU["VAL-SVC"]
	if rowSVC.OnHandThousandths != 0 || rowSVC.ValueMinor != 0 || rowSVC.ReservedThousandths != 0 || rowSVC.AvailableThousandths != 0 {
		t.Fatalf("VAL-SVC row = %+v, want an untouched service at zero", rowSVC)
	}
	encoded, err := marshalJS(rowB)
	if err != nil {
		t.Fatal(err)
	}
	wantB := `{"sku":"VAL-B","name":"VAL-B name","kind":"goods","unitLabel":"each","salePriceMinor":0,"imageUrl":null,"tags":[],"barcode":null,"onHandThousandths":1000,"valueMinor":0,"avgUnitCostMinor":0,"reservedThousandths":0,"availableThousandths":1000,"reorderPointThousandths":2000,"reorderNeeded":true}`
	if string(encoded) != wantB {
		t.Fatalf("VAL-B row JSON = %s, want %s", encoded, wantB)
	}

	below := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryStockReportOutput, error) {
		return inventoryStockReport(fx.ctx, tx, fx.orgID, InventoryStockReportInput{BelowReorderOnly: true})
	})
	if len(below.Items) != 1 || below.Items[0].SKU != "VAL-B" {
		t.Fatalf("belowReorderOnly = %+v, want only VAL-B", below.Items)
	}
	if below.TotalValueMinor != 12000 {
		t.Fatalf("belowReorderOnly total = %d, want the unfiltered 12000", below.TotalValueMinor)
	}

	foreign := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryStockReportOutput, error) {
		return inventoryStockReport(fx.ctx, tx, fx.otherOrgID, InventoryStockReportInput{})
	})
	if len(foreign.Items) != 1 || foreign.Items[0].SKU != "VAL-A" || foreign.Items[0].OnHandThousandths != 7000 || foreign.Items[0].ReservedThousandths != 7000 {
		t.Fatalf("foreign report = %+v, want only the foreign item with its own ledger and reservations", foreign.Items)
	}
	if foreign.TotalValueMinor != 3500 {
		t.Fatalf("foreign total = %d, want 3500", foreign.TotalValueMinor)
	}
}

func TestInventoryValuationStockReportAverageCostUsesDisplayedProjectionLevel(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	itemID := seedInventoryValuationItem(t, fx, fx.orgID, "VAL-PROJECTION", "goods", 0, 0, nil)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 20000, "purchase", inventoryValuationIntPointer(1200), nil, nil, "system", time.Date(2026, 9, 5, 8, 0, 0, 0, time.UTC))
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE stock_balances SET quantity=10000 WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID); err != nil {
		t.Fatal(err)
	}

	report := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryStockReportOutput, error) {
		return inventoryStockReport(fx.ctx, tx, fx.orgID, InventoryStockReportInput{})
	})
	if len(report.Items) != 1 {
		t.Fatalf("stockReport items=%+v, want one projected item", report.Items)
	}
	item := report.Items[0]
	if item.OnHandThousandths != 10000 || item.ValueMinor != 24000 || item.AvgUnitCostMinor != 2400 {
		t.Fatalf("stockReport item=%+v, want displayed 10000 on hand, ledger value 24000, and projection-based average 2400", item)
	}
}

func TestInventoryValuationItemHistoryAndLotsRead(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "VAL-H", "goods")
	foreignItem := seedSalesItem(t, fx, fx.otherOrgID, "VAL-H", "goods")
	locationID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-H", "History warehouse")

	base := time.Date(2026, 9, 4, 8, 0, 0, 0, time.UTC)
	lot1 := seedInventoryValuationLot(t, fx, fx.orgID, itemID, "LOT-1", base)
	lot2 := seedInventoryValuationLot(t, fx, fx.orgID, itemID, "LOT-2", base.Add(time.Hour))
	expiresAt := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE lots SET expires_at = $2 WHERE id = $1::uuid`, lot1, expiresAt); err != nil {
		t.Fatal(err)
	}
	seedInventoryValuationLot(t, fx, fx.otherOrgID, foreignItem, "LOT-FOREIGN", base)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 5000, "purchase", inventoryValuationIntPointer(1200), &lot1, &locationID, "system", base.Add(2*time.Hour))
	seedInventoryValuationNotedMovement(t, fx, fx.orgID, itemID, -2000, "sale", "counter sale", "pos_sale", "human", base.Add(3*time.Hour), &lot1, nil)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 7000, "production", nil, &lot2, nil, "system", base.Add(4*time.Hour))

	history := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryItemHistoryOutput, error) {
		return inventoryItemHistory(fx.ctx, tx, fx.orgID, InventoryItemHistoryInput{SKU: "VAL-H", Limit: 2})
	})
	if len(history.Movements) != 2 {
		t.Fatalf("itemHistory = %+v, want the two newest movements", history.Movements)
	}
	newest := history.Movements[0]
	if newest.QuantityDelta != 7000 || newest.Reason != "production" || newest.LotCode == nil || *newest.LotCode != "LOT-2" ||
		newest.LocationCode != nil || newest.UnitCostMinor != nil || newest.Note != nil || newest.RefType != nil ||
		newest.ActorType != "system" || newest.CreatedAt != "2026-09-04T12:00:00.000Z" {
		t.Fatalf("newest movement = %+v, want the production leg on LOT-2", newest)
	}
	older := history.Movements[1]
	if older.QuantityDelta != -2000 || older.Note == nil || *older.Note != "counter sale" || older.RefType == nil || *older.RefType != "pos_sale" ||
		older.LotCode == nil || *older.LotCode != "LOT-1" || older.LocationCode != nil || older.ActorType != "human" {
		t.Fatalf("second movement = %+v, want the noted sale on LOT-1", older)
	}
	encoded, err := marshalJS(newest)
	if err != nil {
		t.Fatal(err)
	}
	movementID := newest.ID
	if !isUUID(movementID) {
		t.Fatalf("movement id = %s, want a UUID", movementID)
	}
	wantNewest := fmt.Sprintf(`{"id":%q,"quantityDelta":7000,"reason":"production","note":null,"refType":null,"unitCostMinor":null,"lotCode":"LOT-2","locationCode":null,"actorType":"system","createdAt":"2026-09-04T12:00:00.000Z"}`, movementID)
	if string(encoded) != wantNewest {
		t.Fatalf("movement JSON = %s, want %s", encoded, wantNewest)
	}

	err = inventoryErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := inventoryItemHistory(fx.ctx, tx, fx.orgID, InventoryItemHistoryInput{SKU: "NOPE", Limit: 50})
		return err
	})
	if err == nil || err.Error() != "no item with SKU NOPE" {
		t.Fatalf("unknown sku error = %v, want no item with SKU", err)
	}

	lots := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryListLotsOutput, error) {
		return inventoryListLots(fx.ctx, tx, fx.orgID, InventoryListLotsInput{})
	})
	if len(lots.Lots) != 2 {
		t.Fatalf("listLots = %+v, want the two local lots", lots.Lots)
	}
	if lots.Lots[0].LotCode != "LOT-2" || lots.Lots[0].BalanceThousandths != 7000 || lots.Lots[0].SKU != "VAL-H" {
		t.Fatalf("first lot = %+v, want LOT-2 newest with balance 7000", lots.Lots[0])
	}
	if lots.Lots[0].ExpiresAt != nil {
		t.Fatalf("first lot expiresAt = %v, want null", *lots.Lots[0].ExpiresAt)
	}
	if lots.Lots[1].LotCode != "LOT-1" || lots.Lots[1].BalanceThousandths != 3000 || lots.Lots[1].SKU != "VAL-H" {
		t.Fatalf("second lot = %+v, want LOT-1 with balance 3000", lots.Lots[1])
	}
	if lots.Lots[1].ExpiresAt == nil || *lots.Lots[1].ExpiresAt != "2026-10-01T00:00:00.000Z" {
		t.Fatalf("second lot expiresAt = %v, want the millisecond UTC timestamp", lots.Lots[1].ExpiresAt)
	}
	for _, lot := range lots.Lots {
		if lot.ID == "" || !isUUID(lot.ID) {
			t.Fatalf("lot id = %q, want a UUID", lot.ID)
		}
	}
	foreignLots := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryListLotsOutput, error) {
		return inventoryListLots(fx.ctx, tx, fx.otherOrgID, InventoryListLotsInput{})
	})
	if len(foreignLots.Lots) != 1 || foreignLots.Lots[0].LotCode != "LOT-FOREIGN" {
		t.Fatalf("foreign lots = %+v, want only the foreign lot", foreignLots.Lots)
	}
}

func TestInventoryValuationRebuildRepairsProjection(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "VAL-RB", "goods")
	locationA := seedInventoryStockLocation(t, fx, fx.orgID, "WH-RB-A", "Rebuild A")
	locationB := seedInventoryStockLocation(t, fx, fx.orgID, "WH-RB-B", "Rebuild B")
	base := time.Date(2026, 9, 5, 8, 0, 0, 0, time.UTC)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 10000, "purchase", nil, nil, &locationA, "system", base)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 4000, "purchase", nil, nil, &locationB, "system", base.Add(time.Hour))
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, -3000, "sale", nil, nil, &locationA, "system", base.Add(2*time.Hour))
	foreignItem := seedSalesItem(t, fx, fx.otherOrgID, "VAL-RB", "goods")
	seedInventoryValuationMovement(t, fx, fx.otherOrgID, foreignItem, 9000, "purchase", nil, nil, nil, "system", base)

	rebuild := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryRebuildStockProjectionsOutput, error) {
		return inventoryRebuildStockProjections(fx.ctx, tx, fx.orgID, InventoryRebuildStockProjectionsInput{})
	})
	if rebuild.Rows != 2 || rebuild.TotalQuantityThousandths != 11000 {
		t.Fatalf("rebuild = %+v, want 2 projection rows totalling 11000", rebuild)
	}
	encoded, err := marshalJS(rebuild)
	if err != nil || string(encoded) != `{"rows":2,"totalQuantityThousandths":11000}` {
		t.Fatalf("rebuild JSON = %s, %v", encoded, err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM stock_balances WHERE org_id = $1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	drifted := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryStockReportOutput, error) {
		return inventoryStockReport(fx.ctx, tx, fx.orgID, InventoryStockReportInput{})
	})
	if len(drifted.Items) != 1 || drifted.Items[0].OnHandThousandths != 0 {
		t.Fatalf("drifted report = %+v, want the projection reads empty after the wipe", drifted.Items)
	}

	repaired := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InventoryRebuildStockProjectionsOutput, error) {
		return inventoryRebuildStockProjections(fx.ctx, tx, fx.orgID, InventoryRebuildStockProjectionsInput{})
	})
	if repaired.Rows != 2 || repaired.TotalQuantityThousandths != 11000 {
		t.Fatalf("repaired rebuild = %+v, want the projection replayed to 2 rows / 11000", repaired)
	}
	balances := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (map[string]int64, error) {
		rows, err := tx.Query(fx.ctx, `
			SELECT COALESCE(location_id::text, ''), quantity
			FROM stock_balances WHERE org_id = $1::uuid`, fx.orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		quantities := make(map[string]int64)
		for rows.Next() {
			var location string
			var quantity int64
			if err := rows.Scan(&location, &quantity); err != nil {
				return nil, err
			}
			quantities[location] = quantity
		}
		return quantities, rows.Err()
	})
	if balances[""] != 0 || balances[locationA] != 7000 || balances[locationB] != 4000 {
		t.Fatalf("repaired balances = %v, want 7000 at A, 4000 at B, nothing unlocated", balances)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid`, fx.orgID); got != 3 {
		t.Fatalf("movements after rebuild = %d, want the untouched three ledger rows", got)
	}

	empty := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (InventoryRebuildStockProjectionsOutput, error) {
		return inventoryRebuildStockProjections(fx.ctx, tx, fx.otherOrgID, InventoryRebuildStockProjectionsInput{})
	})
	if empty.Rows != 1 || empty.TotalQuantityThousandths != 9000 {
		t.Fatalf("foreign rebuild = %+v, want the foreign org's own single row of 9000", empty)
	}
}

func TestInventoryValuationUsesExactProductsAndRejectsUnsafeTotals(t *testing.T) {
	largeMinor := int64(5_000_000_000_000_000)
	got, err := inventoryJsRoundProductDiv(largeMinor, 1000, 1000)
	if err != nil || got != largeMinor {
		t.Fatalf("exact large rounding = %d, %v, want %d", got, err, largeMinor)
	}
	if got, err = inventoryJsRoundProductDiv(-1500, 1, 1000); err != nil || got != -1 {
		t.Fatalf("negative half rounding = %d, %v, want JavaScript Math.round result -1", got, err)
	}
	if _, err = inventoryJsRoundProductDiv(maxSafeInteger, 1000, 1); err == nil {
		t.Fatal("rounding outside JavaScript's safe integer range must fail")
	}

	state, err := inventoryApplyValuationMovement(inventoryValuationState{}, inventoryValuationMovement{
		quantityDelta: 1000,
		unitCostMinor: &largeMinor,
	})
	if err != nil || state.quantityOnHand != 1000 || state.totalValueMinor != largeMinor {
		t.Fatalf("large inbound movement = %+v, %v", state, err)
	}
	state, err = inventoryApplyValuationMovement(state, inventoryValuationMovement{quantityDelta: -1000})
	if err != nil || state.quantityOnHand != 0 || state.totalValueMinor != 0 {
		t.Fatalf("large outbound movement = %+v, %v", state, err)
	}

	if _, err := inventoryApplyValuationMovement(inventoryValuationState{quantityOnHand: 1000, totalValueMinor: largeMinor}, inventoryValuationMovement{
		quantityDelta: 1000,
		unitCostMinor: &largeMinor,
	}); err == nil {
		t.Fatal("movement that makes the inventory total unsafe must fail closed")
	}
}
