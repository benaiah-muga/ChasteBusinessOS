package capability

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGoCreatorExecutorContractsAndInverseLinks(t *testing.T) {
	cases := []struct {
		id         string
		permission string
		risk       string
		inverse    string
		source     string
		fields     []string
	}{
		{creatorSubmitProposalCapabilityID, "platform.creator", "write", "", "", nil},
		{creatorListProposalsCapabilityID, "platform.creator", "read", "", "", nil},
		{creatorScaffoldCapabilityID, "platform.creator", "read", "", "", nil},
		{creatorVerifyPluginCapabilityID, "platform.creator", "read", "", "", nil},
		{creatorPublishListingCapabilityID, "platform.creator", "write", creatorRetractListingCapabilityID, "output", []string{"slug"}},
		{creatorRetractListingCapabilityID, "platform.creator", "write", "", "", nil},
		{creatorInstallListingCapabilityID, "platform.creator", "identity", creatorUninstallListingCapabilityID, "input", []string{"listingId"}},
		{creatorUninstallListingCapabilityID, "platform.creator", "write", "", "", nil},
		{creatorListMarketplaceCapabilityID, "platform.browse", "read", "", "", nil},
		{creatorStageCandidateCapabilityID, "platform.creator", "identity", creatorRollbackCandidateCapabilityID, "output", []string{"releaseId", "candidateDigest"}},
		{creatorPromoteCandidateCapabilityID, "platform.creator", "identity", creatorRollbackCandidateCapabilityID, "output", []string{"releaseId", "candidateDigest"}},
		{creatorRollbackCandidateCapabilityID, "platform.creator", "destructive", "", "", nil},
		{creatorRecordCanaryOutcomeCapabilityID, "platform.creator.release", "write", "", "", nil},
	}

	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			spec, exists := capabilitySpecs[test.id]
			if !exists || !supportedCapability(test.id) {
				t.Fatal("creator capability is missing from the executor registry")
			}
			if spec.module != "creator" || spec.permission != test.permission || spec.risk != test.risk || spec.inverseCapabilityID != test.inverse || spec.inverseInputSource != test.source || !reflect.DeepEqual(spec.inverseFields, test.fields) {
				t.Fatalf("executor spec=%+v, want permission=%q risk=%q inverse=%q source=%q fields=%v", spec, test.permission, test.risk, test.inverse, test.source, test.fields)
			}
			permission, ok := permissionForCapability(test.id)
			if !ok || permission != test.permission {
				t.Fatalf("approval permission=(%q,%t), want %q", permission, ok, test.permission)
			}
		})
	}
}

func TestGoCreatorExecutorParsesEveryRegisteredCapability(t *testing.T) {
	const (
		proposalID = "11111111-1111-4111-8111-111111111111"
		ticketID   = "22222222-2222-4222-8222-222222222222"
		releaseID  = "33333333-3333-4333-8333-333333333333"
		digest     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	)
	cases := []struct {
		id  string
		raw string
	}{
		{creatorSubmitProposalCapabilityID, `{"title":"Proposal title","summary":"A sufficiently detailed proposal summary","diffText":"--- a/file\n+++ b/file","riskAssessment":"A sufficiently detailed risk assessment"}`},
		{creatorListProposalsCapabilityID, `{}`},
		{creatorScaffoldCapabilityID, `{"module":"inventory","action":"cycleCount","title":"Cycle count","intent":"Record a cycle count against existing inventory data","risk":"write","permission":"inventory.write","submitAsProposal":false}`},
		{creatorVerifyPluginCapabilityID, `{"manifest":{},"signatureBase64":"signature","publisherPublicKeyBase64":"public-key"}`},
		{creatorPublishListingCapabilityID, `{"manifest":` + creatorTestManifest + `,"signatureBase64":"0123456789abcdef","publisherPublicKeyBase64":"0123456789abcdef"}`},
		{creatorRetractListingCapabilityID, `{"slug":"acme-warehouse"}`},
		{creatorInstallListingCapabilityID, `{"listingId":"listing-id"}`},
		{creatorUninstallListingCapabilityID, `{"listingId":"listing-id"}`},
		{creatorListMarketplaceCapabilityID, `{}`},
		{creatorStageCandidateCapabilityID, `{"proposalId":"` + proposalID + `","gapTicketId":"` + ticketID + `","candidateDigest":"` + digest + `","artifactRef":"artifact://creator/candidate"}`},
		{creatorPromoteCandidateCapabilityID, `{"releaseId":"` + releaseID + `","candidateDigest":"` + digest + `"}`},
		{creatorRollbackCandidateCapabilityID, `{"releaseId":"` + releaseID + `","candidateDigest":"` + digest + `"}`},
		{creatorRecordCanaryOutcomeCapabilityID, `{"releaseId":"` + releaseID + `","gapTicketId":"` + ticketID + `","candidateDigest":"` + digest + `","verdict":"pass","evidenceRef":"evidence://creator/canary"}`},
	}

	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			if _, err := parseCreatorInput(test.id, json.RawMessage(test.raw)); err != nil {
				t.Fatalf("parseCreatorInput(%s): %v", test.id, err)
			}
			if _, err := parseCreatorInput(test.id, json.RawMessage(`[]`)); err == nil {
				t.Fatal("creator parser accepted a non-object input")
			}
		})
	}
}

