package capability

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const harnessTestCompositionID = "3f2504e0-4f89-41d3-8a0c-0305e82c3301"

const harnessTestProfile = `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod",` +
	`"authority":{"allowSourceWrites":false,"allowProcessLaunch":false,"allowCodeExecution":false,` +
	`"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":["accounting","crm"]}`

const harnessTestBundles = `[{"id":"core","version":"1.0.0","serviceIds":["ledger","mailer"]}]`

const harnessTestPatches = `[{"id":"defaults","version":"2.0.0","values":{"retention":{"days":90},"label":"erp"}}]`

// Golden digests produced by the TypeScript original: sha256 over
// canonicalJson(profile) and canonicalJson({profile, bundles, patches}) from
// @chaste/harness, with the profile run through the Zod schemas first. The Go
// canonicalization must reproduce these byte for byte or every existing
// composition would be rejected as tampered.
const (
	harnessGoldenProfileDigest     = "a667f8842fe5203faa9f2174079f2b6f7e1de17cdb025fcd3f243d5bb706c81d"
	harnessGoldenCompositionDigest = "75b91e4570ef5fe6ab768475ae605ac6d132221a94b356d7edc4ec8deebda1c5"
)

// A second golden that exercises the canonicalization edge cases: a stripped
// unknown key, an absent optional key, unicode, HTML-significant characters,
// exponent notation, negatives, nulls, an empty object and escape sequences.
const harnessGoldenProfile2 = `{"id":"erp-dev","version":"2.10.3","environment":"erp-dev",` +
	`"authority":{"allowSourceWrites":true,"allowProcessLaunch":false,"allowCodeExecution":true,` +
	`"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":[],"surprise":"stripped"}`

const harnessGoldenBundles2 = `[{"id":"core","version":"1.0.0","serviceIds":["ledger","mailer"],"requiredBundleIds":["base"]},` +
	`{"id":"base","version":"0.9.1","serviceIds":["clock"]}]`

const harnessGoldenPatches2 = `[{"id":"défauts","version":"2.0.0","values":{"ratio":1.5,"big":1e21,"zero":0,"neg":-7,` +
	`"nested":{"b":[1,2,{"c":null}],"a":"<&>"},"empty":{},"none":null,"text":"line1\nline2\t\"q\" é"}}]`

const (
	harnessGoldenProfileDigest2     = "e00dac9b65b45c8a9ac657205658d8be32955852cd9339bbbf668426475788ff"
	harnessGoldenCompositionDigest2 = "31f15438cea74e5aa21da85203942cb69ac0e7944cdc3d383911a64a951df727"
)

// harnessTestDigests returns the profile and composition digests a legitimate
// write would persist for the given parts.
func harnessTestDigests(t *testing.T, profile, bundles, patches string) (string, string) {
	t.Helper()
	parsedProfile, err := harnessParseProfile(json.RawMessage(profile))
	if err != nil {
		t.Fatalf("parse test profile: %v", err)
	}
	parsedBundles, err := harnessParseBundles(json.RawMessage(bundles))
	if err != nil {
		t.Fatalf("parse test bundles: %v", err)
	}
	parsedPatches, err := harnessParsePatches(json.RawMessage(patches))
	if err != nil {
		t.Fatalf("parse test patches: %v", err)
	}
	profileDigest, err := harnessProfileDigest(parsedProfile)
	if err != nil {
		t.Fatal(err)
	}
	compositionDigest, err := harnessCompositionDigest(parsedProfile, parsedBundles, parsedPatches)
	if err != nil {
		t.Fatal(err)
	}
	return profileDigest, compositionDigest
}

