package capability

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCRMCustomerCollectionIsHumanOnlyAndWellFormed(t *testing.T) {
	spec, exists := capabilitySpecs[listCRMCustomerCollectionCapabilityID]
	if !exists || !supportedCapability(listCRMCustomerCollectionCapabilityID) || spec.module != "crm" || spec.permission != "crm.read" || spec.risk != "read" || !spec.humanOnly {
		t.Fatalf("CRM customer collection spec=%+v supported=%t, want human-only crm.read capability", spec, supportedCapability(listCRMCustomerCollectionCapabilityID))
	}
	for _, raw := range []json.RawMessage{json.RawMessage(`{}`), json.RawMessage(`{"ignored":true}`)} {
		if _, err := ParseListCRMCustomerCollectionInput(raw); err != nil {
			t.Errorf("parse %s: %v", raw, err)
		}
	}
	if _, err := ParseListCRMCustomerCollectionInput(json.RawMessage(`[]`)); err == nil {
		t.Fatal("accepted non-object input")
	}
}

func TestCRMCustomerCollectionCapabilityPreservesWebProfileSemantics(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'crm.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	canonicalID := seedCRMReadCustomer(t, fx, fx.orgID, "Profile customer", "profile@fixture.test", nil, nil)
	inactiveAt := time.Date(2025, 2, 3, 4, 5, 6, 789_000_000, time.UTC)
	inactiveID := seedCRMReadCustomer(t, fx, fx.orgID, "Inactive canonical", "inactive@fixture.test", &inactiveAt, nil)
	mergedID := seedCRMReadCustomer(t, fx, fx.orgID, "Merged source", "merged@fixture.test", nil, &canonicalID)
	foreignID := seedCRMReadCustomer(t, fx, fx.otherOrgID, "Foreign canonical", "foreign@fixture.test", nil, nil)
	mergedAt := time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET merged_at=$2 WHERE id=$1::uuid`, mergedID, mergedAt); err != nil {
		t.Fatal(err)
	}
	profileUpdatedAt := time.Date(2026, 2, 3, 4, 5, 6, 789_000_000, time.UTC)
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE customers SET phone='555-0100', preferred_contact_method='whatsapp', do_not_contact=true,
			owner_user_id=$2::uuid, updated_by_user_id=$2::uuid, tags=ARRAY['vip','wholesale'], notes='Call after 3pm', updated_at=$3
		WHERE id=$1::uuid`, canonicalID, fx.userID, profileUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET updated_by_user_id=$2::uuid WHERE id=$1::uuid`, inactiveID, fx.userID); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET created_at=$2 WHERE id IN ($1::uuid, $3::uuid)`, canonicalID, now.Add(-72*time.Hour), mergedID); err != nil {
		t.Fatal(err)
	}
	posSessionID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO pos_sessions (id, org_id) VALUES ($1::uuid, $2::uuid)`, posSessionID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	dueAt := now.Add(-48 * time.Hour)
	issuedAt := now.Add(-time.Hour)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor,
			paid_minor, credited_minor, pos_session_id, due_at, issued_at)
		VALUES ($1::uuid, $2::uuid, 91001, 'sent', 1600, 100, 1700, 0, 200, $3::uuid, $4, $5)`,
		fx.orgID, mergedID, posSessionID, dueAt, issuedAt); err != nil {
		t.Fatal(err)
	}
	dealUpdatedAt := now.Add(-2 * time.Hour)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO deals (org_id, customer_id, title, updated_at)
		VALUES ($1::uuid, $2::uuid, 'Merged source deal', $3)`, fx.orgID, mergedID, dealUpdatedAt); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	result, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listCRMCustomerCollectionCapabilityID, input), listCRMCustomerCollectionCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("customer collection result=%+v err=%v", result, err)
	}
	var output ListCRMCustomerCollectionOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode customer collection %s: %v", result.Data, err)
	}
	byID := make(map[string]CRMCustomerCollectionItem, len(output.Customers))
	for _, customer := range output.Customers {
		byID[customer.ID] = customer
	}
	profile, ok := byID[canonicalID]
	if !ok {
		t.Fatalf("canonical customer missing: %+v", output.Customers)
	}
	if profile.Name != "Profile customer" || profile.Email == nil || *profile.Email != "profile@fixture.test" ||
		profile.Phone == nil || *profile.Phone != "555-0100" || profile.PreferredContactMethod != "whatsapp" || !profile.DoNotContact ||
		profile.OwnerUserID == nil || *profile.OwnerUserID != fx.userID || profile.OwnerName == nil || *profile.OwnerName != "Go capability user" ||
		profile.UpdatedByUserID == nil || *profile.UpdatedByUserID != fx.userID || profile.UpdatedByName == nil || *profile.UpdatedByName != "Go capability user" ||
		strings.Join(profile.Tags, ",") != "vip,wholesale" || profile.Notes == nil || *profile.Notes != "Call after 3pm" ||
		profile.CreatedAt == "" || profile.UpdatedAt != "2026-02-03T04:05:06.789Z" || profile.DeactivatedAt != nil {
		t.Fatalf("profile fields do not match the web collection contract: %+v", profile)
	}
	if len(profile.MergedRecords) != 1 || profile.MergedRecords[0].ID != mergedID || profile.MergedRecords[0].Name != "Merged source" ||
		profile.MergedRecords[0].MergedAt == nil || *profile.MergedRecords[0].MergedAt != "2026-01-02T03:04:05.678Z" {
		t.Fatalf("merged records=%+v", profile.MergedRecords)
	}
	if profile.PurchaseCount != 1 || profile.LifetimeSpendMinor != 1500 || profile.LastActivityAt != crmCustomerJSDate(issuedAt) {
		t.Fatalf("purchase/activity stats=%+v", profile)
	}
	wantDays := int(now.Sub(dueAt).Hours() / 24)
	wantSummary := "Invoice #91001 is overdue by " + strconv.Itoa(wantDays) + "d"
	if profile.NextStep == nil || profile.NextStep.Kind != "invoice" || profile.NextStep.RefID == "" || profile.NextStep.Summary != wantSummary ||
		profile.NextStep.AmountMinor == nil || *profile.NextStep.AmountMinor != 1500 {
		t.Fatalf("next step=%+v, want overdue invoice candidate %q", profile.NextStep, wantSummary)
	}
	inactive, ok := byID[inactiveID]
	if !ok || inactive.DeactivatedAt == nil || *inactive.DeactivatedAt != "2025-02-03T04:05:06.789Z" || inactive.MergedRecords == nil {
		t.Fatalf("inactive canonical record=%+v present=%t", inactive, ok)
	}
	if _, exists := byID[mergedID]; exists {
		t.Fatal("merged source was returned as a canonical customer")
	}
	if _, exists := byID[foreignID]; exists {
		t.Fatal("customer collection leaked another organization")
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO customers (org_id, name, email)
		SELECT $1::uuid, 'Bulk customer ' || n, 'bulk-' || n || '@fixture.test'
		FROM generate_series(1, 505) AS n`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	limited, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listCRMCustomerCollectionCapabilityID, input), listCRMCustomerCollectionCapabilityID, input)
	if err != nil || !limited.OK {
		t.Fatalf("limited customer collection result=%+v err=%v", limited, err)
	}
	if err := json.Unmarshal(limited.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Customers) != 500 {
		t.Fatalf("customer collection returned %d rows, want the legacy 500-row maximum", len(output.Customers))
	}
}

func TestCRMCustomerCollectionCapabilityRejectsAgentClaims(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{}`)
	claims := crmReadClaims(fx, listCRMCustomerCollectionCapabilityID, input)
	claims.ActorType = "agent"
	result, err := fx.executor.Execute(fx.ctx, claims, listCRMCustomerCollectionCapabilityID, input)
	if err != nil || result.OK || !strings.Contains(result.Error, "human session") {
		t.Fatalf("agent customer collection result=%+v err=%v, want human-session denial", result, err)
	}
}
