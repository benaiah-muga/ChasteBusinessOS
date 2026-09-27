package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func TestParseCustomerProfileUpdateInputMatchesLegacyNormalization(t *testing.T) {
	customerID := "01234567-89ab-4cde-8fab-0123456789ab"
	ownerID := "11111111-2222-4333-8444-555555555555"
	input, err := ParseCustomerProfileUpdateInput(json.RawMessage(fmt.Sprintf(`{
		"customerIds":[%q],
		"name":"  Customer 😀  ",
		"ownerUserId":%q,
		"addTags":[" First ","first","第二"],
		"removeTags":[],
		"notes":null,
		"phone":"  +256 700  ",
		"preferredContactMethod":"whatsapp",
		"doNotContact":true,
		"ignored":"stripped by the legacy schema"
	}`, customerID, ownerID)))
	if err != nil {
		t.Fatal(err)
	}
	if input.Name != "Customer 😀" || input.Phone == nil || *input.Phone != "+256 700" || input.Notes != nil {
		t.Fatalf("normalized profile input = %+v, want trimmed name/phone and null notes", input)
	}
	if !reflect.DeepEqual(input.AddTags, []string{"First", "first", "第二"}) || !input.RemoveTagsSet || len(input.RemoveTags) != 0 {
		t.Fatalf("normalized tags = add %v remove %v, want preserved order and explicit empty removeTags", input.AddTags, input.RemoveTags)
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var normalized map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		t.Fatal(err)
	}
	if _, exists := normalized["ignored"]; exists {
		t.Fatal("unknown input field survived normalization")
	}
	if string(normalized["notes"]) != "null" {
		t.Fatalf("explicit null notes encoded as %s", normalized["notes"])
	}
}

func TestParseCustomerProfileInputsEnforceLegacySchema(t *testing.T) {
	validID := "01234567-89ab-4cde-8fab-0123456789ab"
	for _, input := range []string{
		`{"customerIds":[],"notes":"x"}`,
		`{"customerIds":["01234567-89ab-0cde-8fab-0123456789ab"],"notes":"x"}`,
		`{"customerIds":["01234567-89ab-4cde-8fab-0123456789ab"],"addTags":["  "]}`,
		`{"customerIds":["01234567-89ab-4cde-8fab-0123456789ab"],"notes":null,"name":""}`,
		`{"customerIds":["01234567-89ab-4cde-8fab-0123456789ab"],"ownerUserId":12}`,
	} {
		if _, err := ParseCustomerProfileUpdateInput(json.RawMessage(input)); err == nil {
			t.Errorf("ParseCustomerProfileUpdateInput(%s) succeeded, want validation error", input)
		}
	}
	input, err := ParseCustomerProfileUpdateInput(json.RawMessage(fmt.Sprintf(`{"customerIds":[%q],"notes":null}`, validID)))
	if err != nil || !input.NotesSet || input.Notes != nil {
		t.Fatalf("nullable-only update = %+v err=%v, want explicit null", input, err)
	}
	if isZodUUID("ffffffff-ffff-ffff-ffff-ffffffffffff") == false || isZodUUID("01234567-89ab-0cde-8fab-0123456789ab") {
		t.Fatal("UUID validator did not match the legacy Zod UUID rules")
	}
}

func profileCapabilityClaims(fx *executorFixture, capabilityID string, input json.RawMessage, intent string, actorType, agentSession string) authbridge.CapabilityClaims {
	claims := fx.claims(input, actorType, agentSession, intent)
	claims.CapabilityID = capabilityID
	return claims
}

func executeProfileCapability(t *testing.T, fx *executorFixture, capabilityID string, input json.RawMessage, intent, actorType, agentSession string) Result {
	t.Helper()
	result, err := fx.executor.Execute(fx.ctx, profileCapabilityClaims(fx, capabilityID, input, intent, actorType, agentSession), capabilityID, input)
	if err != nil {
		t.Fatalf("execute %s: %v", capabilityID, err)
	}
	return result
}