// TestHarnessDigestsMatchTheTypeScriptCanonicalization pins the Go
// canonicalization to digests computed by the TypeScript original. A drift here
// would silently reject every stored composition as tampered.
func TestHarnessDigestsMatchTheTypeScriptCanonicalization(t *testing.T) {
	for _, golden := range []struct {
		name              string
		profile           string
		bundles           string
		patches           string
		profileDigest     string
		compositionDigest string
	}{
		{"erp-prod", harnessTestProfile, harnessTestBundles, harnessTestPatches, harnessGoldenProfileDigest, harnessGoldenCompositionDigest},
		{"canonicalization edges", harnessGoldenProfile2, harnessGoldenBundles2, harnessGoldenPatches2, harnessGoldenProfileDigest2, harnessGoldenCompositionDigest2},
	} {
		profile, err := harnessParseProfile(json.RawMessage(golden.profile))
		if err != nil {
			t.Fatalf("%s: %v", golden.name, err)
		}
		bundles, err := harnessParseBundles(json.RawMessage(golden.bundles))
		if err != nil {
			t.Fatalf("%s: %v", golden.name, err)
		}
		patches, err := harnessParsePatches(json.RawMessage(golden.patches))
		if err != nil {
			t.Fatalf("%s: %v", golden.name, err)
		}
		profileDigest, err := harnessProfileDigest(profile)
		if err != nil {
			t.Fatalf("%s: %v", golden.name, err)
		}
		compositionDigest, err := harnessCompositionDigest(profile, bundles, patches)
		if err != nil {
			t.Fatalf("%s: %v", golden.name, err)
		}
		if profileDigest != golden.profileDigest {
			t.Errorf("%s profile digest = %s, want the TypeScript digest %s", golden.name, profileDigest, golden.profileDigest)
		}
		if compositionDigest != golden.compositionDigest {
			t.Errorf("%s composition digest = %s, want the TypeScript digest %s", golden.name, compositionDigest, golden.compositionDigest)
		}
	}
}

// ── Contract ──

func TestHarnessApproveCompositionCapabilityContract(t *testing.T) {
	if harnessApproveCompositionCapabilityID != "harness.approveComposition" {
		t.Errorf("capability id = %q", harnessApproveCompositionCapabilityID)
	}
	spec, present := harnessCapabilitySpecEntries()[harnessApproveCompositionCapabilityID]
	if !present {
		t.Fatal("harness.approveComposition is missing from the harness capability specs")
	}
	if spec.module != "harness" || spec.permission != "harness.approve" || spec.risk != "identity" {
		t.Errorf("spec=%+v, want harness module, harness.approve permission, identity risk", spec)
	}
	if spec.inverseCapabilityID != "" {
		t.Errorf("inverse = %q, want none", spec.inverseCapabilityID)
	}
	entry := readMigrationManifest(t, harnessApproveCompositionCapabilityID)
	if entry["module"] != spec.module || entry["permission"] != spec.permission || entry["risk"] != spec.risk {
		t.Errorf("spec=%+v disagrees with the migration manifest entry %v", spec, entry)
	}
	if entry["inverseCapabilityId"] != nil {
		t.Errorf("manifest declares inverse %v, want none", entry["inverseCapabilityId"])
	}
	if _, err := parseHarnessInput("harness.unknown", json.RawMessage(`{}`)); err == nil {
		t.Error("parseHarnessInput accepted an unknown harness capability")
	}
}

// ── Input parser parity ──

