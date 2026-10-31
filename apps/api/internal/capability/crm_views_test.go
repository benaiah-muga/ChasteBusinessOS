package capability

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestListCustomerViewsCapabilityContract(t *testing.T) {
	spec, exists := capabilitySpecs[listCustomerViewsCapabilityID]
	if !supportedCapability(listCustomerViewsCapabilityID) || !exists || spec.module != "crm" || spec.permission != "crm.read" || spec.risk != "read" {
		t.Fatalf("crm.listCustomerViews spec=%+v supported=%t, want crm.read read capability", spec, supportedCapability(listCustomerViewsCapabilityID))
	}
	for name, raw := range map[string]json.RawMessage{
		"object":        json.RawMessage(`{}`),
		"object fields": json.RawMessage(`{"ignored":true}`),
	} {
		if _, err := parseListCustomerViewsInput(raw); err != nil {
			t.Errorf("parse %s input: %v", name, err)
		}
	}
	if _, err := parseListCustomerViewsInput(json.RawMessage(`[]`)); err == nil {
		t.Fatal("accepted non-object input")
	}
}

func TestGoCustomerViewReadPreservesVisibilityOrderAndTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{}`)
	deniedClaims := crmReadClaims(fx, listCustomerViewsCapabilityID, input)
	deniedClaims.Permissions = []string{"crm.write"}
	denied, err := fx.executor.Execute(fx.ctx, deniedClaims, listCustomerViewsCapabilityID, input)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: crm.read" {
		t.Fatalf("view read without crm.read result=%+v err=%v", denied, err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'crm.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	otherUserID := executorUUID(t)
	otherEmail := "go-crm-view-" + otherUserID[:8] + "@fixture.test"
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Other CRM view user')`, otherUserID, otherEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.orgID, otherUserID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM crm_customer_views WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("delete CRM view fixture rows: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM users WHERE id = $1::uuid`, otherUserID); err != nil {
			t.Errorf("delete CRM view fixture user: %v", err)
		}
	})

	filters := `{"status":"active","owner":"all","staleOnly":false,"duplicateOnly":false,"tag":"priority"}`
	seedView := func(orgID, creatorID, name string, shared, pinned bool, updatedAt time.Time) string {
		t.Helper()
		var id string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO crm_customer_views (org_id, name, filters, is_shared, is_pinned, created_by_user_id, updated_by_user_id, updated_at)
			VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6::uuid, $6::uuid, $7)
			RETURNING id::text`, orgID, name, filters, shared, pinned, creatorID, updatedAt).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}

	selfPinned := seedView(fx.orgID, fx.userID, "Self pinned", false, true, time.Date(2026, 9, 1, 10, 0, 0, 123000000, time.UTC))
	sharedPinned := seedView(fx.orgID, otherUserID, "Shared pinned", true, true, time.Date(2026, 9, 2, 10, 0, 0, 234000000, time.UTC))
	_ = seedView(fx.orgID, otherUserID, "Other private", false, true, time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC))
	sharedUnpinned := seedView(fx.orgID, otherUserID, "Shared unpinned", true, false, time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC))
	_ = seedView(fx.otherOrgID, fx.userID, "Foreign shared", true, true, time.Date(2026, 9, 5, 10, 0, 0, 0, time.UTC))

	result, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listCustomerViewsCapabilityID, input), listCustomerViewsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("view read result=%+v err=%v", result, err)
	}
	var output ListCustomerViewsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode listCustomerViews output %s: %v", result.Data, err)
	}
	want := []CustomerViewSnapshot{
		{ID: sharedPinned, Name: "Shared pinned", Filters: CustomerViewFilter{Status: "active", Owner: "all", Tag: "priority"}, IsShared: true, IsPinned: true, CreatedByUserID: otherUserID, UpdatedAt: "2026-09-02T10:00:00.234Z"},
		{ID: selfPinned, Name: "Self pinned", Filters: CustomerViewFilter{Status: "active", Owner: "all", Tag: "priority"}, IsShared: false, IsPinned: true, CreatedByUserID: fx.userID, UpdatedAt: "2026-09-01T10:00:00.123Z"},
		{ID: sharedUnpinned, Name: "Shared unpinned", Filters: CustomerViewFilter{Status: "active", Owner: "all", Tag: "priority"}, IsShared: true, IsPinned: false, CreatedByUserID: otherUserID, UpdatedAt: "2026-09-04T10:00:00.000Z"},
	}
	if !reflect.DeepEqual(output.Views, want) {
		t.Fatalf("views=%+v, want shared and caller-private rows in pinned/update order: %+v", output.Views, want)
	}
}
