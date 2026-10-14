package capability

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
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
		{creatorReviewProposalCapabilityID, "platform.creator", "write", "", "", nil},
		{creatorListCapabilityGapsCapabilityID, "platform.creator", "read", "", "", nil},
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
			if test.id == creatorReviewProposalCapabilityID && (!spec.approvalExempt || !spec.humanOnly) {
				t.Fatalf("review capability spec=%+v, want human-only and approval-exempt", spec)
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
		{creatorReviewProposalCapabilityID, `{"proposalId":"` + proposalID + `","decision":"approved","comment":"Reviewed"}`},
		{creatorListCapabilityGapsCapabilityID, `{}`},
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

func TestGoCreatorPublishListingUsesGovernedTenantScopedExecutor(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE organizations SET enabled_modules='["creator"]'::jsonb
		WHERE id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	slug := "go-publish-" + executorUUID(t)[:8]
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), `DELETE FROM marketplace_listings WHERE slug=$1`, slug); err != nil {
			t.Errorf("clean published marketplace fixture %s: %v", slug, err)
		}
	})
	manifestRaw := strings.Replace(creatorTestManifest, "acme-warehouse", slug, 1)
	manifest, err := creatorValidateManifest(json.RawMessage(manifestRaw))
	if err != nil {
		t.Fatalf("validate publish manifest: %v", err)
	}
	signature, publisherKey := creatorTestPublisher(t, manifest)
	input, err := json.Marshal(CreatorPublishListingInput{
		Manifest:                 json.RawMessage(manifestRaw),
		SignatureBase64:          signature,
		PublisherPublicKeyBase64: publisherKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	claimsForOrg := func(orgID, intentID string) SystemClaims {
		t.Helper()
		var jobID string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO jobs (org_id, type, payload, max_attempts)
			VALUES ($1::uuid, $2, '{}'::jsonb, 3) RETURNING id::text`, orgID, creatorPublishListingCapabilityID).Scan(&jobID); err != nil {
			t.Fatalf("seed system publish job: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `
			UPDATE jobs SET status='processing', lease_owner='creator-publish-test-owner', fencing_token=1,
				lease_expires_at=clock_timestamp() + interval '1 hour' WHERE id=$1::uuid`, jobID); err != nil {
			t.Fatalf("claim system publish job: %v", err)
		}
		return SystemClaims{
			OrganizationID: orgID, CapabilityID: creatorPublishListingCapabilityID, Permission: "platform.creator",
			IntentID: intentID, JobID: jobID, LeaseOwner: "creator-publish-test-owner",
			FencingToken: 1, LeaseExtensionMillis: 180_000,
		}
	}
	var refusedInput CreatorPublishListingInput
	if err := json.Unmarshal(input, &refusedInput); err != nil {
		t.Fatal(err)
	}
	refusedInput.SignatureBase64 = "invalid-signature"
	refusedJSON, err := json.Marshal(refusedInput)
	if err != nil {
		t.Fatal(err)
	}
	refusedResult, refusedErr := fx.executor.ExecuteSystem(fx.ctx, claimsForOrg(fx.orgID, executorUUID(t)), refusedJSON)
	var publishRefusal CreatorDomainError
	if !errors.As(refusedErr, &publishRefusal) || refusedResult.OK || !strings.Contains(publishRefusal.Error(), "refused:") {
		t.Fatalf("invalid signature publish result=%+v err=%v, want typed domain refusal", refusedResult, refusedErr)
	}
	if got := fx.count(`SELECT count(*) FROM marketplace_listings WHERE slug=$1`, slug); got != 0 {
		t.Fatalf("invalid signature created %d listings, want none", got)
	}
	result, err := fx.executor.ExecuteSystem(fx.ctx, claimsForOrg(fx.orgID, executorUUID(t)), input)
	if err != nil || !result.OK || result.PendingApproval {
		t.Fatalf("creator.publishListing execution=%+v err=%v, want a completed governed write", result, err)
	}
	var output CreatorPublishListingOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode publish result %s: %v", result.Data, err)
	}
	if output.Slug != slug || output.Status != "verified" || !isUUID(output.ListingID) {
		t.Fatalf("publish output=%+v, want verified listing %q", output, slug)
	}
	var ownerOrgID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT submitted_by_org_id::text FROM marketplace_listings WHERE id=$1::uuid`, output.ListingID).Scan(&ownerOrgID); err != nil {
		t.Fatalf("read published listing owner: %v", err)
	}
	if ownerOrgID != fx.orgID {
		t.Fatalf("published listing owner=%s, want executing org %s", ownerOrgID, fx.orgID)
	}

	otherOrgResult, err := fx.executor.ExecuteSystem(fx.ctx, claimsForOrg(fx.otherOrgID, executorUUID(t)), input)
	var ownershipRefusal CreatorDomainError
	if !errors.As(err, &ownershipRefusal) || otherOrgResult.OK || !strings.Contains(ownershipRefusal.Error(), "owned by another publisher") {
		t.Fatalf("foreign org publish result=%+v err=%v, want slug ownership refusal", otherOrgResult, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT submitted_by_org_id::text FROM marketplace_listings WHERE id=$1::uuid`, output.ListingID).Scan(&ownerOrgID); err != nil {
		t.Fatalf("re-read listing after foreign publish refusal: %v", err)
	}
	if ownerOrgID != fx.orgID {
		t.Fatalf("foreign publish changed listing owner=%s, want original org %s", ownerOrgID, fx.orgID)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed' AND actor_type='system'`, fx.orgID, creatorPublishListingCapabilityID); got != 1 {
		t.Fatalf("creator.publishListing audit rows=%d, want one successful governed publish", got)
	}
}

func TestGoCreatorMarketplaceHumanInstallIsSignedIdempotentAndTenantScoped(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.setModuleList(`["creator"]`)
	grantWavePermission(t, fx, "platform.creator")
	type listingFixture struct {
		id        string
		slug      string
		status    string
		manifest  string
		signature string
		publicKey string
		updatedAt time.Time
	}
	seedListing := func(slug, status string, signatureValid bool) listingFixture {
		t.Helper()
		manifestRaw := strings.Replace(creatorTestManifest, "acme-warehouse", slug, 1)
		manifest, err := creatorValidateManifest(json.RawMessage(manifestRaw))
		if err != nil {
			t.Fatalf("validate install manifest %s: %v", slug, err)
		}
		signature, publicKey := creatorTestPublisher(t, manifest)
		if !signatureValid {
			signature = "invalid-signature"
		}
		fixture := listingFixture{id: executorUUID(t), slug: slug, status: status, manifest: manifestRaw, signature: signature, publicKey: publicKey}
		installed, err := json.Marshal([]string{fx.otherOrgID})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO marketplace_listings
				(id, slug, name, version, summary, manifest, signature, publisher_public_key,
				 capability_ids, status, submitted_by_org_id, installed_by_org_ids)
			VALUES ($1::uuid, $2, 'Install proof listing', '1.2.3', 'Tenant install proof',
				 $3::jsonb, $4, $5, '["acme.cycleCount"]'::jsonb, $6, $7::uuid, $8::jsonb)`,
			fixture.id, fixture.slug, fixture.manifest, fixture.signature, fixture.publicKey, fixture.status, fx.otherOrgID, string(installed)); err != nil {
			t.Fatalf("seed marketplace install listing %s: %v", slug, err)
		}
		if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_at FROM marketplace_listings WHERE id=$1::uuid`, fixture.id).Scan(&fixture.updatedAt); err != nil {
			t.Fatalf("read initial marketplace listing timestamp %s: %v", fixture.id, err)
		}
		return fixture
	}
	validListing := seedListing("install-valid-"+executorUUID(t)[:8], "verified", true)
	invalidListing := seedListing("install-invalid-"+executorUUID(t)[:8], "verified", false)
	unverifiedListing := seedListing("install-unverified-"+executorUUID(t)[:8], "submitted", true)
	t.Cleanup(func() {
		for _, listing := range []listingFixture{validListing, invalidListing, unverifiedListing} {
			if _, err := fx.owner.Exec(context.Background(), `DELETE FROM marketplace_listings WHERE id=$1::uuid`, listing.id); err != nil {
				t.Errorf("clean marketplace install fixture %s: %v", listing.id, err)
			}
		}
	})
	install := func(listingID, intent string) (Result, error) {
		t.Helper()
		input, err := json.Marshal(CreatorInstallListingInput{ListingID: listingID})
		if err != nil {
			t.Fatal(err)
		}
		claims := waveModuleClaims(fx, creatorInstallListingCapabilityID, "platform.creator", input, "human", "", intent)
		return fx.executor.Execute(fx.ctx, claims, creatorInstallListingCapabilityID, input)
	}
	missing, err := install(executorUUID(t), "marketplace-human-install-missing")
	var missingRefusal CreatorDomainError
	if !errors.As(err, &missingRefusal) || !strings.Contains(missingRefusal.Error(), "listing not found") || missing.OK {
		t.Fatalf("install missing listing result=%+v err=%v, want not-found error", missing, err)
	}
	first, err := install(validListing.id, "marketplace-human-install-first")
	if err != nil || !first.OK || first.PendingApproval {
		t.Fatalf("first direct-human install result=%+v err=%v, want completed governed install", first, err)
	}
	var firstOutput CreatorInstallListingOutput
	if err := json.Unmarshal(first.Data, &firstOutput); err != nil || !firstOutput.Installed || firstOutput.Slug != validListing.slug || firstOutput.Version != "1.2.3" {
		t.Fatalf("first install data=%s output=%+v err=%v", first.Data, firstOutput, err)
	}
	readUpdatedAt := func(id string) time.Time {
		t.Helper()
		var updatedAt time.Time
		if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_at FROM marketplace_listings WHERE id=$1::uuid`, id).Scan(&updatedAt); err != nil {
			t.Fatalf("read marketplace listing timestamp %s: %v", id, err)
		}
		return updatedAt
	}
	firstUpdatedAt := readUpdatedAt(validListing.id)
	if !firstUpdatedAt.After(validListing.updatedAt) {
		t.Fatalf("first install updated_at=%s, want later than seeded value %s", firstUpdatedAt, validListing.updatedAt)
	}
	time.Sleep(2 * time.Millisecond)
	second, err := install(validListing.id, "marketplace-human-install-repeat")
	if err != nil || !second.OK || second.PendingApproval {
		t.Fatalf("repeated direct-human install result=%+v err=%v, want idempotent success", second, err)
	}
	secondUpdatedAt := readUpdatedAt(validListing.id)
	if !secondUpdatedAt.After(firstUpdatedAt) {
		t.Fatalf("repeat install updated_at=%s, want later than first install value %s", secondUpdatedAt, firstUpdatedAt)
	}
	readInstalled := func(id string) []string {
		t.Helper()
		var raw []byte
		if err := fx.owner.QueryRow(fx.ctx, `SELECT installed_by_org_ids FROM marketplace_listings WHERE id=$1::uuid`, id).Scan(&raw); err != nil {
			t.Fatalf("read installed organizations for %s: %v", id, err)
		}
		var installed []string
		if err := json.Unmarshal(raw, &installed); err != nil {
			t.Fatalf("decode installed organizations %s: %v", raw, err)
		}
		return installed
	}
	wantInstalled := []string{fx.otherOrgID, fx.orgID}
	if got := readInstalled(validListing.id); !reflect.DeepEqual(got, wantInstalled) {
		t.Fatalf("install organizations after repeat=%v, want existing other-org install preserved and current org added once: %v", got, wantInstalled)
	}
	type installFunctionPrivileges struct {
		role             string
		canReadExecute   bool
		canWriteExecute  bool
		publicCanExecute bool
		argumentCount    int
		safeDefinerCount int
	}
	privileges, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (installFunctionPrivileges, error) {
		var result installFunctionPrivileges
		err := tx.QueryRow(fx.ctx, `
			SELECT current_user,
				pg_catalog.has_function_privilege(current_user, 'public.chaste_marketplace_lock_listing(uuid)', 'EXECUTE'),
				pg_catalog.has_function_privilege(current_user, 'public.chaste_marketplace_install_listing(uuid)', 'EXECUTE'),
				(SELECT EXISTS (
					SELECT 1 FROM pg_catalog.pg_proc AS function
					CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))) AS grant_row
					WHERE function.oid IN (
						'public.chaste_marketplace_lock_listing(uuid)'::regprocedure,
						'public.chaste_marketplace_install_listing(uuid)'::regprocedure)
						AND grant_row.grantee=0 AND grant_row.privilege_type='EXECUTE')),
				(SELECT count(*)::int FROM pg_catalog.pg_proc AS function
					WHERE function.oid IN (
						'public.chaste_marketplace_lock_listing(uuid)'::regprocedure,
						'public.chaste_marketplace_install_listing(uuid)'::regprocedure)
						AND function.pronargs=1),
				(SELECT count(*)::int FROM pg_catalog.pg_proc AS function
					WHERE function.oid IN (
						'public.chaste_marketplace_lock_listing(uuid)'::regprocedure,
						'public.chaste_marketplace_install_listing(uuid)'::regprocedure)
						AND function.pronargs=1 AND function.prosecdef
						AND function.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])`).Scan(
			&result.role, &result.canReadExecute, &result.canWriteExecute, &result.publicCanExecute, &result.argumentCount, &result.safeDefinerCount)
		return result, err
	})
	if err != nil {
		t.Fatalf("read install function privileges as runtime role: %v", err)
	}
	if privileges.role != "chaste_app" || !privileges.canReadExecute || !privileges.canWriteExecute || privileges.publicCanExecute || privileges.argumentCount != 2 || privileges.safeDefinerCount != 2 {
		t.Fatalf("install function privileges=%+v, want app-only execution and two one-argument pinned SECURITY DEFINER functions", privileges)
	}
	_, scopeMismatchErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreatorInstallListingOutput, error) {
		return creatorInstallListing(fx.ctx, tx, fx.otherOrgID, CreatorInstallListingInput{ListingID: validListing.id})
	})
	if scopeMismatchErr == nil || !strings.Contains(scopeMismatchErr.Error(), "organization scope mismatch") {
		t.Fatalf("install with a claimed organization outside transaction scope returned %v, want scope mismatch", scopeMismatchErr)
	}
	updatedPublisherRows, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (int64, error) {
		tag, err := tx.Exec(fx.ctx, `UPDATE marketplace_listings SET name='unauthorized publisher edit' WHERE id=$1::uuid`, validListing.id)
		return tag.RowsAffected(), err
	})
	if err != nil {
		t.Fatalf("attempt publisher-field update as runtime role: %v", err)
	}
	if updatedPublisherRows != 0 {
		t.Fatalf("runtime role changed %d publisher-owned fields, want RLS to reject update", updatedPublisherRows)
	}
	var storedName, storedSignature, storedPublisherKey string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name, signature, publisher_public_key FROM marketplace_listings WHERE id=$1::uuid`, validListing.id).Scan(&storedName, &storedSignature, &storedPublisherKey); err != nil {
		t.Fatalf("read publisher fields after install: %v", err)
	}
	if storedName != "Install proof listing" || storedSignature != validListing.signature || storedPublisherKey != validListing.publicKey {
		t.Fatalf("install changed publisher fields: name=%q signature preserved=%t key preserved=%t", storedName, storedSignature == validListing.signature, storedPublisherKey == validListing.publicKey)
	}
	for _, test := range []struct {
		name    string
		listing listingFixture
		message string
	}{
		{name: "invalid signature", listing: invalidListing, message: "signature no longer verifies"},
		{name: "unverified status", listing: unverifiedListing, message: "refusing install"},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := install(test.listing.id, "marketplace-human-install-"+strings.ReplaceAll(test.name, " ", "-"))
			var refusal CreatorDomainError
			if !errors.As(err, &refusal) || result.OK || !strings.Contains(refusal.Error(), test.message) {
				t.Fatalf("install result=%+v err=%v, want refusal %q", result, err, test.message)
			}
			if got := readInstalled(test.listing.id); !reflect.DeepEqual(got, []string{fx.otherOrgID}) {
				t.Fatalf("refused install changed organizations to %v, want only existing other-org install", got)
			}
		})
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed' AND actor_type='human'`, fx.orgID, creatorInstallListingCapabilityID); got != 2 {
		t.Fatalf("creator.installListing audit rows=%d, want one governed record for each successful call", got)
	}
}