func TestHarnessApproveCompositionInputParserParity(t *testing.T) {
	digest := strings.Repeat("a", 64)
	accepted := map[string]json.RawMessage{
		"exact pair":        json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + digest + `"}`),
		"unknown sibling":   json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + digest + `","force":true}`),
		"uppercase uuid":    json.RawMessage(`{"compositionId":"3F2504E0-4F89-41D3-8A0C-0305E82C3301","compositionDigest":"` + digest + `"}`),
		"nil uuid":          json.RawMessage(`{"compositionId":"00000000-0000-0000-0000-000000000000","compositionDigest":"` + digest + `"}`),
		"max uuid":          json.RawMessage(`{"compositionId":"ffffffff-ffff-ffff-ffff-ffffffffffff","compositionDigest":"` + digest + `"}`),
		"reordered payload": json.RawMessage(`{"compositionDigest":"` + digest + `","compositionId":"` + harnessTestCompositionID + `"}`),
	}
	for name, raw := range accepted {
		parsed, err := ParseHarnessApproveCompositionInput(raw)
		if err != nil {
			t.Errorf("parse %s: %v", name, err)
			continue
		}
		if parsed.CompositionID == "" || parsed.CompositionDigest != digest {
			t.Errorf("parse %s = %+v", name, parsed)
		}
	}

	rejected := map[string]json.RawMessage{
		"array input":        json.RawMessage(`[]`),
		"malformed json":     json.RawMessage(`{"compositionId":`),
		"trailing data":      json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + digest + `"} {}`),
		"missing id":         json.RawMessage(`{"compositionDigest":"` + digest + `"}`),
		"missing digest":     json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `"}`),
		"null id":            json.RawMessage(`{"compositionId":null,"compositionDigest":"` + digest + `"}`),
		"null digest":        json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":null}`),
		"unhyphenated uuid":  json.RawMessage(`{"compositionId":"3f2504e04f8941d39a0c0305e82c3301","compositionDigest":"` + digest + `"}`),
		"not a uuid":         json.RawMessage(`{"compositionId":"not-a-uuid","compositionDigest":"` + digest + `"}`),
		"nil uuid version 0": json.RawMessage(`{"compositionId":"3f2504e0-4f89-01d3-9a0c-0305e82c3301","compositionDigest":"` + digest + `"}`),
		"short digest":       json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + strings.Repeat("a", 63) + `"}`),
		"long digest":        json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + strings.Repeat("a", 65) + `"}`),
		"uppercase digest":   json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + strings.Repeat("A", 64) + `"}`),
		"non hex digest":     json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":"` + strings.Repeat("z", 64) + `"}`),
		"digest not string":  json.RawMessage(`{"compositionId":"` + harnessTestCompositionID + `","compositionDigest":123}`),
	}
	for name, raw := range rejected {
		if _, err := ParseHarnessApproveCompositionInput(raw); err == nil {
			t.Errorf("parser accepted %s: %s", name, raw)
		}
	}
}

// ── Output shape ──

func TestHarnessApproveCompositionOutputMatchesManifest(t *testing.T) {
	digest := strings.Repeat("b", 64)
	encoded := assertManifestOutput(t, harnessApproveCompositionCapabilityID, HarnessApproveCompositionOutput{
		CompositionID:     harnessTestCompositionID,
		CompositionDigest: digest,
		Status:            "approved",
	})
	var decoded HarnessApproveCompositionOutput
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Status != "approved" || decoded.CompositionID != harnessTestCompositionID || decoded.CompositionDigest != digest {
		t.Errorf("round trip = %+v", decoded)
	}
}

// ── Fail-closed composition identity ──

func TestHarnessCompositionIdentityIsVerifiedBeforeApproval(t *testing.T) {
	profileDigest, compositionDigest := harnessTestDigests(t, harnessTestProfile, harnessTestBundles, harnessTestPatches)

	if err := harnessAssertPersistedIdentity(harnessTestCompositionID, profileDigest, compositionDigest,
		json.RawMessage(harnessTestProfile), json.RawMessage(harnessTestBundles), json.RawMessage(harnessTestPatches)); err != nil {
		t.Fatalf("an untampered composition was rejected: %v", err)
	}

	tampered := map[string]struct {
		profileDigest, compositionDigest string
		profile, bundles, patches        string
	}{
		"widened authority": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: strings.Replace(harnessTestProfile, `"allowCodeExecution":false`, `"allowCodeExecution":true`, 1),
			bundles: harnessTestBundles, patches: harnessTestPatches,
		},
		"unsigned composition": {
			profileDigest: strings.Repeat("0", 64), compositionDigest: strings.Repeat("0", 64),
			profile: harnessTestProfile, bundles: harnessTestBundles, patches: harnessTestPatches,
		},
		"bundle smuggled in": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: harnessTestProfile,
			bundles: `[{"id":"core","version":"1.0.0","serviceIds":["ledger","mailer","exfiltrate"]}]`,
			patches: harnessTestPatches,
		},
		"patch smuggled in": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: harnessTestProfile, bundles: harnessTestBundles,
			patches: `[{"id":"defaults","version":"2.0.0","values":{"retention":{"days":90},"label":"erp","shell":"rm -rf /"}}]`,
		},
		"restricted authority widened": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: strings.Replace(harnessTestProfile, `"allowRegistryMutation":false`, `"allowRegistryMutation":true`, 1),
			bundles: harnessTestBundles, patches: harnessTestPatches,
		},
		"profile missing authority": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","allowedModules":[]}`,
			bundles: harnessTestBundles, patches: harnessTestPatches,
		},
		"profile environment forged": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: strings.Replace(harnessTestProfile, `"environment":"erp-prod"`, `"environment":"erp-dev"`, 1),
			bundles: harnessTestBundles, patches: harnessTestPatches,
		},
		"bundles not an array": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: harnessTestProfile, bundles: `{}`, patches: harnessTestPatches,
		},
		"patches not an array": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: harnessTestProfile, bundles: harnessTestBundles, patches: `null`,
		},
		"profile not an object": {
			profileDigest: profileDigest, compositionDigest: compositionDigest,
			profile: `"erp-prod"`, bundles: harnessTestBundles, patches: harnessTestPatches,
		},
	}
	for name, fixture := range tampered {
		err := harnessAssertPersistedIdentity(harnessTestCompositionID, fixture.profileDigest, fixture.compositionDigest,
			json.RawMessage(fixture.profile), json.RawMessage(fixture.bundles), json.RawMessage(fixture.patches))
		if err == nil {
			t.Errorf("%s was approved", name)
		}
	}

	if err := harnessAssertApprovalIdentity(compositionDigest, compositionDigest); err != nil {
		t.Errorf("matching approval identity rejected: %v", err)
	}
	for name, requested := range map[string]string{
		"other composition": strings.Repeat("c", 64),
		"empty digest":      "",
		"near miss":         compositionDigest[:63] + "0",
	} {
		if err := harnessAssertApprovalIdentity(compositionDigest, requested); err == nil {
			t.Errorf("approval accepted a %s digest", name)
		}
	}
}

