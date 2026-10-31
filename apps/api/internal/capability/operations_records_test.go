package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOperationalRecordsPersistDeduplicateAndCard(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'operations.write', $2::uuid), ($1::uuid, 'operations.read', $2::uuid)`,
		fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	execute := func(input string) Result {
		raw := json.RawMessage(input)
		claims := fx.humanClaims(raw, "operations-record-"+executorUUID(t))
		claims.CapabilityID = upsertOperationalRecordCapabilityID
		claims.Permissions = []string{"operations.write", "operations.read"}
		result, err := fx.executor.Execute(fx.ctx, claims, upsertOperationalRecordCapabilityID, raw)
		if err != nil || !result.OK {
			t.Fatalf("upsert result=%+v err=%v", result, err)
		}
		return result
	}
	execute(`{"kind":"exception","stableKey":"inventory:low-stock:CEM-1","status":"open","title":"CEM-1 below reorder point","summary":"Available stock is below the reorder point.","details":{"severity":"high","next":"Prepare a purchase proposal","evidence":{"sku":"CEM-1","available":5000}}} `)
	second := execute(`{"kind":"exception","stableKey":"inventory:low-stock:CEM-1","status":"acknowledged","title":"CEM-1 below reorder point","summary":"Owner acknowledged the stock risk.","details":{"severity":"high","next":"Approve the proposal"},"ownerUserId":"` + fx.userID + `"}`)
	var record struct {
		ID          string  `json:"id"`
		Revision    int     `json:"revision"`
		Status      string  `json:"status"`
		OwnerUserID *string `json:"ownerUserId"`
		Card        struct {
			Kind     string `json:"kind"`
			Severity string `json:"severity"`
			Next     string `json:"next"`
		} `json:"card"`
	}
	if err := json.Unmarshal(second.Data, &record); err != nil {
		t.Fatal(err)
	}
	if record.Revision != 2 || record.Status != "acknowledged" || record.Card.Kind != "exception" || record.Card.Severity != "high" {
		t.Fatalf("second record = %+v", record)
	}
	if record.OwnerUserID == nil || *record.OwnerUserID != fx.userID {
		t.Fatalf("owner = %v, want the assigned member %s", record.OwnerUserID, fx.userID)
	}

	foreignUser := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Foreign owner')`, foreignUser, "foreign-owner-"+foreignUser[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	foreignRaw := json.RawMessage(`{"kind":"exception","stableKey":"inventory:low-stock:FOREIGN","status":"open","title":"Foreign owner probe","ownerUserId":"` + foreignUser + `"}`)
	foreignClaims := fx.humanClaims(foreignRaw, "operations-foreign-owner-"+executorUUID(t))
	foreignClaims.CapabilityID = upsertOperationalRecordCapabilityID
	foreignClaims.Permissions = []string{"operations.write", "operations.read"}
	_, foreignErr := fx.executor.Execute(fx.ctx, foreignClaims, upsertOperationalRecordCapabilityID, foreignRaw)
	if foreignErr == nil || !strings.Contains(foreignErr.Error(), "owner must be a member of this organization") {
		t.Fatalf("foreign owner error = %v, want membership refusal", foreignErr)
	}
	if got := fx.count(`SELECT count(*) FROM operational_records WHERE org_id = $1::uuid AND kind = 'exception'`, fx.orgID); got != 1 {
		t.Fatalf("exception rows = %d, want one deduplicated record", got)
	}
	getRaw := json.RawMessage(`{"kind":"exception","stableKey":"inventory:low-stock:CEM-1"}`)
	claims := fx.humanClaims(getRaw, "operations-get-"+executorUUID(t))
	claims.CapabilityID = getOperationalRecordCapabilityID
	claims.Permissions = []string{"operations.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, getOperationalRecordCapabilityID, getRaw)
	if err != nil || !result.OK {
		t.Fatalf("get result=%+v err=%v", result, err)
	}
	var fetched struct {
		ID   string `json:"id"`
		Card struct {
			Kind string `json:"kind"`
		} `json:"card"`
	}
	if err := json.Unmarshal(result.Data, &fetched); err != nil {
		t.Fatal(err)
	}
	if fetched.ID != record.ID || fetched.Card.Kind != "exception" {
		t.Fatalf("fetched=%+v want id=%s card=exception", fetched, record.ID)
	}

	decision := execute(`{"kind":"decision","stableKey":"inventory:low-stock:CEM-1:decision","status":"recorded","title":"Buy 10 bags from Acme","summary":"Prepared the governed purchase proposal.","details":{"alternatives":["wait","alternate supplier"],"recommendation":"Acme at 500000 minor per bag","actions":["purchase order prepared"],"verifiedResult":{"status":"pending approval"}}}`)
	var decisionRecord struct {
		Card struct {
			Kind string `json:"kind"`
		} `json:"card"`
	}
	if err := json.Unmarshal(decision.Data, &decisionRecord); err != nil {
		t.Fatal(err)
	}
	if decisionRecord.Card.Kind != "result" {
		t.Fatalf("decision card kind=%q, want result", decisionRecord.Card.Kind)
	}
}
