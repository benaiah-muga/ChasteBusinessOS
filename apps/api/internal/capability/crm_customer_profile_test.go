package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGetCRMCustomerProfileParserRequiresAUUID(t *testing.T) {
	input, err := ParseGetCRMCustomerProfileInput(json.RawMessage(`{"customerId":"11111111-1111-4111-8111-111111111111"}`))
	if err != nil || input.CustomerID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("profile parse=%+v err=%v", input, err)
	}
	for _, raw := range []string{`{}`, `{"customerId":"bad"}`, `{"customerId":42}`, `[]`} {
		if _, err := ParseGetCRMCustomerProfileInput(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted invalid profile input %s", raw)
		}
	}
}

func TestGetCRMCustomerProfileIsGovernedScopedAndMatchesTheWebProfile(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'crm.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	canonicalID := seedCRMReadCustomer(t, fx, fx.orgID, "Acme Holdings", "ap@acme.test", nil, nil)
	mergedID := seedCRMReadCustomer(t, fx, fx.orgID, "Acme Old Name", "old@acme.test", nil, &canonicalID)
	foreignID := seedCRMReadCustomer(t, fx, fx.otherOrgID, "Foreign customer", "foreign@fixture.test", nil, nil)
	updatedAt := time.Date(2026, 3, 4, 5, 6, 7, 890_000_000, time.UTC)
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE customers
		SET phone='555-0100', preferred_contact_method='whatsapp', do_not_contact=true,
		    owner_user_id=$2::uuid, tags=ARRAY['vip','renewal'], notes='Call after 3pm', updated_at=$3
		WHERE id=$1::uuid`, canonicalID, fx.userID, updatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE customers SET merged_at=$2 WHERE id=$1::uuid`, mergedID, updatedAt.Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	posSessionID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO pos_sessions (id, org_id) VALUES ($1::uuid, $2::uuid)`, posSessionID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	issuedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE customers SET created_at=$2 WHERE id IN ($1::uuid, $3::uuid)`, canonicalID, issuedAt.Add(-72*time.Hour), mergedID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor,
			paid_minor, credited_minor, pos_session_id, due_at, issued_at)
		VALUES ($1::uuid, $2::uuid, 92001, 'sent', 1600, 100, 1700, 0, 200, $3::uuid, $4, $5)`,
		fx.orgID, mergedID, posSessionID, issuedAt.Add(48*time.Hour), issuedAt); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"customerId":"` + canonicalID + `"}`)
	result, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, crmGetCustomerProfileCapabilityID, input), crmGetCustomerProfileCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("customer profile result=%+v err=%v", result, err)
	}
	var output CRMCustomerProfileOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode customer profile %s: %v", result.Data, err)
	}
	profile := output.Customer
	if profile.ID != canonicalID || profile.Name != "Acme Holdings" || profile.Email == nil || *profile.Email != "ap@acme.test" ||
		profile.Phone == nil || *profile.Phone != "555-0100" || profile.PreferredContactMethod != "whatsapp" || !profile.DoNotContact ||
		profile.OwnerUserID == nil || *profile.OwnerUserID != fx.userID || profile.OwnerName == nil || *profile.OwnerName != "Go capability user" ||
		strings.Join(profile.Tags, ",") != "vip,renewal" || profile.Notes == nil || *profile.Notes != "Call after 3pm" {
		t.Fatalf("profile identity/owner/tags/notes=%+v", profile)
	}
	if profile.PurchaseCount != 1 || profile.LifetimeSpendMinor != 1500 || profile.LastActivityAt != crmCustomerJSDate(issuedAt) {
		t.Fatalf("profile lifetime stats=%+v, want one 1500 spend from the merged source", profile)
	}
	if len(profile.MergedRecords) != 1 || profile.MergedRecords[0].ID != mergedID {
		t.Fatalf("profile merged records=%+v", profile.MergedRecords)
	}

	foreignInput := json.RawMessage(`{"customerId":"` + foreignID + `"}`)
	foreign, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, crmGetCustomerProfileCapabilityID, foreignInput), crmGetCustomerProfileCapabilityID, foreignInput)
	if err == nil || foreign.OK || !strings.Contains(err.Error(), "customer not found") {
		t.Fatalf("foreign profile result=%+v err=%v, want not found", foreign, err)
	}
	missingInput := json.RawMessage(`{"customerId":"` + executorUUID(t) + `"}`)
	missing, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, crmGetCustomerProfileCapabilityID, missingInput), crmGetCustomerProfileCapabilityID, missingInput)
	if err == nil || missing.OK || !strings.Contains(err.Error(), "customer not found") {
		t.Fatalf("missing profile result=%+v err=%v, want not found", missing, err)
	}
	if audits := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2`, fx.orgID, crmGetCustomerProfileCapabilityID); audits != 1 {
		t.Fatalf("customer profile audit events=%d, want one successful read", audits)
	}
}

func TestGetCRMCustomerProfileRequiresCRMRead(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"customerId":"` + executorUUID(t) + `"}`)
	claims := fx.humanClaims(input, "")
	claims.CapabilityID = crmGetCustomerProfileCapabilityID
	claims.Permissions = []string{"sales.read"}
	result, err := fx.executor.Execute(fx.ctx, claims, crmGetCustomerProfileCapabilityID, input)
	if err != nil || result.OK || !strings.Contains(result.Error, "crm.read") {
		t.Fatalf("profile without crm.read result=%+v err=%v, want permission denial", result, err)
	}
}

func TestGetCRMCustomerProfileIsAgentDiscoverable(t *testing.T) {
	found, ok := AgentCapabilityByID(map[string]bool{"crm.read": true}, crmGetCustomerProfileCapabilityID)
	if !ok || found.Risk != "read" || found.Permission != "crm.read" || len(found.InputSchema) == 0 {
		t.Fatalf("customer profile discovery=%+v ok=%t", found, ok)
	}
	for _, tool := range AgentTools(map[string]bool{"crm.read": true}) {
		if tool.ID != crmGetCustomerProfileCapabilityID {
			continue
		}
		if tool.Risk != "read" || tool.Permission != "crm.read" || len(tool.InputSchema) == 0 {
			t.Fatalf("customer profile tool=%+v", tool)
		}
		assertClosedAgentSchema(t, tool.ID, tool.InputSchema)
		return
	}
	t.Fatal("crm.getCustomerProfile is not on the direct agent tool list")
}