func TestHarnessProfileRejectsMalformedStoredParts(t *testing.T) {
	for name, profile := range map[string]string{
		"null profile":              `null`,
		"array profile":             `[]`,
		"bad id":                    strings.Replace(harnessTestProfile, `"erp-prod","version"`, `"ERP Prod","version"`, 1),
		"bad version":               strings.Replace(harnessTestProfile, `"1.0.0"`, `"1.0"`, 1),
		"unknown environment":       strings.Replace(harnessTestProfile, `"environment":"erp-prod"`, `"environment":"prod"`, 1),
		"authority not an object":   `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":true,"allowedModules":[]}`,
		"authority missing boolean": `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowNetwork":true},"allowedModules":[]}`,
		"authority null boolean":    `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowSourceWrites":null,"allowProcessLaunch":false,"allowCodeExecution":false,"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":[]}`,
		"authority wrong type":      `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowSourceWrites":"yes","allowProcessLaunch":false,"allowCodeExecution":false,"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":[]}`,
		"modules not an array":      `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowSourceWrites":false,"allowProcessLaunch":false,"allowCodeExecution":false,"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":null}`,
		"bad module id":             `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowSourceWrites":false,"allowProcessLaunch":false,"allowCodeExecution":false,"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":["Accounting"]}`,
	} {
		if _, err := harnessParseProfile(json.RawMessage(profile)); err == nil {
			t.Errorf("parser accepted a profile with %s", name)
		}
	}
	// A restricted environment may keep network authority but nothing else.
	networkOnly, err := harnessParseProfile(json.RawMessage(harnessTestProfile))
	if err != nil {
		t.Fatalf("network-only authority rejected: %v", err)
	}
	if !networkOnly.Authority.AllowNetwork || networkOnly.Authority.AllowCodeExecution {
		t.Errorf("authority = %+v", networkOnly.Authority)
	}
	if len(networkOnly.AllowedModules) != 2 {
		t.Errorf("allowedModules = %v", networkOnly.AllowedModules)
	}
	// Unknown keys are stripped exactly as Zod strips them, so the digest is
	// computed over the declared shape only.
	stripped, err := harnessParseProfile(json.RawMessage(strings.TrimSuffix(harnessTestProfile, "}") + `,"escalate":true}`))
	if err != nil {
		t.Fatal(err)
	}
	strippedDigest, err := harnessProfileDigest(stripped)
	if err != nil {
		t.Fatal(err)
	}
	plainDigest, _ := harnessTestDigests(t, harnessTestProfile, harnessTestBundles, harnessTestPatches)
	if strippedDigest != plainDigest {
		t.Error("an unknown profile key changed the profile digest")
	}
	// allowedModules defaults to an empty array, not to an absent key.
	defaulted, err := harnessParseProfile(json.RawMessage(`{"id":"erp-dev","version":"1.0.0","environment":"erp-dev","authority":{"allowSourceWrites":true,"allowProcessLaunch":true,"allowCodeExecution":true,"allowRegistryMutation":true,"allowNetwork":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if defaulted.AllowedModules == nil || len(defaulted.AllowedModules) != 0 {
		t.Errorf("allowedModules default = %v, want an empty slice", defaulted.AllowedModules)
	}
}

// ── Org scoping and end-to-end approval ──

func TestGoHarnessApproveCompositionIsOrgScopedAndFailClosed(t *testing.T) {
	fx := newExecutorFixture(t)
	profileDigest, compositionDigest := harnessTestDigests(t, harnessTestProfile, harnessTestBundles, harnessTestPatches)
	seed := func(orgID string) string {
		t.Helper()
		var id string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO harness_compositions (org_id, profile_id, profile_version, environment, profile_digest, composition_digest, profile, bundles, patches)
			VALUES ($1::uuid, 'erp-prod', '1.0.0', 'erp-prod', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
			ON CONFLICT (org_id, composition_digest) DO UPDATE SET profile=$4::jsonb, bundles=$5::jsonb, patches=$6::jsonb
			RETURNING id::text`,
			orgID, profileDigest, compositionDigest, harnessTestProfile, harnessTestBundles, harnessTestPatches).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	compositionID := seed(fx.orgID)
	foreignCompositionID := seed(fx.otherOrgID)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM harness_compositions WHERE org_id = ANY($1::uuid[])`, []string{fx.orgID, fx.otherOrgID}); err != nil {
			t.Errorf("delete harness composition fixture rows: %v", err)
		}
	})

	approved, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HarnessApproveCompositionOutput, error) {
		return harnessApproveComposition(fx.ctx, tx, fx.orgID, HarnessApproveCompositionInput{
			CompositionID: compositionID, CompositionDigest: compositionDigest,
		})
	})
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if approved.Status != "approved" || approved.CompositionID != compositionID || approved.CompositionDigest != compositionDigest {
		t.Errorf("output = %+v", approved)
	}

	// A digest for a different composition is refused even though the row exists.
	wrongDigest := strings.Repeat("d", 64)
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HarnessApproveCompositionOutput, error) {
		return harnessApproveComposition(fx.ctx, tx, fx.orgID, HarnessApproveCompositionInput{
			CompositionID: compositionID, CompositionDigest: wrongDigest,
		})
	})
	if err == nil || !strings.Contains(err.Error(), "identity no longer matches") {
		t.Errorf("approve with a foreign digest: err=%v", err)
	}

	// Tampering with the stored parts after the digests were sealed is refused.
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE harness_compositions SET bundles=$3::jsonb
		WHERE org_id=$1::uuid AND id=$2::uuid`,
		fx.orgID, compositionID, `[{"id":"core","version":"1.0.0","serviceIds":["ledger","mailer","smuggle"]}]`); err != nil {
		t.Fatal(err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HarnessApproveCompositionOutput, error) {
		return harnessApproveComposition(fx.ctx, tx, fx.orgID, HarnessApproveCompositionInput{
			CompositionID: compositionID, CompositionDigest: compositionDigest,
		})
	})
	if err == nil || !strings.Contains(err.Error(), "invalid composition digest") {
		t.Errorf("approve after tampering: err=%v", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE harness_compositions SET bundles=$3::jsonb
		WHERE org_id=$1::uuid AND id=$2::uuid`,
		fx.orgID, compositionID, harnessTestBundles); err != nil {
		t.Fatal(err)
	}

	// A composition that only exists in another org is invisible from this one.
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HarnessApproveCompositionOutput, error) {
		return harnessApproveComposition(fx.ctx, tx, fx.orgID, HarnessApproveCompositionInput{
			CompositionID: foreignCompositionID, CompositionDigest: compositionDigest,
		})
	})
	if err == nil || !strings.Contains(err.Error(), "not found for organization") {
		t.Errorf("cross-tenant approve: err=%v", err)
	}
}
