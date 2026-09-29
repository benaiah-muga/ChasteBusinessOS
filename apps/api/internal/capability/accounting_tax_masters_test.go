package capability

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestAccountingTaxMastersParsersMirrorZodContracts(t *testing.T) {
	profileID := "22222222-2222-4222-8222-222222222222"
	taxCodeID := "33333333-3333-4333-8333-333333333333"

	profile, err := ParseCreateTaxProfileInput(json.RawMessage(`{"jurisdictionCode":"US-CA","registrationNumber":"12-3456789","filingFrequency":"quarterly","unknown":true}`))
	if err != nil || profile.JurisdictionCode != "US-CA" || profile.RegistrationNumber == nil || *profile.RegistrationNumber != "12-3456789" || profile.FilingFrequency != "quarterly" {
		t.Fatalf("ParseCreateTaxProfileInput() = %+v, %v", profile, err)
	}
	if encoded, err := marshalJS(profile); err != nil || string(encoded) != `{"jurisdictionCode":"US-CA","registrationNumber":"12-3456789","filingFrequency":"quarterly"}` {
		t.Fatalf("CreateTaxProfileInput JSON = %s, %v", encoded, err)
	}
	bareProfile, err := ParseCreateTaxProfileInput(json.RawMessage(`{"jurisdictionCode":"US","filingFrequency":"monthly"}`))
	if err != nil || bareProfile.RegistrationNumber != nil {
		t.Fatalf("minimal profile input=%+v err=%v, want absent registration", bareProfile, err)
	}
	if encoded, err := marshalJS(bareProfile); err != nil || string(encoded) != `{"jurisdictionCode":"US","filingFrequency":"monthly"}` {
		t.Fatalf("minimal profile JSON = %s, %v", encoded, err)
	}
	for _, raw := range []string{
		`[]`,
		`"x"`,
		`{}`,
		`{"jurisdictionCode":null,"filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"usa","filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"U","filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"USA","filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"US-","filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"US-ABC123456","filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"US","registrationNumber":null,"filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"US","registrationNumber":5,"filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"US","registrationNumber":"` + strings.Repeat("r", 101) + `","filingFrequency":"monthly"}`,
		`{"jurisdictionCode":"US"}`,
		`{"jurisdictionCode":"US","filingFrequency":null}`,
		`{"jurisdictionCode":"US","filingFrequency":"weekly"}`,
		`{"jurisdictionCode":"US","filingFrequency":"MONTHLY"}`,
	} {
		if _, err := ParseCreateTaxProfileInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateTaxProfileInput accepted %s", raw)
		}
	}

	removed, err := ParseRemoveTaxProfileInput(json.RawMessage(`{"profileId":"` + profileID + `","unknown":1}`))
	if err != nil || removed != (RemoveTaxProfileInput{ProfileID: profileID}) {
		t.Fatalf("ParseRemoveTaxProfileInput() = %+v, %v", removed, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"profileId":null}`,
		`{"profileId":"nope"}`,
		`{"profileId":"11111111-1111-1111-1111-111111111111"}`,
	} {
		if _, err := ParseRemoveTaxProfileInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseRemoveTaxProfileInput accepted %s", raw)
		}
	}

	code, err := ParseCreateTaxCodeInput(json.RawMessage(`{"code":"VAT","name":"Value added tax","direction":"output","rateBasisPoints":1500,"unknown":true}`))
	if err != nil || code != (CreateTaxCodeInput{Code: "VAT", Name: "Value added tax", Direction: "output", RateBasisPoints: 1500, PriceIncludesTax: false, Recoverable: true}) {
		t.Fatalf("ParseCreateTaxCodeInput() = %+v, %v", code, err)
	}
	if encoded, err := marshalJS(code); err != nil || string(encoded) != `{"code":"VAT","name":"Value added tax","direction":"output","rateBasisPoints":1500,"priceIncludesTax":false,"recoverable":true}` {
		t.Fatalf("CreateTaxCodeInput JSON = %s, %v", encoded, err)
	}
	explicit, err := ParseCreateTaxCodeInput(json.RawMessage(`{"code":"INP-STANDARD","name":"Recoverable input tax","direction":"input","rateBasisPoints":1000000,"priceIncludesTax":true,"recoverable":false}`))
	if err != nil || explicit != (CreateTaxCodeInput{Code: "INP-STANDARD", Name: "Recoverable input tax", Direction: "input", RateBasisPoints: 1_000_000, PriceIncludesTax: true, Recoverable: false}) {
		t.Fatalf("explicit ParseCreateTaxCodeInput() = %+v, %v", explicit, err)
	}
	longCode := strings.Repeat("V", 25)
	longName := strings.Repeat("n", 101)
	for _, raw := range []string{
		`{}`,
		`{"code":null,"name":"VAT standard","direction":"output","rateBasisPoints":0}`,
		`{"code":"","name":"VAT standard","direction":"output","rateBasisPoints":0}`,
		`{"code":"vat","name":"VAT standard","direction":"output","rateBasisPoints":0}`,
		`{"code":"V A T","name":"VAT standard","direction":"output","rateBasisPoints":0}`,
		`{"code":"` + longCode + `","name":"VAT standard","direction":"output","rateBasisPoints":0}`,
		`{"code":"VAT","direction":"output","rateBasisPoints":0}`,
		`{"code":"VAT","name":"A","direction":"output","rateBasisPoints":0}`,
		`{"code":"VAT","name":"` + longName + `","direction":"output","rateBasisPoints":0}`,
		`{"code":"VAT","name":"VAT standard","rateBasisPoints":0}`,
		`{"code":"VAT","name":"VAT standard","direction":"both","rateBasisPoints":0}`,
		`{"code":"VAT","name":"VAT standard","direction":"output"}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":-1}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":1000001}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":1.5}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":null}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":0,"priceIncludesTax":null}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":0,"priceIncludesTax":"yes"}`,
		`{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":0,"recoverable":null}`,
	} {
		if _, err := ParseCreateTaxCodeInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateTaxCodeInput accepted %s", raw)
		}
	}

	archived, err := ParseArchiveTaxCodeInput(json.RawMessage(`{"taxCodeId":"` + taxCodeID + `"}`))
	if err != nil || archived != (ArchiveTaxCodeInput{TaxCodeID: taxCodeID}) {
		t.Fatalf("ParseArchiveTaxCodeInput() = %+v, %v", archived, err)
	}
	activated, err := ParseActivateTaxCodeInput(json.RawMessage(`{"taxCodeId":"` + taxCodeID + `","unknown":[]}`))
	if err != nil || activated != (ActivateTaxCodeInput{TaxCodeID: taxCodeID}) {
		t.Fatalf("ParseActivateTaxCodeInput() = %+v, %v", activated, err)
	}
	for _, parse := range []func(json.RawMessage) (any, error){
		func(raw json.RawMessage) (any, error) { return ParseArchiveTaxCodeInput(raw) },
		func(raw json.RawMessage) (any, error) { return ParseActivateTaxCodeInput(raw) },
	} {
		for _, raw := range []string{
			`{}`,
			`{"taxCodeId":null}`,
			`{"taxCodeId":"nope"}`,
			`{"taxCodeId":"11111111-1111-1111-1111-111111111111"}`,
		} {
			if _, err := parse(json.RawMessage(raw)); err == nil {
				t.Errorf("tax code lifecycle parser accepted %s", raw)
			}
		}
	}

	validByCapability := map[string]string{
		createTaxProfileCapabilityID: `{"jurisdictionCode":"US","filingFrequency":"monthly"}`,
		removeTaxProfileCapabilityID: `{"profileId":"` + profileID + `"}`,
		createTaxCodeCapabilityID:    `{"code":"VAT","name":"VAT standard","direction":"output","rateBasisPoints":0}`,
		archiveTaxCodeCapabilityID:   `{"taxCodeId":"` + taxCodeID + `"}`,
		activateTaxCodeCapabilityID:  `{"taxCodeId":"` + taxCodeID + `"}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingTaxMasterInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingTaxMasterInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingTaxMasterInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingTaxMasterInput accepted an unsupported capability")
	}
}

func taxMasterClaims(fx *executorFixture, orgID string) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: orgID, ActorType: "human", ActorID: &actorID}
}

func seedTaxMasterProfile(t *testing.T, fx *executorFixture, orgID, jurisdiction string, registration *string, frequency string) string {
	t.Helper()
	var profileID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tax_profiles (org_id, jurisdiction_code, registration_number, filing_frequency)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, jurisdiction, registration, frequency).Scan(&profileID); err != nil {
		t.Fatal(err)
	}
	return profileID
}

func seedTaxMasterCode(t *testing.T, fx *executorFixture, orgID, jurisdiction, code, direction string, rateBasisPoints int64, active bool) string {
	t.Helper()
	var taxCodeID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tax_codes (org_id, jurisdiction_code, code, name, direction, rate_basis_points, active)
		VALUES ($1::uuid, $2, $3, $3, $4, $5, $6)
		RETURNING id::text`, orgID, jurisdiction, code, direction, rateBasisPoints, active).Scan(&taxCodeID); err != nil {
		t.Fatal(err)
	}
	return taxCodeID
}