func seedProfileCustomer(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, phone, preferred_contact_method, owner_user_id, tags, notes, do_not_contact)
		VALUES ($1::uuid, 'Original profile', NULL, 'email', NULL, $2::text[], 'Original notes', false)
		RETURNING id::text`, orgID, []string{"Existing", "Remove", "Mixed Case"}).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func TestGoCustomerProfileUpdatesAndInversesMatchLegacy(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedProfileCustomer(t, fx, fx.orgID)
	updateInput := json.RawMessage(fmt.Sprintf(`{"customerIds":[%q],"name":"  Updated profile  ","ownerUserId":%q,"addTags":[" Added ","added","New"],"removeTags":["remove"],"notes":null,"phone":"  +256 700  ","preferredContactMethod":"whatsapp","doNotContact":true,"ignored":"stripped"}`, customerID, fx.userID))
	updated := executeProfileCapability(t, fx, updateCustomerProfilesCapabilityID, updateInput, "profile-update", "human", "")
	if !updated.OK || updated.PendingApproval {
		t.Fatalf("profile update result=%+v, want successful direct human update", updated)
	}
	var changed CustomerProfileUpdateOutput
	if err := json.Unmarshal(updated.Data, &changed); err != nil {
		t.Fatal(err)
	}
	if changed.UpdatedCount != 1 || len(changed.Previous) != 1 {
		t.Fatalf("profile update output=%+v, want one previous snapshot", changed)
	}
	previous := changed.Previous[0]
	if previous.Name == nil || *previous.Name != "Original profile" || previous.OwnerUserID != nil || previous.Notes == nil || *previous.Notes != "Original notes" || previous.Phone != nil || previous.PreferredContactMethod != "email" || previous.DoNotContact {
		t.Fatalf("profile update previous snapshot=%+v, want original profile fields", previous)
	}
	if !reflect.DeepEqual(previous.Tags, []string{"Existing", "Remove", "Mixed Case"}) {
		t.Fatalf("previous tags=%v, want original ordered tags", previous.Tags)
	}
	assertProfileRow(t, fx, customerID, "Updated profile", &fx.userID, []string{"Existing", "Mixed Case", "Added", "New"}, nil, stringPointer("+256 700"), "whatsapp", true)

	restoreInput, err := json.Marshal(CustomerProfileSnapshotsInput{Profiles: changed.Previous})
	if err != nil {
		t.Fatal(err)
	}
	restored := executeProfileCapability(t, fx, restoreCustomerProfilesCapabilityID, restoreInput, "profile-restore", "human", "")
	if !restored.OK || restored.PendingApproval {
		t.Fatalf("profile restore result=%+v, want successful inverse", restored)
	}
	var restoreOutput CustomerProfileUpdateOutput
	if err := json.Unmarshal(restored.Data, &restoreOutput); err != nil {
		t.Fatal(err)
	}
	if len(restoreOutput.Previous) != 1 || restoreOutput.Previous[0].Name == nil || *restoreOutput.Previous[0].Name != "Updated profile" {
		t.Fatalf("restore inverse snapshot=%+v, want the changed profile", restoreOutput.Previous)
	}
	assertProfileRow(t, fx, customerID, "Original profile", nil, []string{"Existing", "Remove", "Mixed Case"}, stringPointer("Original notes"), nil, "email", false)

	reapplyInput, err := json.Marshal(CustomerProfileSnapshotsInput{Profiles: restoreOutput.Previous})
	if err != nil {
		t.Fatal(err)
	}
	reapplied := executeProfileCapability(t, fx, reapplyCustomerProfilesCapabilityID, reapplyInput, "profile-reapply", "human", "")
	if !reapplied.OK || reapplied.PendingApproval {
		t.Fatalf("profile reapply result=%+v, want successful forward inverse", reapplied)
	}
	assertProfileRow(t, fx, customerID, "Updated profile", &fx.userID, []string{"Existing", "Mixed Case", "Added", "New"}, nil, stringPointer("+256 700"), "whatsapp", true)
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id IN ($2,$3,$4)`, fx.orgID, updateCustomerProfilesCapabilityID, restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID); got != 3 {
		t.Fatalf("profile audit events=%d, want one for each update/restore/reapply", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid AND intent_key IN ($2,$3,$4)`, fx.orgID, fx.orgID+":profile-update", fx.orgID+":profile-restore", fx.orgID+":profile-reapply"); got != 3 {
		t.Fatalf("profile receipts=%d, want one for each update/restore/reapply", got)
	}
}

func TestGoCustomerProfileUpdatesEnforceOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	localID := seedProfileCustomer(t, fx, fx.orgID)
	foreignID := seedProfileCustomer(t, fx, fx.otherOrgID)
	var foreignName string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name FROM customers WHERE id = $1::uuid`, foreignID).Scan(&foreignName); err != nil {
		t.Fatal(err)
	}

	foreignUpdate := json.RawMessage(fmt.Sprintf(`{"customerIds":[%q],"name":"Must not cross org"}`, foreignID))
	foreignResult, foreignErr := fx.executor.Execute(fx.ctx, profileCapabilityClaims(fx, updateCustomerProfilesCapabilityID, foreignUpdate, "foreign-profile", "human", ""), updateCustomerProfilesCapabilityID, foreignUpdate)
	if foreignErr == nil || foreignResult.OK {
		t.Fatalf("cross-org profile update result=%+v err=%v, want scoped rejection", foreignResult, foreignErr)
	}
	var afterForeignName string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name FROM customers WHERE id = $1::uuid`, foreignID).Scan(&afterForeignName); err != nil {
		t.Fatal(err)
	}
	if afterForeignName != foreignName {
		t.Fatalf("cross-org profile update changed foreign customer name to %q", afterForeignName)
	}

	nonmemberID := executorUUID(t)
	nonmemberOwner := json.RawMessage(fmt.Sprintf(`{"customerIds":[%q],"ownerUserId":%q}`, localID, nonmemberID))
	if _, err := fx.executor.Execute(fx.ctx, profileCapabilityClaims(fx, updateCustomerProfilesCapabilityID, nonmemberOwner, "nonmember-owner", "human", ""), updateCustomerProfilesCapabilityID, nonmemberOwner); err == nil {
		t.Fatal("profile update accepted an owner who is not an organization member")
	}
	var localOwner *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT owner_user_id::text FROM customers WHERE id = $1::uuid`, localID).Scan(&localOwner); err != nil {
		t.Fatal(err)
	}
	if localOwner != nil {
		t.Fatalf("rejected non-member owner changed customer owner to %q", *localOwner)
	}

	foreignSnapshot := CustomerProfileSnapshot{
		CustomerID:             foreignID,
		Name:                   stringPointer("Tampered cross-org name"),
		Tags:                   []string{},
		PreferredContactMethod: "email",
	}
	foreignSnapshotInput, err := json.Marshal(CustomerProfileSnapshotsInput{Profiles: []CustomerProfileSnapshot{foreignSnapshot}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.executor.Execute(fx.ctx, profileCapabilityClaims(fx, restoreCustomerProfilesCapabilityID, foreignSnapshotInput, "foreign-profile-restore", "human", ""), restoreCustomerProfilesCapabilityID, foreignSnapshotInput); err == nil {
		t.Fatal("profile restore accepted a customer from another organization")
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id IN ($2,$3)`, fx.orgID, updateCustomerProfilesCapabilityID, restoreCustomerProfilesCapabilityID); got != 0 {
		t.Fatalf("rejected profile operations appended %d execution events", got)
	}
}

func TestGoCustomerProfileApprovalReexecutesStoredPayloadOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy("crm.*", "read", nil)
	customerID := seedProfileCustomer(t, fx, fx.orgID)
	input := json.RawMessage(fmt.Sprintf(`{"customerIds":[%q],"name":"Approved profile"}`, customerID))
	agentClaims := profileCapabilityClaims(fx, updateCustomerProfilesCapabilityID, input, "", "agent", fx.agentSession)
	pending, err := fx.executor.Execute(fx.ctx, agentClaims, updateCustomerProfilesCapabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent profile update result=%+v err=%v, want pending approval", pending, err)
	}
	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals WHERE org_id = $1::uuid AND capability_id = $2 AND status = 'pending'`, fx.orgID, updateCustomerProfilesCapabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	approved, err := decider.Decide(fx.ctx, profileCapabilityClaims(fx, updateCustomerProfilesCapabilityID, input, "", "human", ""), ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || !approved.OK || approved.Status != "executed" || approved.Result == nil || !approved.Result.OK {
		t.Fatalf("profile approval result=%+v err=%v, want exact payload to execute once", approved, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND capability_id = $2`, fx.orgID, updateCustomerProfilesCapabilityID); got != 1 {
		t.Fatalf("profile approval rows=%d, want only original request", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2 AND actor_type = 'human'`, fx.orgID, updateCustomerProfilesCapabilityID); got != 1 {
		t.Fatalf("approved profile execution events=%d, want one human execution", got)
	}
	assertProfileRow(t, fx, customerID, "Approved profile", nil, []string{"Existing", "Remove", "Mixed Case"}, stringPointer("Original notes"), nil, "email", false)
}

func TestGoCustomerProfileUpdateRollsBackWhenAuditAppendFails(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedProfileCustomer(t, fx, fx.orgID)
	functionName := "go_profile_fail_ledger_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture profile audit failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop profile fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop profile fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.kind = 'capability.executed' AND NEW.capability_id = '%s')
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, updateCustomerProfilesCapabilityID, functionName)); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(fmt.Sprintf(`{"customerIds":[%q],"name":"Uncommitted profile change"}`, customerID))
	if _, err := fx.executor.Execute(fx.ctx, profileCapabilityClaims(fx, updateCustomerProfilesCapabilityID, input, "profile-audit-failure", "human", ""), updateCustomerProfilesCapabilityID, input); err == nil {
		t.Fatal("profile update succeeded despite audit append failure")
	}
	assertProfileRow(t, fx, customerID, "Original profile", nil, []string{"Existing", "Remove", "Mixed Case"}, stringPointer("Original notes"), nil, "email", false)
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("failed profile update left %d action receipts, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2`, fx.orgID, updateCustomerProfilesCapabilityID); got != 0 {
		t.Fatalf("failed profile update left %d execution events, want none", got)
	}
}

func assertProfileRow(t *testing.T, fx *executorFixture, customerID, wantName string, wantOwner *string, wantTags []string, wantNotes, wantPhone *string, wantMethod string, wantDoNotContact bool) {
	t.Helper()
	var row customerProfileRow
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, name, owner_user_id::text, tags, notes, phone, preferred_contact_method, do_not_contact
		FROM customers WHERE id = $1::uuid`, customerID).
		Scan(&row.CustomerID, &row.Name, &row.OwnerUserID, &row.Tags, &row.Notes, &row.Phone, &row.PreferredContactMethod, &row.DoNotContact); err != nil {
		t.Fatal(err)
	}
	if row.Name != wantName || !reflect.DeepEqual(row.OwnerUserID, wantOwner) || !reflect.DeepEqual(row.Tags, wantTags) || !reflect.DeepEqual(row.Notes, wantNotes) || !reflect.DeepEqual(row.Phone, wantPhone) || row.PreferredContactMethod != wantMethod || row.DoNotContact != wantDoNotContact {
		t.Fatalf("customer profile = %+v, want name=%q owner=%v tags=%v notes=%v phone=%v method=%q doNotContact=%v", row, wantName, wantOwner, wantTags, wantNotes, wantPhone, wantMethod, wantDoNotContact)
	}
}
