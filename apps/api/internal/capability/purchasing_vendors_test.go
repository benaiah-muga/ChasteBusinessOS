package capability

import (
	"encoding/json"
	"testing"
)

func TestPurchasingListVendorsInputContract(t *testing.T) {
	defaults, err := ParsePurchasingListVendorsInput(json.RawMessage(`{}`))
	if err != nil || defaults.IncludeInactive {
		t.Fatalf("defaults=%+v err=%v", defaults, err)
	}
	include, err := ParsePurchasingListVendorsInput(json.RawMessage(`{"includeInactive":true}`))
	if err != nil || !include.IncludeInactive {
		t.Fatalf("includeInactive=%+v err=%v", include, err)
	}
	for name, raw := range map[string]string{
		"unknown field": `{"activeOnly":true}`,
		"null flag":     `{"includeInactive":null}`,
		"string flag":   `{"includeInactive":"true"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParsePurchasingListVendorsInput(json.RawMessage(raw)); err == nil {
				t.Fatalf("expected %s to be rejected", raw)
			}
		})
	}
}

func TestPurchasingListVendorsReadsActiveSuppliersWithinTenant(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'purchasing.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	for _, vendor := range []struct {
		orgID    string
		name     string
		inactive bool
	}{
		{fx.orgID, "Active supplier", false},
		{fx.orgID, "Retired supplier", true},
		{fx.otherOrgID, "Foreign supplier", false},
	} {
		var err error
		if vendor.inactive {
			_, err = fx.owner.Exec(fx.ctx, `INSERT INTO vendors (org_id, name, deactivated_at) VALUES ($1::uuid, $2, now())`, vendor.orgID, vendor.name)
		} else {
			_, err = fx.owner.Exec(fx.ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, $2)`, vendor.orgID, vendor.name)
		}
		if err != nil {
			t.Fatal(err)
		}
	}

	run := func(input json.RawMessage) PurchasingListVendorsOutput {
		t.Helper()
		claims := fx.humanClaims(input, "list-vendors-"+executorUUID(t))
		claims.CapabilityID = purchasingListVendorsCapabilityID
		claims.Permissions = []string{"purchasing.read"}
		result, err := fx.executor.Execute(fx.ctx, claims, purchasingListVendorsCapabilityID, input)
		if err != nil {
			t.Fatal(err)
		}
		if !result.OK {
			t.Fatalf("listVendors refused: %s", result.Error)
		}
		var output PurchasingListVendorsOutput
		if err := json.Unmarshal(result.Data, &output); err != nil {
			t.Fatal(err)
		}
		return output
	}

	active := run(json.RawMessage(`{}`))
	if len(active.Vendors) != 1 || active.Vendors[0].Name != "Active supplier" || !active.Vendors[0].Active {
		t.Fatalf("active vendors=%+v, want only the active organization supplier", active.Vendors)
	}
	all := run(json.RawMessage(`{"includeInactive":true}`))
	if len(all.Vendors) != 2 {
		t.Fatalf("all vendors=%+v, want active and retired suppliers", all.Vendors)
	}
	for _, vendor := range all.Vendors {
		if vendor.Name == "Foreign supplier" {
			t.Fatal("listVendors leaked another tenant's supplier")
		}
	}
}