func TestGoCreatorMarketplaceHumanUninstallIsIdempotentAndTenantScoped(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.setModuleList(`["creator"]`)
	grantWavePermission(t, fx, "platform.creator")
	type listingFixture struct {
		id        string
		slug      string
		manifest  string
		signature string
		publicKey string
		updatedAt time.Time
	}
	seedListing := func(slug string, installedState any) listingFixture {
		t.Helper()
		manifestRaw := strings.Replace(creatorTestManifest, "acme-warehouse", slug, 1)
		manifest, err := creatorValidateManifest(json.RawMessage(manifestRaw))
		if err != nil {
			t.Fatalf("validate uninstall manifest %s: %v", slug, err)
		}
		signature, publicKey := creatorTestPublisher(t, manifest)
		installed, err := json.Marshal(installedState)
		if err != nil {
			t.Fatal(err)
		}
		fixture := listingFixture{id: executorUUID(t), slug: slug, manifest: manifestRaw, signature: signature, publicKey: publicKey}
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO marketplace_listings
				(id, slug, name, version, summary, manifest, signature, publisher_public_key,
				 capability_ids, status, submitted_by_org_id, installed_by_org_ids)
			VALUES ($1::uuid, $2, 'Uninstall proof listing', '1.2.3', 'Tenant uninstall proof',
				 $3::jsonb, $4, $5, '["acme.cycleCount"]'::jsonb, 'verified', $6::uuid, $7::jsonb)`,
			fixture.id, fixture.slug, fixture.manifest, fixture.signature, fixture.publicKey, fx.otherOrgID, string(installed)); err != nil {
			t.Fatalf("seed marketplace uninstall listing %s: %v", slug, err)
		}
		if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_at FROM marketplace_listings WHERE id=$1::uuid`, fixture.id).Scan(&fixture.updatedAt); err != nil {
			t.Fatalf("read initial marketplace listing timestamp %s: %v", fixture.id, err)
		}
		return fixture
	}
	installedListing := seedListing("uninstall-installed-"+executorUUID(t)[:8], []string{fx.orgID, fx.otherOrgID})
	notInstalledListing := seedListing("uninstall-absent-"+executorUUID(t)[:8], []string{fx.otherOrgID})
	malformedListing := seedListing("uninstall-malformed-"+executorUUID(t)[:8], map[string]string{"unexpected": "shape"})
	malformedElementListing := seedListing("uninstall-bad-element-"+executorUUID(t)[:8], []any{17, fx.otherOrgID})
	listings := []listingFixture{installedListing, notInstalledListing, malformedListing, malformedElementListing}
	t.Cleanup(func() {
		for _, listing := range listings {
			if _, err := fx.owner.Exec(context.Background(), `DELETE FROM marketplace_listings WHERE id=$1::uuid`, listing.id); err != nil {
				t.Errorf("clean marketplace uninstall fixture %s: %v", listing.id, err)
			}
		}
	})
	uninstall := func(listingID, intent string) (Result, error) {
		t.Helper()
		input, err := json.Marshal(CreatorUninstallListingInput{ListingID: listingID})
		if err != nil {
			t.Fatal(err)
		}
		claims := waveModuleClaims(fx, creatorUninstallListingCapabilityID, "platform.creator", input, "human", "", intent)
		return fx.executor.Execute(fx.ctx, claims, creatorUninstallListingCapabilityID, input)
	}
	stale, staleErr := uninstall(executorUUID(t), "marketplace-human-uninstall-missing")
	var staleRefusal CreatorDomainError
	if !errors.As(staleErr, &staleRefusal) || stale.OK || !strings.Contains(staleRefusal.Error(), "listing not found") {
		t.Fatalf("uninstall missing listing result=%+v err=%v, want typed not-found refusal", stale, staleErr)
	}
	initialUpdatedAt := installedListing.updatedAt
	first, err := uninstall(installedListing.id, "marketplace-human-uninstall-first")
	if err != nil || !first.OK || first.PendingApproval {
		t.Fatalf("first direct-human uninstall result=%+v err=%v, want completed uninstall", first, err)
	}
	var firstOutput CreatorUninstallListingOutput
	if err := json.Unmarshal(first.Data, &firstOutput); err != nil || !firstOutput.Uninstalled {
		t.Fatalf("first uninstall data=%s output=%+v err=%v", first.Data, firstOutput, err)
	}
	readInstalled := func(id string) []string {
		t.Helper()
		var raw []byte
		if err := fx.owner.QueryRow(fx.ctx, `SELECT installed_by_org_ids FROM marketplace_listings WHERE id=$1::uuid`, id).Scan(&raw); err != nil {
			t.Fatalf("read installed organizations for %s: %v", id, err)
		}
		var installed []string
		if err := json.Unmarshal(raw, &installed); err != nil {
			t.Fatalf("decode installed organizations %s: %v", raw, err)
		}
		return installed
	}
	if got := readInstalled(installedListing.id); !reflect.DeepEqual(got, []string{fx.otherOrgID}) {
		t.Fatalf("uninstall organizations=%v, want only the other organization's installation", got)
	}
	var firstUpdatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_at FROM marketplace_listings WHERE id=$1::uuid`, installedListing.id).Scan(&firstUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if !firstUpdatedAt.After(initialUpdatedAt) {
		t.Fatalf("first uninstall updated_at=%s, want later than seeded value %s", firstUpdatedAt, initialUpdatedAt)
	}
	time.Sleep(2 * time.Millisecond)
	repeated, err := uninstall(installedListing.id, "marketplace-human-uninstall-repeat")
	if err != nil || !repeated.OK {
		t.Fatalf("repeated direct-human uninstall result=%+v err=%v, want idempotent success", repeated, err)
	}
	var repeatUpdatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_at FROM marketplace_listings WHERE id=$1::uuid`, installedListing.id).Scan(&repeatUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if !repeatUpdatedAt.After(firstUpdatedAt) {
		t.Fatalf("repeat uninstall updated_at=%s, want later than first uninstall value %s", repeatUpdatedAt, firstUpdatedAt)
	}
	notInstalled, err := uninstall(notInstalledListing.id, "marketplace-human-uninstall-absent")
	if err != nil || !notInstalled.OK {
		t.Fatalf("uninstall of absent organization result=%+v err=%v, want idempotent success", notInstalled, err)
	}
	if got := readInstalled(notInstalledListing.id); !reflect.DeepEqual(got, []string{fx.otherOrgID}) {
		t.Fatalf("uninstall of absent organization changed state to %v, want other organization preserved", got)
	}
	malformed, err := uninstall(malformedListing.id, "marketplace-human-uninstall-malformed")
	if err == nil || malformed.OK || !strings.Contains(err.Error(), "installation state") {
		t.Fatalf("malformed state uninstall result=%+v err=%v, want shape validation refusal", malformed, err)
	}
	var malformedState []byte
	if err := fx.owner.QueryRow(fx.ctx, `SELECT installed_by_org_ids FROM marketplace_listings WHERE id=$1::uuid`, malformedListing.id).Scan(&malformedState); err != nil {
		t.Fatal(err)
	}
	var decodedMalformed map[string]string
	if err := json.Unmarshal(malformedState, &decodedMalformed); err != nil || !reflect.DeepEqual(decodedMalformed, map[string]string{"unexpected": "shape"}) {
		t.Fatalf("malformed-state uninstall mutated installed_by_org_ids=%s err=%v", malformedState, err)
	}
	malformedElement, err := uninstall(malformedElementListing.id, "marketplace-human-uninstall-bad-element")
	if err == nil || malformedElement.OK || !strings.Contains(err.Error(), "organization ID") {
		t.Fatalf("malformed-element uninstall result=%+v err=%v, want shape validation refusal", malformedElement, err)
	}
	var malformedElements []any
	if err := fx.owner.QueryRow(fx.ctx, `SELECT installed_by_org_ids FROM marketplace_listings WHERE id=$1::uuid`, malformedElementListing.id).Scan(&malformedState); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(malformedState, &malformedElements); err != nil || !reflect.DeepEqual(malformedElements, []any{float64(17), fx.otherOrgID}) {
		t.Fatalf("malformed-element uninstall mutated installed_by_org_ids=%s err=%v", malformedState, err)
	}
	missing, err := uninstall(executorUUID(t), "marketplace-human-uninstall-missing")
	if err == nil || missing.OK || !strings.Contains(err.Error(), "listing not found") {
		t.Fatalf("stale listing uninstall result=%+v err=%v, want not-found error", missing, err)
	}
	_, scopeMismatchErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreatorUninstallListingOutput, error) {
		return creatorUninstallListing(fx.ctx, tx, fx.otherOrgID, CreatorUninstallListingInput{ListingID: installedListing.id})
	})
	if scopeMismatchErr == nil || !strings.Contains(scopeMismatchErr.Error(), "organization scope mismatch") {
		t.Fatalf("uninstall with a claimed organization outside transaction scope returned %v, want scope mismatch", scopeMismatchErr)
	}
	type helperPrivileges struct {
		role               string
		canUninstall       bool
		publicCanExecute   bool
		oneArgumentCount   int
		pinnedDefinerCount int
	}
	privileges, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (helperPrivileges, error) {
		var result helperPrivileges
		err := tx.QueryRow(fx.ctx, `
			SELECT current_user,
				pg_catalog.has_function_privilege(current_user, 'public.chaste_marketplace_uninstall_listing(uuid)', 'EXECUTE'),
				(SELECT EXISTS (
					SELECT 1 FROM pg_catalog.pg_proc AS function
					CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))) AS grant_row
					WHERE function.oid='public.chaste_marketplace_uninstall_listing(uuid)'::regprocedure
						AND grant_row.grantee=0 AND grant_row.privilege_type='EXECUTE')),
				(SELECT count(*)::int FROM pg_catalog.pg_proc AS function
					WHERE function.oid='public.chaste_marketplace_uninstall_listing(uuid)'::regprocedure
						AND function.pronargs=1),
				(SELECT count(*)::int FROM pg_catalog.pg_proc AS function
					WHERE function.oid='public.chaste_marketplace_uninstall_listing(uuid)'::regprocedure
						AND function.pronargs=1 AND function.prosecdef
						AND function.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])`).Scan(
			&result.role, &result.canUninstall, &result.publicCanExecute, &result.oneArgumentCount, &result.pinnedDefinerCount)
		return result, err
	})
	if err != nil {
		t.Fatalf("read uninstall helper privileges as runtime role: %v", err)
	}
	if privileges.role != "chaste_app" || !privileges.canUninstall || privileges.publicCanExecute || privileges.oneArgumentCount != 1 || privileges.pinnedDefinerCount != 1 {
		t.Fatalf("uninstall helper privileges=%+v, want one-argument pinned SECURITY DEFINER executable only by chaste_app", privileges)
	}
	updatedPublisherRows, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (int64, error) {
		tag, err := tx.Exec(fx.ctx, `UPDATE marketplace_listings SET name='unauthorized publisher edit' WHERE id=$1::uuid`, installedListing.id)
		return tag.RowsAffected(), err
	})
	if err != nil || updatedPublisherRows != 0 {
		t.Fatalf("runtime publisher-field update rows=%d err=%v, want RLS rejection", updatedPublisherRows, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed' AND actor_type='human'`, fx.orgID, creatorUninstallListingCapabilityID); got != 3 {
		t.Fatalf("creator.uninstallListing audit rows=%d, want one governed record for each successful uninstall", got)
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
