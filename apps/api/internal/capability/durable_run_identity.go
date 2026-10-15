package capability

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type DurableRunCompositionIdentity struct {
	ID                string
	ProfileID         string
	ProfileVersion    string
	CompositionDigest string
}

// VerifyDurableRunCompositionTx confirms that the approved tenant composition
// still matches its persisted profile, bundle, patch, and approval digests.
// The caller must run it inside dbx.WithOrgTx for orgID.
func VerifyDurableRunCompositionTx(ctx context.Context, tx pgx.Tx, orgID, compositionID, compositionDigest, approvalID string) (DurableRunCompositionIdentity, error) {
	if tx == nil || !isUUID(orgID) || !isUUID(compositionID) || !isUUID(approvalID) || !harnessDigestPattern.MatchString(compositionDigest) {
		return DurableRunCompositionIdentity{}, errors.New("invalid durable run composition identity")
	}
	var identity DurableRunCompositionIdentity
	var profileDigest string
	var profile, bundles, patches []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, profile_id, profile_version, profile_digest, composition_digest, profile, bundles, patches
		FROM harness_compositions
		WHERE org_id=$1::uuid AND id=$2::uuid`, orgID, compositionID).Scan(
		&identity.ID, &identity.ProfileID, &identity.ProfileVersion, &profileDigest,
		&identity.CompositionDigest, &profile, &bundles, &patches)
	if errors.Is(err, pgx.ErrNoRows) {
		return DurableRunCompositionIdentity{}, errors.New("harness composition not found for organization")
	}
	if err != nil {
		return DurableRunCompositionIdentity{}, err
	}
	if err := harnessAssertPersistedIdentity(identity.ID, profileDigest, identity.CompositionDigest, profile, bundles, patches); err != nil {
		return DurableRunCompositionIdentity{}, err
	}
	if err := harnessAssertApprovalIdentity(identity.CompositionDigest, compositionDigest); err != nil {
		return DurableRunCompositionIdentity{}, err
	}
	var approved bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM approvals
			WHERE id=$1::uuid AND org_id=$2::uuid
			  AND capability_id=$3 AND status='executed'
			  AND payload->>'compositionId'=$4
			  AND payload->>'compositionDigest'=$5
		)`, approvalID, orgID, harnessApproveCompositionCapabilityID, compositionID, compositionDigest).Scan(&approved)
	if err != nil {
		return DurableRunCompositionIdentity{}, err
	}
	if !approved {
		return DurableRunCompositionIdentity{}, fmt.Errorf("harness composition approval is missing or not executed")
	}
	return identity, nil
}

func DurableRunCapabilityRisk(capabilityID string) (string, bool) {
	spec, ok := capabilitySpecs[capabilityID]
	if !ok || !supportedCapability(capabilityID) {
		return "", false
	}
	return spec.risk, true
}
