package capability

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

const customerViewWriteFilters = `{"status":"active","owner":"all","staleOnly":false,"duplicateOnly":false,"tag":"priority"}`

func TestCustomerViewWriteParsers(t *testing.T) {
	validSave := json.RawMessage(`{"id":"4b833b9a-8f94-462b-bdc2-1aa95734baf4","name":"  Priority  ","filters":` + customerViewWriteFilters + `,"isShared":true,"isPinned":false}`)
	parsedSave, err := ParseSaveCustomerViewInput(validSave)
	if err != nil || parsedSave.Name != "Priority" || parsedSave.ID == nil || !parsedSave.IsShared || parsedSave.IsPinned || parsedSave.Filters.Status != "active" {
		t.Fatalf("parsed save=%+v err=%v", parsedSave, err)
	}

	for name, raw := range map[string]json.RawMessage{
		"missing name":    json.RawMessage(`{"filters":` + customerViewWriteFilters + `,"isShared":true,"isPinned":false}`),
		"invalid UUID":    json.RawMessage(`{"id":"bad","name":"Saved","filters":` + customerViewWriteFilters + `,"isShared":true,"isPinned":false}`),
		"invalid status":  json.RawMessage(`{"name":"Saved","filters":{"status":"unknown","owner":"all","staleOnly":false,"duplicateOnly":false,"tag":""},"isShared":true,"isPinned":false}`),
		"unknown filter":  json.RawMessage(`{"name":"Saved","filters":{"status":"active","owner":"all","staleOnly":false,"duplicateOnly":false,"tag":"","extra":true},"isShared":true,"isPinned":false}`),
		"missing boolean": json.RawMessage(`{"name":"Saved","filters":` + customerViewWriteFilters + `,"isShared":true}`),
		"blank trimmed":   json.RawMessage(`{"name":"  ","filters":` + customerViewWriteFilters + `,"isShared":true,"isPinned":false}`),
		"not object":      json.RawMessage(`[]`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseSaveCustomerViewInput(raw); err == nil {
				t.Fatalf("accepted invalid save input %s", raw)
			}
		})
	}

	validRestore := json.RawMessage(`{"viewId":"4b833b9a-8f94-462b-bdc2-1aa95734baf4","previous":null}`)
	parsedRestore, err := ParseRestoreCustomerViewInput(validRestore)
	if err != nil || parsedRestore.Previous != nil {
		t.Fatalf("parsed restore=%+v err=%v", parsedRestore, err)
	}

	validSnapshot := json.RawMessage(`{"viewId":"4b833b9a-8f94-462b-bdc2-1aa95734baf4","previous":{"id":"4b833b9a-8f94-462b-bdc2-1aa95734baf4","name":"Prior","filters":` + customerViewWriteFilters + `,"isShared":false,"isPinned":true,"createdByUserId":"5c944cab-9f50-4fcd-a058-16507ca63e55"}}`)
	parsedRestore, err = ParseRestoreCustomerViewInput(validSnapshot)
	if err != nil || parsedRestore.Previous == nil || parsedRestore.Previous.Name != "Prior" || !parsedRestore.Previous.IsPinned {
		t.Fatalf("parsed restore snapshot=%+v err=%v", parsedRestore, err)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"previous":null}`),
		json.RawMessage(`{"viewId":"bad","previous":null}`),
		json.RawMessage(`{"viewId":"4b833b9a-8f94-462b-bdc2-1aa95734baf4"}`),
	} {
		if _, err := ParseRestoreCustomerViewInput(raw); err == nil {
			t.Errorf("accepted invalid restore input %s", raw)
		}
	}
}

func TestGoCustomerViewWritesAreOwnedReversibleAndReplaySafe(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addPolicy("crm.*", "read", []string{"money"})

	createInput := json.RawMessage(`{"name":"Priority customers","filters":` + customerViewWriteFilters + `,"isShared":false,"isPinned":true}`)
	created := executeCustomerViewWrite(t, fx, saveCustomerViewCapabilityID, createInput, "crm-view-create")
	if !created.OK || created.PendingApproval {
		t.Fatalf("create saved view=%+v, want direct human success", created)
	}
	var createOutput SaveCustomerViewOutput
	if err := json.Unmarshal(created.Data, &createOutput); err != nil || !isUUID(createOutput.ViewID) || createOutput.Previous != nil {
		t.Fatalf("create output=%+v err=%v, want new view with null previous", createOutput, err)
	}
	assertCustomerViewRow(t, fx, createOutput.ViewID, "Priority customers", false, true, fx.userID)

	createdAgain, err := fx.executor.Execute(fx.ctx, customerViewWriteClaims(fx, saveCustomerViewCapabilityID, createInput, "crm-view-create"), saveCustomerViewCapabilityID, createInput)
	if err != nil || !createdAgain.OK || !createdAgain.Replayed {
		t.Fatalf("create replay=%+v err=%v, want same-intent receipt replay", createdAgain, err)
	}
	if got := fx.count(`SELECT count(*) FROM crm_customer_views WHERE org_id=$1::uuid AND name='Priority customers'`, fx.orgID); got != 1 {
		t.Fatalf("created views=%d, want one after replay", got)
	}

	updateInput := json.RawMessage(`{"id":"` + createOutput.ViewID + `","name":"Shared priority","filters":{"status":"inactive","owner":"unassigned","staleOnly":true,"duplicateOnly":false,"tag":"vip"},"isShared":true,"isPinned":false}`)
	updated := executeCustomerViewWrite(t, fx, saveCustomerViewCapabilityID, updateInput, "crm-view-update")
	if !updated.OK || updated.PendingApproval {
		t.Fatalf("update saved view=%+v, want direct human success", updated)
	}
	var updateOutput SaveCustomerViewOutput
	if err := json.Unmarshal(updated.Data, &updateOutput); err != nil || updateOutput.ViewID != createOutput.ViewID || updateOutput.Previous == nil {
		t.Fatalf("update output=%+v err=%v, want the previous snapshot", updateOutput, err)
	}
	if updateOutput.Previous.Name != "Priority customers" || updateOutput.Previous.CreatedByUserID != fx.userID || updateOutput.Previous.Filters.StaleOnly || updateOutput.Previous.Filters.Status != "active" {
		t.Fatalf("update previous snapshot=%+v, want the original saved-view state", updateOutput.Previous)
	}
	assertCustomerViewRow(t, fx, createOutput.ViewID, "Shared priority", true, false, fx.userID)

	restoreUpdateInput, err := json.Marshal(RestoreCustomerViewInput{ViewID: updateOutput.ViewID, Previous: updateOutput.Previous})
	if err != nil {
		t.Fatal(err)
	}
	restored := executeCustomerViewWrite(t, fx, restoreCustomerViewCapabilityID, restoreUpdateInput, "crm-view-restore-update")
	if !restored.OK || restored.PendingApproval || string(restored.Data) != `{"restored":true}` {
		t.Fatalf("restore update=%+v, want restored true", restored)
	}
	assertCustomerViewRow(t, fx, createOutput.ViewID, "Priority customers", false, true, fx.userID)

	deleteInput, err := json.Marshal(RestoreCustomerViewInput{ViewID: createOutput.ViewID})
	if err != nil {
		t.Fatal(err)
	}
	deleted := executeCustomerViewWrite(t, fx, restoreCustomerViewCapabilityID, deleteInput, "crm-view-delete-created")
	if !deleted.OK || deleted.PendingApproval {
		t.Fatalf("restore new saved view=%+v, want deletion inverse", deleted)
	}
	if got := fx.count(`SELECT count(*) FROM crm_customer_views WHERE id=$1::uuid AND org_id=$2::uuid`, createOutput.ViewID, fx.orgID); got != 0 {
		t.Fatalf("saved view count after null-snapshot inverse=%d, want zero", got)
	}

	otherUserID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Other view owner')`, otherUserID, "crm-view-owner-"+otherUserID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.orgID, otherUserID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = fx.owner.Exec(fx.ctx, `DELETE FROM crm_customer_views WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID)
		_, _ = fx.owner.Exec(fx.ctx, `DELETE FROM users WHERE id=$1::uuid`, otherUserID)
	})
	privateOtherID := seedCustomerViewForWrite(t, fx, fx.orgID, "Private other", otherUserID, false)
	blocked, err := fx.executor.Execute(fx.ctx, customerViewWriteClaims(fx, saveCustomerViewCapabilityID,
		json.RawMessage(`{"id":"`+privateOtherID+`","name":"Take over","filters":`+customerViewWriteFilters+`,"isShared":true,"isPinned":false}`), "crm-view-takeover"),
		saveCustomerViewCapabilityID,
		json.RawMessage(`{"id":"`+privateOtherID+`","name":"Take over","filters":`+customerViewWriteFilters+`,"isShared":true,"isPinned":false}`))
	if err == nil || !strings.Contains(err.Error(), "This private view belongs to another team member") || blocked.OK {
		t.Fatalf("private view takeover result=%+v err=%v, want ownership denial", blocked, err)
	}

	foreignID := seedCustomerViewForWrite(t, fx, fx.otherOrgID, "Foreign view", fx.userID, true)
	foreignDelete := json.RawMessage(`{"viewId":"` + foreignID + `","previous":null}`)
	foreignRestored := executeCustomerViewWrite(t, fx, restoreCustomerViewCapabilityID, foreignDelete, "crm-view-foreign-delete")
	if !foreignRestored.OK || fx.count(`SELECT count(*) FROM crm_customer_views WHERE id=$1::uuid AND org_id=$2::uuid`, foreignID, fx.otherOrgID) != 1 {
		t.Fatal("restore null snapshot changed a view in another organization")
	}
	foreignSnapshot := &CustomerViewSavedSnapshot{ID: foreignID, Name: "Foreign overwritten", Filters: CustomerViewFilter{Status: "active", Owner: "all"}, IsShared: true, CreatedByUserID: fx.userID}
	crossOrgRestore, _ := json.Marshal(RestoreCustomerViewInput{ViewID: foreignID, Previous: foreignSnapshot})
	result, err := fx.executor.Execute(fx.ctx, customerViewWriteClaims(fx, restoreCustomerViewCapabilityID, crossOrgRestore, "crm-view-foreign-restore"), restoreCustomerViewCapabilityID, crossOrgRestore)
	if err == nil || !strings.Contains(err.Error(), "another organization") || result.OK {
		t.Fatalf("cross-org restore result=%+v err=%v, want a scope error", result, err)
	}
}

func executeCustomerViewWrite(t *testing.T, fx *executorFixture, capabilityID string, input json.RawMessage, intent string) Result {
	t.Helper()
	result, err := fx.executor.Execute(fx.ctx, customerViewWriteClaims(fx, capabilityID, input, intent), capabilityID, input)
	if err != nil {
		t.Fatalf("execute %s: %v", capabilityID, err)
	}
	return result
}

func customerViewWriteClaims(fx *executorFixture, capabilityID string, input json.RawMessage, intent string) authbridge.CapabilityClaims {
	claims := fx.humanClaims(input, intent)
	claims.CapabilityID = capabilityID
	claims.Permissions = []string{"crm.write"}
	return claims
}

func seedCustomerViewForWrite(t *testing.T, fx *executorFixture, orgID, name, creatorID string, shared bool) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO crm_customer_views (org_id, name, filters, is_shared, is_pinned, created_by_user_id, updated_by_user_id)
		VALUES ($1::uuid, $2, $3::jsonb, $4, false, $5::uuid, $5::uuid) RETURNING id::text`, orgID, name, customerViewWriteFilters, shared, creatorID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func assertCustomerViewRow(t *testing.T, fx *executorFixture, id, name string, shared, pinned bool, creatorID string) {
	t.Helper()
	var gotName, gotCreator string
	var gotShared, gotPinned bool
	var filters []byte
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name, is_shared, is_pinned, created_by_user_id::text, filters FROM crm_customer_views WHERE id=$1::uuid AND org_id=$2::uuid`, id, fx.orgID).Scan(&gotName, &gotShared, &gotPinned, &gotCreator, &filters); err != nil {
		t.Fatal(err)
	}
	if gotName != name || gotShared != shared || gotPinned != pinned || gotCreator != creatorID {
		t.Fatalf("saved view row name=%q shared=%t pinned=%t creator=%q, want %q %t %t %q", gotName, gotShared, gotPinned, gotCreator, name, shared, pinned, creatorID)
	}
	var filter CustomerViewFilter
	if err := json.Unmarshal(filters, &filter); err != nil || !validCustomerViewFilter(filter) {
		t.Fatalf("saved view filters=%s err=%v", filters, err)
	}
}