// cleanupTaxMasterFixtures removes seeded tax rows before the fixture drops
// the organizations: codes before profiles, matching reference order.
func cleanupTaxMasterFixtures(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin tax master fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `DELETE FROM tax_codes WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("delete tax master fixture codes: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM tax_profiles WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("delete tax master fixture profiles: %v", err)
			return
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit tax master fixture cleanup: %v", err)
		}
	})
}

func TestAccountingTaxMastersProfileLifecycleGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupTaxMasterFixtures(t, fx)
	claims := taxMasterClaims(fx, fx.orgID)

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "VAT", Name: "VAT standard", Direction: "output", RateBasisPoints: 1500})
	}); err == nil || err.Error() != "set a tax jurisdiction before creating tax codes" {
		t.Fatalf("createTaxCode without a profile error = %v, want jurisdiction guard", err)
	}

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxProfileOutput, error) {
		return executeCreateTaxProfile(fx.ctx, tx, claims, CreateTaxProfileInput{JurisdictionCode: "US", FilingFrequency: "monthly"})
	})
	if err != nil {
		t.Fatalf("createTaxProfile: %v", err)
	}
	if !isUUID(created.ProfileID) || created.JurisdictionCode != "US" || created.RegistrationNumber != nil || created.FilingFrequency != "monthly" {
		t.Fatalf("createTaxProfile output = %+v, want minimal profile", created)
	}
	encoded, err := marshalJS(created)
	if err != nil || string(encoded) != `{"profileId":"`+created.ProfileID+`","jurisdictionCode":"US","registrationNumber":null,"filingFrequency":"monthly"}` {
		t.Fatalf("createTaxProfile output JSON = %s, %v", encoded, err)
	}
	var jurisdiction, providerMode, filingFrequency string
	var registration *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT jurisdiction_code, registration_number, filing_frequency, provider_mode
		FROM tax_profiles WHERE id = $1::uuid AND org_id = $2::uuid`, created.ProfileID, fx.orgID).
		Scan(&jurisdiction, &registration, &filingFrequency, &providerMode); err != nil {
		t.Fatal(err)
	}
	if jurisdiction != "US" || registration != nil || filingFrequency != "monthly" || providerMode != "manual" {
		t.Fatalf("stored profile = jurisdiction=%s registration=%v frequency=%s mode=%s", jurisdiction, registration, filingFrequency, providerMode)
	}

	duplicate := CreateTaxProfileInput{JurisdictionCode: "DE-BY", RegistrationNumber: crmStringPointer("DE-987"), FilingFrequency: "quarterly"}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxProfileOutput, error) {
		return executeCreateTaxProfile(fx.ctx, tx, claims, duplicate)
	}); err == nil || err.Error() != "a tax profile is already set; use the Settings workflow to change it after existing tax codes and returns are reviewed" {
		t.Fatalf("duplicate createTaxProfile error = %v, want uniqueness guard", err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_profiles WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("tax profiles = %d, want the single original row", got)
	}

	vat, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "VAT", Name: "VAT standard", Direction: "output", RateBasisPoints: 1500})
	})
	if err != nil {
		t.Fatalf("createTaxCode(VAT): %v", err)
	}
	if !isUUID(vat.TaxCodeID) || vat.Code != "VAT" || vat.JurisdictionCode != "US" || vat.Direction != "output" || vat.RateBasisPoints != 1500 {
		t.Fatalf("createTaxCode output = %+v", vat)
	}
	if encoded, err := marshalJS(vat); err != nil || string(encoded) != `{"taxCodeId":"`+vat.TaxCodeID+`","code":"VAT","jurisdictionCode":"US","direction":"output","rateBasisPoints":1500}` {
		t.Fatalf("createTaxCode output JSON = %s, %v", encoded, err)
	}
	inputCode, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "INP", Name: "Recoverable input tax", Direction: "input", RateBasisPoints: 700, PriceIncludesTax: true, Recoverable: true})
	})
	if err != nil {
		t.Fatalf("createTaxCode(INP): %v", err)
	}
	nonRecoverable, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "INN", Name: "Nonrecoverable input tax", Direction: "input", RateBasisPoints: 0, Recoverable: false})
	})
	if err != nil {
		t.Fatalf("createTaxCode(INN): %v", err)
	}
	var storedJurisdiction, storedDirection string
	var storedRate int64
	var storedPrice, storedRecoverable, storedActive bool
	var storedLiability, storedAsset string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT jurisdiction_code, direction, rate_basis_points, price_includes_tax, recoverable, active, liability_account_code, asset_account_code
		FROM tax_codes WHERE id = $1::uuid AND org_id = $2::uuid`, vat.TaxCodeID, fx.orgID).
		Scan(&storedJurisdiction, &storedDirection, &storedRate, &storedPrice, &storedRecoverable, &storedActive, &storedLiability, &storedAsset); err != nil {
		t.Fatal(err)
	}
	if storedJurisdiction != "US" || storedDirection != "output" || storedRate != 1500 || storedPrice || storedRecoverable || !storedActive || storedLiability != "2100" || storedAsset != "1205" {
		t.Fatalf("stored VAT code = jurisdiction=%s direction=%s rate=%d price=%v recoverable=%v active=%v liability=%s asset=%s",
			storedJurisdiction, storedDirection, storedRate, storedPrice, storedRecoverable, storedActive, storedLiability, storedAsset)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT price_includes_tax, recoverable FROM tax_codes WHERE id = $1::uuid`, inputCode.TaxCodeID).
		Scan(&storedPrice, &storedRecoverable); err != nil {
		t.Fatal(err)
	}
	if !storedPrice || !storedRecoverable {
		t.Fatalf("stored INP code = price=%v recoverable=%v, want input tax recoverable", storedPrice, storedRecoverable)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT price_includes_tax, recoverable FROM tax_codes WHERE id = $1::uuid`, nonRecoverable.TaxCodeID).
		Scan(&storedPrice, &storedRecoverable); err != nil {
		t.Fatal(err)
	}
	if storedPrice || storedRecoverable {
		t.Fatalf("stored INN code = price=%v recoverable=%v, want nonrecoverable input tax", storedPrice, storedRecoverable)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "VAT", Name: "Duplicate VAT", Direction: "output", RateBasisPoints: 100})
	}); err == nil {
		t.Fatal("duplicate createTaxCode(VAT) succeeded, want unique org code violation")
	}
	if got := fx.count(`SELECT count(*) FROM tax_codes WHERE org_id = $1::uuid AND code = 'VAT'`, fx.orgID); got != 1 {
		t.Fatalf("VAT rows after duplicate = %d, want one", got)
	}

	foreignProfileID := seedTaxMasterProfile(t, fx, fx.otherOrgID, "DE", crmStringPointer("DE-112"), "quarterly")
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RemoveTaxProfileOutput, error) {
		return executeRemoveTaxProfile(fx.ctx, tx, claims, RemoveTaxProfileInput{ProfileID: created.ProfileID})
	}); err == nil || err.Error() != "tax profiles with codes or return history must be retained for audit" {
		t.Fatalf("removeTaxProfile with codes error = %v, want audit retention guard", err)
	}
	foreignClaims := taxMasterClaims(fx, fx.otherOrgID)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RemoveTaxProfileOutput, error) {
		return executeRemoveTaxProfile(fx.ctx, tx, claims, RemoveTaxProfileInput{ProfileID: foreignProfileID})
	}); err == nil || err.Error() != "tax profile not found" {
		t.Fatalf("cross-org removeTaxProfile error = %v, want org-scoped refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_profiles WHERE id = $1::uuid`, foreignProfileID); got != 1 {
		t.Fatalf("foreign profile rows after cross-org remove = %d, want untouched", got)
	}

	removed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (RemoveTaxProfileOutput, error) {
		return executeRemoveTaxProfile(fx.ctx, tx, foreignClaims, RemoveTaxProfileInput{ProfileID: foreignProfileID})
	})
	if err != nil {
		t.Fatalf("removeTaxProfile(foreign): %v", err)
	}
	if removed.JurisdictionCode != "DE" || removed.RegistrationNumber == nil || *removed.RegistrationNumber != "DE-112" || removed.FilingFrequency != "quarterly" {
		t.Fatalf("removeTaxProfile output = %+v, want the stored profile fields", removed)
	}
	if encoded, err := marshalJS(removed); err != nil || string(encoded) != `{"jurisdictionCode":"DE","registrationNumber":"DE-112","filingFrequency":"quarterly"}` {
		t.Fatalf("removeTaxProfile output JSON = %s, %v", encoded, err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_profiles WHERE id = $1::uuid`, foreignProfileID); got != 0 {
		t.Fatalf("removed profile rows = %d, want zero", got)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (RemoveTaxProfileOutput, error) {
		return executeRemoveTaxProfile(fx.ctx, tx, foreignClaims, RemoveTaxProfileInput{ProfileID: foreignProfileID})
	}); err == nil || err.Error() != "tax profile not found" {
		t.Fatalf("repeat removeTaxProfile error = %v, want not found", err)
	}
}

func TestAccountingTaxMastersTaxCodeLifecycleGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupTaxMasterFixtures(t, fx)
	claims := taxMasterClaims(fx, fx.orgID)

	profileID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxProfileOutput, error) {
		return executeCreateTaxProfile(fx.ctx, tx, claims, CreateTaxProfileInput{JurisdictionCode: "GB", FilingFrequency: "annual"})
	})
	if err != nil {
		t.Fatalf("createTaxProfile: %v", err)
	}
	outputCode, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "S1", Name: "Standard rate", Direction: "output", RateBasisPoints: 2000})
	})
	if err != nil {
		t.Fatalf("createTaxCode(S1): %v", err)
	}
	otherCode, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxCodeOutput, error) {
		return executeCreateTaxCode(fx.ctx, tx, claims, CreateTaxCodeInput{Code: "S2", Name: "Reduced rate", Direction: "output", RateBasisPoints: 500})
	})
	if err != nil {
		t.Fatalf("createTaxCode(S2): %v", err)
	}

	archived, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ArchiveTaxCodeOutput, error) {
		return executeArchiveTaxCode(fx.ctx, tx, claims, ArchiveTaxCodeInput{TaxCodeID: outputCode.TaxCodeID})
	})
	if err != nil {
		t.Fatalf("archiveTaxCode: %v", err)
	}
	if archived.TaxCodeID != outputCode.TaxCodeID {
		t.Fatalf("archiveTaxCode output = %+v, want the archived code id", archived)
	}
	if encoded, err := marshalJS(archived); err != nil || string(encoded) != `{"taxCodeId":"`+outputCode.TaxCodeID+`"}` {
		t.Fatalf("archiveTaxCode output JSON = %s, %v", encoded, err)
	}
	var active bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT active FROM tax_codes WHERE id = $1::uuid`, outputCode.TaxCodeID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active {
		t.Fatal("archived tax code is still active, want active=false")
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ArchiveTaxCodeOutput, error) {
		return executeArchiveTaxCode(fx.ctx, tx, claims, ArchiveTaxCodeInput{TaxCodeID: outputCode.TaxCodeID})
	}); err == nil || err.Error() != "active tax code not found" {
		t.Fatalf("repeat archiveTaxCode error = %v, want state guard", err)
	}

	reactivated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ActivateTaxCodeOutput, error) {
		return executeActivateTaxCode(fx.ctx, tx, claims, ActivateTaxCodeInput{TaxCodeID: outputCode.TaxCodeID})
	})
	if err != nil || reactivated.TaxCodeID != outputCode.TaxCodeID {
		t.Fatalf("activateTaxCode output = %+v err=%v", reactivated, err)
	}
	if encoded, err := marshalJS(reactivated); err != nil || string(encoded) != `{"taxCodeId":"`+outputCode.TaxCodeID+`"}` {
		t.Fatalf("activateTaxCode output JSON = %s, %v", encoded, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT active FROM tax_codes WHERE id = $1::uuid`, outputCode.TaxCodeID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("reactivated tax code is not active, want active=true")
	}

	foreignCodeID := seedTaxMasterCode(t, fx, fx.otherOrgID, "DE", "F1", "output", 1900, true)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ArchiveTaxCodeOutput, error) {
		return executeArchiveTaxCode(fx.ctx, tx, claims, ArchiveTaxCodeInput{TaxCodeID: foreignCodeID})
	}); err == nil || err.Error() != "active tax code not found" {
		t.Fatalf("cross-org archiveTaxCode error = %v, want org-scoped refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ActivateTaxCodeOutput, error) {
		return executeActivateTaxCode(fx.ctx, tx, claims, ActivateTaxCodeInput{TaxCodeID: otherCode.TaxCodeID})
	}); err == nil || err.Error() != "archived tax code not found" {
		t.Fatalf("activateTaxCode on an active code error = %v, want state guard", err)
	}
	missingID := executorUUID(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ArchiveTaxCodeOutput, error) {
		return executeArchiveTaxCode(fx.ctx, tx, claims, ArchiveTaxCodeInput{TaxCodeID: missingID})
	}); err == nil || err.Error() != "active tax code not found" {
		t.Fatalf("archiveTaxCode(unknown) error = %v, want not found", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ActivateTaxCodeOutput, error) {
		return executeActivateTaxCode(fx.ctx, tx, claims, ActivateTaxCodeInput{TaxCodeID: missingID})
	}); err == nil || err.Error() != "archived tax code not found" {
		t.Fatalf("activateTaxCode(unknown) error = %v, want not found", err)
	}

	if err := fx.owner.QueryRow(fx.ctx, `SELECT active FROM tax_codes WHERE id = $1::uuid`, foreignCodeID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("foreign tax code was archived by another org, want active=true")
	}
	if got := fx.count(`SELECT count(*) FROM tax_codes WHERE org_id = $1::uuid AND active = true`, fx.orgID); got != 2 {
		t.Fatalf("active codes = %d, want both org codes active after the archive/activate round trip", got)
	}
	if got := fx.count(`SELECT count(*) FROM tax_profiles WHERE org_id = $1::uuid AND id = $2::uuid`, fx.orgID, profileID.ProfileID); got != 1 {
		t.Fatalf("profile rows after lifecycle test = %d, want untouched profile", got)
	}
}
