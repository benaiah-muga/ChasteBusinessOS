package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestInventoryCycleCountParsersMirrorZodContracts(t *testing.T) {
	validID := "11111111-1111-4111-8111-111111111111"
	created, err := ParseInventoryCreateCycleCountInput(json.RawMessage(`{"note":"aisle count","skus":["CHAIR-1","DESK-2"],"locationId":"` + validID + `","extra":true}`))
	if err != nil || created.Note == nil || *created.Note != "aisle count" || created.SKUs == nil || len(*created.SKUs) != 2 || created.LocationID == nil || *created.LocationID != validID {
		t.Fatalf("create input = %+v, %v", created, err)
	}
	encoded, err := marshalJS(created)
	if err != nil || string(encoded) != `{"note":"aisle count","skus":["CHAIR-1","DESK-2"],"locationId":"`+validID+`"}` {
		t.Fatalf("create JSON = %s, %v", encoded, err)
	}
	allItems, err := ParseInventoryCreateCycleCountInput(json.RawMessage(`{}`))
	if err != nil || allItems.Note != nil || allItems.SKUs != nil || allItems.LocationID != nil {
		t.Fatalf("create defaults = %+v, %v", allItems, err)
	}
	for _, raw := range []string{
		`[]`,
		`null`,
		`{"note":null}`,
		`{"note":"` + strings.Repeat("n", 201) + `"}`,
		`{"skus":null}`,
		`{"skus":"CHAIR-1"}`,
		`{"skus":[""]}`,
		`{"skus":["` + strings.Repeat("x", 41) + `"]}`,
		`{"locationId":null}`,
		`{"locationId":"nope"}`,
	} {
		if _, err := ParseInventoryCreateCycleCountInput(json.RawMessage(raw)); err == nil {
			t.Errorf("create parser accepted %s", raw)
		}
	}
	recorded, err := ParseInventoryRecordCycleCountsInput(json.RawMessage(`{"countId":"` + validID + `","counts":[{"sku":"CHAIR-1","countedThousandths":0},{"sku":"","countedThousandths":1200}],"extra":1}`))
	if err != nil || recorded.CountID != validID || len(recorded.Counts) != 2 || recorded.Counts[0].CountedThousandths != 0 {
		t.Fatalf("record input = %+v, %v", recorded, err)
	}
	encoded, err = marshalJS(recorded)
	if err != nil || string(encoded) != `{"countId":"`+validID+`","counts":[{"sku":"CHAIR-1","countedThousandths":0},{"sku":"","countedThousandths":1200}]}` {
		t.Fatalf("record JSON = %s, %v", encoded, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"countId":"nope","counts":[{"sku":"S","countedThousandths":1}]}`,
		`{"countId":"` + validID + `","counts":null}`,
		`{"countId":"` + validID + `","counts":[]}`,
		`{"countId":"` + validID + `","counts":[null]}`,
		`{"countId":"` + validID + `","counts":[{"sku":"S"}]}`,
		`{"countId":"` + validID + `","counts":[{"sku":"S","countedThousandths":-1}]}`,
		`{"countId":"` + validID + `","counts":[{"sku":"S","countedThousandths":1.5}]}`,
		`{"countId":"` + validID + `","counts":[{"sku":"S","countedThousandths":9007199254740992}]}`,
	} {
		if _, err := ParseInventoryRecordCycleCountsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("record parser accepted %s", raw)
		}
	}
	for _, raw := range []string{`{}`, `{"countId":null}`, `{"countId":"bad"}`} {
		if _, err := ParseInventoryPostCycleCountInput(json.RawMessage(raw)); err == nil {
			t.Errorf("post parser accepted %s", raw)
		}
		if _, err := ParseInventoryCancelCycleCountInput(json.RawMessage(raw)); err == nil {
			t.Errorf("cancel parser accepted %s", raw)
		}
	}
	for id, raw := range map[string]string{
		inventoryCreateCycleCountCapabilityID:  `{}`,
		inventoryRecordCycleCountsCapabilityID: `{"countId":"` + validID + `","counts":[{"sku":"S","countedThousandths":1}]}`,
		inventoryPostCycleCountCapabilityID:    `{"countId":"` + validID + `"}`,
		inventoryCancelCycleCountCapabilityID:  `{"countId":"` + validID + `"}`,
		inventoryListCycleCountsCapabilityID:   `{}`,
	} {
		if _, err := parseInventoryCycleCountInput(id, json.RawMessage(raw)); err != nil {
			t.Errorf("cycle count dispatch %s: %v", id, err)
		}
	}
	if _, err := parseInventoryCycleCountInput("inventory.noop", json.RawMessage(`{}`)); err == nil {
		t.Error("cycle count dispatcher accepted an unknown capability")
	}
}

func TestInventoryListCycleCountsExecutorOrganizationProjectionAndLimit(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "inventory.read")
	itemID := seedSalesItem(t, fx, fx.orgID, "COUNT-READ-1", "goods")
	secondItemID := seedSalesItem(t, fx, fx.orgID, "COUNT-READ-2", "goods")
	locationID := seedInventoryStockLocation(t, fx, fx.orgID, "COUNT-READ", "Count location")
	base := time.Now().UTC().Truncate(time.Millisecond)
	countIDs := make([]string, 21)
	for index := range countIDs {
		countIDs[index] = executorUUID(t)
		createdAt := base.Add(time.Duration(index) * time.Second)
		status := "open"
		var locationArg any
		var noteArg any
		if index == len(countIDs)-1 {
			status = "posted"
			locationArg = locationID
			noteArg = "Aisle 4"
		}
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO cycle_counts (id, org_id, status, note, location_id, created_at)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)`,
			countIDs[index], fx.orgID, status, noteArg, locationArg, createdAt); err != nil {
			t.Fatal(err)
		}
	}
	for _, line := range []struct {
		itemID   string
		expected int64
		counted  any
	}{{itemID, 500, nil}, {secondItemID, 300, int64(250)}} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO cycle_count_lines (org_id, count_id, item_id, expected_thousandths, counted_thousandths)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
			fx.orgID, countIDs[len(countIDs)-1], line.itemID, line.expected, line.counted); err != nil {
			t.Fatal(err)
		}
	}
	foreignID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO cycle_counts (id, org_id, status, note, created_at)
		VALUES ($1::uuid, $2::uuid, 'open', 'foreign', $3)`, foreignID, fx.otherOrgID, base.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	claims := waveModuleClaims(fx, inventoryListCycleCountsCapabilityID, "inventory.read", input, "human", "", "cycle-count-list")
	result, err := fx.executor.Execute(fx.ctx, claims, inventoryListCycleCountsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("list cycle counts result=%+v err=%v", result, err)
	}
	var output InventoryListCycleCountsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.CycleCounts) != 20 {
		t.Fatalf("cycle count length=%d, want newest 20", len(output.CycleCounts))
	}
	if output.CycleCounts[0].ID != countIDs[20] || output.CycleCounts[len(output.CycleCounts)-1].ID != countIDs[1] {
		t.Fatalf("cycle count order = newest %q oldest %q, want %q then %q", output.CycleCounts[0].ID, output.CycleCounts[len(output.CycleCounts)-1].ID, countIDs[20], countIDs[1])
	}
	if output.CycleCounts[0].Status != "posted" || output.CycleCounts[0].Note == nil || *output.CycleCounts[0].Note != "Aisle 4" || output.CycleCounts[0].LocationCode == nil || *output.CycleCounts[0].LocationCode != "COUNT-READ" {
		t.Fatalf("cycle count header=%+v, want status/note/location projection", output.CycleCounts[0])
	}
	if output.CycleCounts[0].CreatedAt != base.Add(20*time.Second).Format("2006-01-02T15:04:05.000Z") {
		t.Fatalf("createdAt=%q, want UTC millisecond timestamp", output.CycleCounts[0].CreatedAt)
	}
	linesBySKU := make(map[string]InventoryListCycleCountLine)
	for _, line := range output.CycleCounts[0].Lines {
		linesBySKU[line.SKU] = line
	}
	if len(linesBySKU) != 2 || linesBySKU["COUNT-READ-1"].CountedThousandths != nil || linesBySKU["COUNT-READ-1"].VarianceThousandths != nil {
		t.Fatalf("uncounted line projection=%+v, want both values null", linesBySKU["COUNT-READ-1"])
	}
	counted := linesBySKU["COUNT-READ-2"]
	if counted.ExpectedThousandths != 300 || counted.CountedThousandths == nil || *counted.CountedThousandths != 250 || counted.VarianceThousandths == nil || *counted.VarianceThousandths != -50 {
		t.Fatalf("counted line projection=%+v, want expected 300, counted 250, variance -50", counted)
	}
	for _, count := range output.CycleCounts {
		if count.ID == countIDs[0] || count.ID == foreignID {
			t.Fatalf("result includes excluded or foreign count %q", count.ID)
		}
	}
}

func executeInventoryCycleCount(t *testing.T, fx *executorFixture, capabilityID string, raw json.RawMessage, intent string) (Result, error) {
	t.Helper()
	claims := fx.humanClaims(raw, intent)
	claims.CapabilityID = capabilityID
	claims.Permissions = []string{"inventory.write"}
	return fx.executor.Execute(fx.ctx, claims, capabilityID, raw)
}

func TestInventoryCycleCountExecutorLifecycleWatermarkBinScopeAndAudit(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'inventory.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	itemID := seedSalesItem(t, fx, fx.orgID, "COUNT-1", "goods")
	otherItemID := seedSalesItem(t, fx, fx.orgID, "COUNT-2", "goods")
	locationA := seedInventoryStockLocation(t, fx, fx.orgID, "COUNT-A", "Count bin A")
	locationB := seedInventoryStockLocation(t, fx, fx.orgID, "COUNT-B", "Count bin B")
	seedMovement := func(itemID, locationID string, delta int64) {
		t.Helper()
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, location_id, actor_type)
			VALUES ($1::uuid, $2::uuid, $3, 'purchase', $4::uuid, 'human')`, fx.orgID, itemID, delta, locationID); err != nil {
			t.Fatal(err)
		}
	}
	seedMovement(itemID, locationA, 9000)
	seedMovement(itemID, locationB, 5000)
	seedMovement(otherItemID, locationA, 1200)

	createInput := json.RawMessage(fmt.Sprintf(`{"note":"aisle 4","skus":["COUNT-1"],"locationId":%q}`, locationA))
	created, err := executeInventoryCycleCount(t, fx, inventoryCreateCycleCountCapabilityID, createInput, "count-create-once")
	if err != nil || !created.OK || created.PendingApproval {
		t.Fatalf("create result=%+v err=%v", created, err)
	}
	var createdOutput InventoryCreateCycleCountOutput
	if err := json.Unmarshal(created.Data, &createdOutput); err != nil || !isUUID(createdOutput.CountID) || createdOutput.LineCount != 1 {
		t.Fatalf("create data=%s output=%+v err=%v", created.Data, createdOutput, err)
	}
	replay, err := executeInventoryCycleCount(t, fx, inventoryCreateCycleCountCapabilityID, createInput, "count-create-once")
	var replayOutput InventoryCreateCycleCountOutput
	if unmarshalErr := json.Unmarshal(replay.Data, &replayOutput); err != nil || !replay.OK || !replay.Replayed || unmarshalErr != nil || replayOutput != createdOutput {
		t.Fatalf("same-intent replay=%+v err=%v", replay, err)
	}
	var countNote string
	var countLocation *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT note, location_id::text FROM cycle_counts WHERE id=$1::uuid`, createdOutput.CountID).Scan(&countNote, &countLocation); err != nil {
		t.Fatal(err)
	}
	if countNote != "aisle 4" || countLocation == nil || *countLocation != locationA {
		t.Fatalf("stored cycle count note=%q location=%v", countNote, countLocation)
	}
	var expected, expectedMovementCount int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT expected_thousandths, expected_movement_count FROM cycle_count_lines
		WHERE count_id=$1::uuid AND item_id=$2::uuid`, createdOutput.CountID, itemID).Scan(&expected, &expectedMovementCount); err != nil {
		t.Fatal(err)
	}
	if expected != 9000 || expectedMovementCount != 2 {
		t.Fatalf("bin snapshot = quantity %d movement watermark %d, want 9000 and item-global 2", expected, expectedMovementCount)
	}
	if got := fx.count(`SELECT count(*) FROM cycle_count_lines WHERE count_id=$1::uuid`, createdOutput.CountID); got != 1 {
		t.Fatalf("snapshot lines = %d, want only selected SKU", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":count-create-once"); got != 1 {
		t.Fatalf("create receipt count=%d, want one", got)
	}

	foreignCountID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO cycle_counts (id, org_id, note) VALUES ($1::uuid, $2::uuid, 'foreign')`, foreignCountID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	foreignPost := json.RawMessage(fmt.Sprintf(`{"countId":%q}`, foreignCountID))
	if _, err := executeInventoryCycleCount(t, fx, inventoryPostCycleCountCapabilityID, foreignPost, "foreign-cycle-post"); err == nil || !strings.Contains(err.Error(), "no cycle count") {
		t.Fatalf("foreign cycle count error=%v, want tenant-scoped not-found", err)
	}

	recordInput := json.RawMessage(fmt.Sprintf(`{"countId":%q,"counts":[{"sku":"COUNT-1","countedThousandths":7000}]}`, createdOutput.CountID))
	recorded, err := executeInventoryCycleCount(t, fx, inventoryRecordCycleCountsCapabilityID, recordInput, "count-record-drift")
	if err != nil || !recorded.OK || string(recorded.Data) != `{"recorded":1}` {
		t.Fatalf("record result=%+v err=%v", recorded, err)
	}
	claims := inventoryTestClaims(fx)
	for _, delta := range []int64{-1000, 1000} {
		inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (int64, error) {
			return inventoryApplyStockDelta(fx.ctx, tx, fx.orgID, itemID, delta, "adjustment", "net-zero drift probe", nil, nil, &locationA, nil, "human", claims.ActorID)
		})
	}
	postInput := json.RawMessage(fmt.Sprintf(`{"countId":%q}`, createdOutput.CountID))
	if _, err := executeInventoryCycleCount(t, fx, inventoryPostCycleCountCapabilityID, postInput, "count-post-stale"); err == nil || !strings.Contains(err.Error(), "2 movements since") {
		t.Fatalf("stale post error=%v, want net-zero two-movement watermark rejection", err)
	}
	cancelInput := json.RawMessage(fmt.Sprintf(`{"countId":%q}`, createdOutput.CountID))
	cancelled, err := executeInventoryCycleCount(t, fx, inventoryCancelCycleCountCapabilityID, cancelInput, "count-cancel-stale")
	if err != nil || !cancelled.OK || string(cancelled.Data) != `{"cancelled":true}` {
		t.Fatalf("cancel result=%+v err=%v", cancelled, err)
	}

	freshInput := json.RawMessage(fmt.Sprintf(`{"skus":["COUNT-1"],"locationId":%q}`, locationA))
	fresh, err := executeInventoryCycleCount(t, fx, inventoryCreateCycleCountCapabilityID, freshInput, "count-create-fresh")
	if err != nil || !fresh.OK {
		t.Fatalf("fresh count result=%+v err=%v", fresh, err)
	}
	var freshOutput InventoryCreateCycleCountOutput
	if err := json.Unmarshal(fresh.Data, &freshOutput); err != nil {
		t.Fatal(err)
	}
	freshRecord := json.RawMessage(fmt.Sprintf(`{"countId":%q,"counts":[{"sku":"COUNT-1","countedThousandths":7000}]}`, freshOutput.CountID))
	if result, err := executeInventoryCycleCount(t, fx, inventoryRecordCycleCountsCapabilityID, freshRecord, "count-record-fresh"); err != nil || !result.OK {
		t.Fatalf("fresh record result=%+v err=%v", result, err)
	}
	freshPost := json.RawMessage(fmt.Sprintf(`{"countId":%q}`, freshOutput.CountID))
	posted, err := executeInventoryCycleCount(t, fx, inventoryPostCycleCountCapabilityID, freshPost, "count-post-fresh")
	if err != nil || !posted.OK || string(posted.Data) != `{"posted":true,"postedVariances":1,"netVarianceThousandths":-2000}` {
		t.Fatalf("post result=%+v err=%v", posted, err)
	}
	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM cycle_counts WHERE id=$1::uuid`, freshOutput.CountID).Scan(&status); err != nil || status != "posted" {
		t.Fatalf("posted count status=%q err=%v", status, err)
	}
	var refType, note string
	var refID, movementLocation, actorID *string
	var movementDelta int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT ref_type, ref_id::text, location_id::text, quantity_delta, note, actor_id::text
		FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid AND ref_type='cycle_count' AND ref_id=$3::uuid`,
		fx.orgID, itemID, freshOutput.CountID).Scan(&refType, &refID, &movementLocation, &movementDelta, &note, &actorID); err != nil {
		t.Fatal(err)
	}
	if refType != "cycle_count" || refID == nil || *refID != freshOutput.CountID || movementLocation == nil || *movementLocation != locationA ||
		movementDelta != -2000 || note != "cycle count "+freshOutput.CountID[:8]+" variance (bin-scoped)" || actorID == nil || *actorID != fx.userID {
		t.Fatalf("posted adjustment ref=%q/%v location=%v delta=%d note=%q actor=%v", refType, refID, movementLocation, movementDelta, note, actorID)
	}
	var balanceA, balanceB int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT COALESCE(SUM(quantity),0) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid AND location_id=$3::uuid`, fx.orgID, itemID, locationA).Scan(&balanceA); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT COALESCE(SUM(quantity),0) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid AND location_id=$3::uuid`, fx.orgID, itemID, locationB).Scan(&balanceB); err != nil {
		t.Fatal(err)
	}
	if balanceA != 7000 || balanceB != 5000 {
		t.Fatalf("bin balances = A:%d B:%d, want A:7000 B:5000", balanceA, balanceB)
	}
	if _, err := executeInventoryCycleCount(t, fx, inventoryPostCycleCountCapabilityID, freshPost, "count-post-again"); err == nil || !strings.Contains(err.Error(), "cycle count is posted") {
		t.Fatalf("second post error=%v, want posted-state refusal", err)
	}
	if _, err := executeInventoryCycleCount(t, fx, inventoryRecordCycleCountsCapabilityID, freshRecord, "count-record-again"); err == nil || !strings.Contains(err.Error(), "only open counts accept entries") {
		t.Fatalf("record after post error=%v, want posted-state refusal", err)
	}
	if _, err := executeInventoryCycleCount(t, fx, inventoryCancelCycleCountCapabilityID, freshPost, "count-cancel-posted"); err == nil || !strings.Contains(err.Error(), "only open counts can be cancelled") {
		t.Fatalf("cancel after post error=%v, want posted-state refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id IN ($2,$3,$4,$5)`, fx.orgID,
		inventoryCreateCycleCountCapabilityID, inventoryRecordCycleCountsCapabilityID, inventoryPostCycleCountCapabilityID, inventoryCancelCycleCountCapabilityID); got < 6 {
		t.Fatalf("cycle count audit events=%d, want successful governed actions", got)
	}
	if got := fx.count(`SELECT count(*) FROM cycle_count_lines WHERE count_id=$1::uuid AND item_id=$2::uuid`, freshOutput.CountID, otherItemID); got != 0 {
		t.Fatalf("fresh count unexpectedly contains unselected item: %d lines", got)
	}
}

func TestInventoryCycleCountWorkerSystemExecution(t *testing.T) {
	fx := newExecutorFixture(t)
	seedSalesItem(t, fx, fx.orgID, "COUNT-WORKER", "goods")
	input := json.RawMessage(`{"skus":["COUNT-WORKER"]}`)
	intentID := executorUUID(t)
	result, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, inventoryCreateCycleCountCapabilityID, "inventory.write", intentID, "", ""), input)
	if err != nil || !result.OK {
		t.Fatalf("system cycle-count result=%+v err=%v", result, err)
	}
	var output InventoryCreateCycleCountOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !isUUID(output.CountID) || output.LineCount != 1 {
		t.Fatalf("system cycle-count data=%s output=%+v err=%v", result.Data, output, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed' AND actor_type='system' AND actor_id IS NULL AND session_id IS NULL`, fx.orgID, inventoryCreateCycleCountCapabilityID); got != 1 {
		t.Fatalf("system cycle-count audit rows=%d, want one sessionless event", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2 AND capability_id=$3`, fx.orgID, fx.orgID+":"+intentID, inventoryCreateCycleCountCapabilityID); got != 1 {
		t.Fatalf("system cycle-count receipts=%d, want one", got)
	}
}