func TestGoCreatorPluginVerificationUsesGovernedExecutor(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"manifest":{},"signatureBase64":"invalid-signature","publisherPublicKeyBase64":"invalid-public-key"}`)
	intentID := executorUUID(t)
	result, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, creatorVerifyPluginCapabilityID, "platform.creator", intentID, "", ""), input)
	if err != nil || !result.OK {
		t.Fatalf("creator.verifyPlugin execution=%+v err=%v", result, err)
	}
	var output CreatorVerifyPluginOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || output.Valid || output.Reason == nil {
		t.Fatalf("creator.verifyPlugin data=%s output=%+v err=%v, want an invalid-plugin result", result.Data, output, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed' AND actor_type='system' AND actor_id IS NULL AND session_id IS NULL`, fx.orgID, creatorVerifyPluginCapabilityID); got != 1 {
		t.Fatalf("creator.verifyPlugin audit rows=%d, want one governed system event", got)
	}
}

func TestGoCreatorMarketplaceReadMatchesLegacyRowsAndWireFields(t *testing.T) {
	fx := newExecutorFixture(t)
	baseTime := time.Date(2099, time.September, 1, 12, 30, 45, 987654321, time.UTC)
	listingIDs := make([]string, 101)
	t.Cleanup(func() {
		for _, id := range listingIDs {
			if id == "" {
				continue
			}
			if _, err := fx.owner.Exec(context.Background(), `DELETE FROM marketplace_listings WHERE id=$1::uuid`, id); err != nil {
				t.Errorf("clean marketplace listing %s: %v", id, err)
			}
		}
	})
	statuses := []string{"submitted", "verified", "rejected"}
	for index := range listingIDs {
		listingIDs[index] = executorUUID(t)
		status := statuses[index%len(statuses)]
		capabilities := []byte(`[]`)
		installed := []byte(`[]`)
		switch index {
		case 0:
			capabilities = []byte(`["creator.demo"]`)
			installed, _ = json.Marshal([]string{fx.orgID})
		case 1:
			capabilities = []byte(`null`)
			installed, _ = json.Marshal([]string{fx.otherOrgID})
		case 2:
			capabilities = []byte(`{"unexpected":true}`)
			installed = []byte(`null`)
		case 3:
			capabilities = []byte(`["creator.one","creator.two"]`)
			installed = []byte(`{"unexpected":true}`)
		case 4:
			installed, _ = json.Marshal([]any{17, fx.orgID})
		}
		updatedAt := baseTime.Add(-time.Duration(index) * time.Second)
		_, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO marketplace_listings
				(id, slug, name, version, summary, manifest, signature, publisher_public_key,
				 capability_ids, status, submitted_by_org_id, installed_by_org_ids, updated_at)
			VALUES ($1::uuid, $2, $3, '1.0.0', $4, '{}'::jsonb, 'signature', 'public-key',
				 $5::jsonb, $6, $7::uuid, $8::jsonb, $9)`,
			listingIDs[index], "creator-parity-"+listingIDs[index], "Creator parity listing", "Marketplace parity fixture",
			capabilities, status, fx.otherOrgID, installed, updatedAt)
		if err != nil {
			t.Fatalf("seed marketplace listing %d: %v", index, err)
		}
	}
	input := json.RawMessage(`{}`)
	result, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, creatorListMarketplaceCapabilityID, "platform.browse", executorUUID(t), "", ""), input)
	if err != nil || !result.OK {
		t.Fatalf("creator.listMarketplace result=%+v err=%v", result, err)
	}
	var output CreatorListMarketplaceOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode marketplace data %s: %v", result.Data, err)
	}
	var wire struct {
		Listings []map[string]json.RawMessage `json:"listings"`
	}
	if err := json.Unmarshal(result.Data, &wire); err != nil {
		t.Fatalf("decode marketplace wire fields %s: %v", result.Data, err)
	}
	if len(output.Listings) != 100 {
		t.Fatalf("marketplace rows=%d, want legacy limit 100", len(output.Listings))
	}
	if len(wire.Listings) == 0 {
		t.Fatal("marketplace wire response has no listing rows")
	}
	if len(wire.Listings[0]) != 10 {
		t.Fatalf("marketplace wire field count=%d, want exactly the 10 legacy fields", len(wire.Listings[0]))
	}
	for _, field := range []string{"id", "slug", "name", "version", "summary", "status", "capabilityIds", "installedByOrgIds", "installedHere", "updatedAt"} {
		if _, ok := wire.Listings[0][field]; !ok {
			t.Errorf("marketplace wire response is missing %q", field)
		}
	}
	var updatedAtWire string
	if err := json.Unmarshal(wire.Listings[0]["updatedAt"], &updatedAtWire); err != nil {
		t.Fatalf("decode updatedAt wire value: %v", err)
	}
	if want := jsDate(baseTime).Format("2006-01-02T15:04:05.000Z"); updatedAtWire != want {
		t.Fatalf("marketplace updatedAt wire=%q, want JS Date format %q", updatedAtWire, want)
	}
	for index, listing := range output.Listings {
		if listing.ID != listingIDs[index] {
			t.Fatalf("marketplace row %d id=%s, want updated-at order id=%s", index, listing.ID, listingIDs[index])
		}
		if listing.Status != statuses[index%len(statuses)] {
			t.Fatalf("marketplace row %d status=%q, want all statuses preserved", index, listing.Status)
		}
		if index == 0 {
			var installedByOrgIDs []string
			if err := json.Unmarshal(listing.InstalledByOrgIDs, &installedByOrgIDs); err != nil || !reflect.DeepEqual(installedByOrgIDs, []string{fx.orgID}) {
				t.Fatalf("marketplace row 0 installedByOrgIds=%s, want current org", listing.InstalledByOrgIDs)
			}
			if listing.Slug != "creator-parity-"+listingIDs[0] || listing.Name != "Creator parity listing" || listing.Version != "1.0.0" ||
				listing.Summary != "Marketplace parity fixture" || !reflect.DeepEqual(listing.CapabilityIDs, []json.RawMessage{json.RawMessage(`"creator.demo"`)}) || !listing.InstalledHere {
				t.Fatalf("marketplace row 0 = %+v, want legacy fields and current-org installation", listing)
			}
			if !listing.UpdatedAt.Equal(jsDate(baseTime)) {
				t.Fatalf("marketplace updatedAt=%s, want JS-millisecond UTC time %s", listing.UpdatedAt, jsDate(baseTime))
			}
		}
		if index == 3 {
			var installedByOrgIDs map[string]bool
			if err := json.Unmarshal(listing.InstalledByOrgIDs, &installedByOrgIDs); err != nil || installedByOrgIDs["unexpected"] != true {
				t.Fatalf("marketplace row 3 installedByOrgIds=%s, want legacy JSON value preserved", listing.InstalledByOrgIDs)
			}
		}
	}
	if len(output.Listings[1].CapabilityIDs) != 0 || output.Listings[1].InstalledHere {
		t.Fatalf("marketplace row with null capability IDs and foreign installation = %+v", output.Listings[1])
	}
	if len(output.Listings[2].CapabilityIDs) != 0 || output.Listings[2].InstalledHere {
		t.Fatalf("marketplace row with non-array capability IDs and null installation = %+v", output.Listings[2])
	}
	if !reflect.DeepEqual(output.Listings[3].CapabilityIDs, []json.RawMessage{json.RawMessage(`"creator.one"`), json.RawMessage(`"creator.two"`)}) || output.Listings[3].InstalledHere {
		t.Fatalf("marketplace row with non-array installation = %+v", output.Listings[3])
	}
	if !output.Listings[4].InstalledHere {
		t.Fatalf("marketplace row with mixed-type installation array=%+v, want org membership preserved", output.Listings[4])
	}
}

func TestGoCreatorRetractCannotChangeAnotherPublishersListing(t *testing.T) {
	fx := newExecutorFixture(t)
	listingID := executorUUID(t)
	slug := "foreign-publisher-" + listingID[:8]
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), `DELETE FROM marketplace_listings WHERE id=$1::uuid`, listingID); err != nil {
			t.Errorf("clean foreign marketplace listing: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO marketplace_listings
			(id, slug, name, version, summary, manifest, signature, publisher_public_key,
			 capability_ids, status, submitted_by_org_id, installed_by_org_ids)
		VALUES ($1::uuid, $2, 'Foreign publisher listing', '1.0.0', 'Tenant boundary fixture',
			 '{}'::jsonb, 'signature', 'public-key', '[]'::jsonb, 'verified', $3::uuid, '[]'::jsonb)`,
		listingID, slug, fx.otherOrgID); err != nil {
		t.Fatalf("seed foreign publisher listing: %v", err)
	}

	fx.setModuleList(`["creator"]`)
	grantWavePermission(t, fx, "platform.creator")
	input := json.RawMessage(`{"slug":"` + slug + `"}`)
	claims := waveModuleClaims(fx, creatorRetractListingCapabilityID, "platform.creator", input, "human", "", "creator-foreign-retract")
	result, err := fx.executor.Execute(fx.ctx, claims, creatorRetractListingCapabilityID, input)
	if err == nil || result.OK || !strings.Contains(err.Error(), "no such listing published by your org") {
		t.Fatalf("creator.retractListing against a foreign publisher result=%+v err=%v, want an ownership refusal", result, err)
	}

	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM marketplace_listings WHERE id=$1::uuid`, listingID).Scan(&status); err != nil {
		t.Fatalf("read foreign listing after refused retraction: %v", err)
	}
	if status != "verified" {
		t.Fatalf("foreign listing status=%q after refused retraction, want verified", status)
	}
}

func TestGoCreatorMarketplaceHumanReadPreservesLegacyOrgAccess(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO agent_sessions (id, org_id, user_id, title, mode, model_ref, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'Marketplace access test', 'assist', 'test-model', 'open')`,
		fx.agentSession, fx.orgID, fx.userID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{}`)
	humanClaims := waveModuleClaims(fx, creatorListMarketplaceCapabilityID, "platform.browse", input, "human", "", "marketplace-human-no-browse")
	humanClaims.Permissions = nil

	result, err := fx.executor.Execute(fx.ctx, humanClaims, creatorListMarketplaceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("human Marketplace read without platform.browse = %+v, %v; want legacy org-member access", result, err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET enabled_modules='[]'::jsonb WHERE id=$1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	humanClaims.IntentID = "marketplace-human-creator-disabled"
	result, err = fx.executor.Execute(fx.ctx, humanClaims, creatorListMarketplaceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("human Marketplace read with Creator disabled = %+v, %v; want legacy org-member access", result, err)
	}

	agentClaims := waveModuleClaims(fx, creatorListMarketplaceCapabilityID, "platform.browse", input, "agent", fx.agentSession, "marketplace-agent-creator-disabled")
	result, err = fx.executor.Execute(fx.ctx, agentClaims, creatorListMarketplaceCapabilityID, input)
	if err != nil || result.OK || result.Error != `module "creator" is disabled for this organization` {
		t.Fatalf("agent Marketplace read with Creator disabled = %+v, %v; want module denial", result, err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET enabled_modules='["creator"]'::jsonb WHERE id=$1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	agentClaims.IntentID = "marketplace-agent-no-browse"
	agentClaims.Permissions = nil
	result, err = fx.executor.Execute(fx.ctx, agentClaims, creatorListMarketplaceCapabilityID, input)
	if err != nil || result.OK || result.Error != "forbidden: missing permission: platform.browse" {
		t.Fatalf("agent Marketplace read without platform.browse = %+v, %v; want permission denial", result, err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'platform.browse', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	agentClaims.IntentID = "marketplace-agent-with-browse"
	agentClaims.Permissions = []string{"platform.browse"}
	result, err = fx.executor.Execute(fx.ctx, agentClaims, creatorListMarketplaceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("agent Marketplace read with Creator and platform.browse enabled = %+v, %v; want capability access", result, err)
	}

	humanClaims.IntentID = "marketplace-human-with-browse"
	humanClaims.Permissions = []string{"platform.browse"}
	result, err = fx.executor.Execute(fx.ctx, humanClaims, creatorListMarketplaceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("human Marketplace read with Creator and platform.browse enabled = %+v, %v; want legacy org-member access", result, err)
	}

	otherOrgClaims := humanClaims
	otherOrgClaims.OrganizationID = fx.otherOrgID
	otherOrgClaims.IntentID = "marketplace-human-foreign-org"
	if _, err := fx.executor.Execute(fx.ctx, otherOrgClaims, creatorListMarketplaceCapabilityID, input); !errors.Is(err, ErrNotMember) {
		t.Fatalf("human Marketplace read through a non-member organization error=%v, want ErrNotMember", err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, creatorListMarketplaceCapabilityID); got != 3 {
		t.Fatalf("human Marketplace audit events=%d, want one for each of three authorized reads", got)
	}
}

func TestGoCreatorMarketplaceVerifyPreservesLegacyHumanAccess(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO agent_sessions (id, org_id, user_id, title, mode, model_ref, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'Marketplace verify access test', 'assist', 'test-model', 'open')`,
		fx.agentSession, fx.orgID, fx.userID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"manifest":{},"signatureBase64":"invalid-signature","publisherPublicKeyBase64":"invalid-public-key"}`)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET enabled_modules='[]'::jsonb WHERE id=$1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}

	humanClaims := waveModuleClaims(fx, creatorVerifyPluginCapabilityID, "platform.creator", input, "human", "", "marketplace-human-verify")
	humanClaims.Permissions = nil
	result, err := fx.executor.Execute(fx.ctx, humanClaims, creatorVerifyPluginCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("human Marketplace verification without platform.creator and Creator module = %+v, %v; want legacy org-member access", result, err)
	}
	var output CreatorVerifyPluginOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || output.Valid || output.Reason == nil {
		t.Fatalf("human Marketplace verification data=%s output=%+v err=%v, want invalid-signature verdict", result.Data, output, err)
	}

	systemResult, err := fx.executor.ExecuteSystem(fx.ctx, fx.systemClaims(t, creatorVerifyPluginCapabilityID, "platform.creator", executorUUID(t), "", ""), input)
	if err != nil || systemResult.OK || systemResult.Error != `module "creator" is disabled for this organization` {
		t.Fatalf("system Marketplace verification with Creator disabled = %+v, %v; want module denial", systemResult, err)
	}

	agentClaims := waveModuleClaims(fx, creatorVerifyPluginCapabilityID, "platform.creator", input, "agent", fx.agentSession, "marketplace-agent-verify-module-disabled")
	result, err = fx.executor.Execute(fx.ctx, agentClaims, creatorVerifyPluginCapabilityID, input)
	if err != nil || result.OK || result.Error != `module "creator" is disabled for this organization` {
		t.Fatalf("agent Marketplace verification with Creator disabled = %+v, %v; want module denial", result, err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET enabled_modules='["creator"]'::jsonb WHERE id=$1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	agentClaims.IntentID = "marketplace-agent-verify-no-permission"
	agentClaims.Permissions = nil
	result, err = fx.executor.Execute(fx.ctx, agentClaims, creatorVerifyPluginCapabilityID, input)
	if err != nil || result.OK || result.Error != "forbidden: missing permission: platform.creator" {
		t.Fatalf("agent Marketplace verification without platform.creator = %+v, %v; want permission denial", result, err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'platform.creator', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	agentClaims.IntentID = "marketplace-agent-verify-with-permission"
	agentClaims.Permissions = []string{"platform.creator"}
	result, err = fx.executor.Execute(fx.ctx, agentClaims, creatorVerifyPluginCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("agent Marketplace verification with Creator and platform.creator enabled = %+v, %v; want capability access", result, err)
	}

	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, creatorVerifyPluginCapabilityID); got != 1 {
		t.Fatalf("human Marketplace verification audit events=%d, want one governed event", got)
	}
	otherOrgClaims := humanClaims
	otherOrgClaims.OrganizationID = fx.otherOrgID
	otherOrgClaims.IntentID = "marketplace-human-verify-foreign-org"
	if _, err := fx.executor.Execute(fx.ctx, otherOrgClaims, creatorVerifyPluginCapabilityID, input); !errors.Is(err, ErrNotMember) {
		t.Fatalf("human Marketplace verification through a non-member organization error=%v, want ErrNotMember", err)
	}
}
