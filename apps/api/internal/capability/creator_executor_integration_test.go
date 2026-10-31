package capability

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
)

func TestGoCreatorProposalGovernedExecutorEnforcesModuleGrantTenantAndReceipt(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"title":"Governed Creator proposal","summary":"A complete proposal submitted through the capability executor.","diffText":"--- a/modules/example.ts\n+++ b/modules/example.ts\n+export {};","testEvidence":"focused tests passed","riskAssessment":"No production change until review."}`)
	claims := waveModuleClaims(fx, creatorSubmitProposalCapabilityID, "platform.creator", input, "human", "", "creator-proposal-disabled-module")

	fx.setModuleList(`[]`)
	disabled, err := fx.executor.Execute(fx.ctx, claims, creatorSubmitProposalCapabilityID, input)
	if err != nil || disabled.OK || !strings.Contains(disabled.Error, `module "creator" is disabled`) {
		t.Fatalf("creator.submitProposal with disabled module result=%+v err=%v, want module denial", disabled, err)
	}
	if got := fx.count(`SELECT count(*) FROM creator_proposals WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("disabled Creator module created %d proposals, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, creatorSubmitProposalCapabilityID); got != 0 {
		t.Fatalf("disabled Creator module appended %d execution audits, want none", got)
	}

	fx.setModuleList(`["creator"]`)
	claims = waveModuleClaims(fx, creatorSubmitProposalCapabilityID, "platform.creator", input, "human", "", "creator-proposal-missing-grant")
	denied, err := fx.executor.Execute(fx.ctx, claims, creatorSubmitProposalCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: platform.creator") {
		t.Fatalf("creator.submitProposal without stored grant result=%+v err=%v, want permission denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM creator_proposals WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("ungranted Creator execution created %d proposals, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, creatorSubmitProposalCapabilityID); got != 0 {
		t.Fatalf("ungranted Creator execution appended %d execution audits, want none", got)
	}

	grantWavePermission(t, fx, "platform.creator")
	writeClaims := waveModuleClaims(fx, creatorSubmitProposalCapabilityID, "platform.creator", input, "human", "", "creator-proposal-write")
	result, err := fx.executor.Execute(fx.ctx, writeClaims, creatorSubmitProposalCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("creator.submitProposal result=%+v err=%v, want successful governed write", result, err)
	}
	var output CreatorSubmitProposalOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !isUUID(output.ProposalID) {
		t.Fatalf("creator.submitProposal output=%s parsed=%+v err=%v, want a proposal UUID", result.Data, output, err)
	}
	if got := fx.count(`
		SELECT count(*) FROM creator_proposals
		WHERE id=$1::uuid AND org_id=$2::uuid AND title=$3 AND summary=$4 AND diff_text=$5
		  AND status='in_review' AND proposed_by_actor_type='human' AND proposed_by_actor_id=$6::uuid`,
		output.ProposalID, fx.orgID, "Governed Creator proposal", "A complete proposal submitted through the capability executor.",
		"--- a/modules/example.ts\n+++ b/modules/example.ts\n+export {};", fx.userID); got != 1 {
		t.Fatalf("Creator proposal row count=%d, want one correctly scoped and actor-attributed proposal", got)
	}
	if got := fx.count(`
		SELECT count(*) FROM ledger_events
		WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human' AND actor_id=$3::uuid`,
		fx.orgID, creatorSubmitProposalCapabilityID, fx.userID); got != 1 {
		t.Fatalf("Creator human execution audit rows=%d, want one attributed audit", got)
	}
	if got := fx.count(`
		SELECT count(*) FROM action_receipts
		WHERE org_id=$1::uuid AND intent_key=$2 AND capability_id=$3 AND ok AND outcome='known'`,
		fx.orgID, fx.orgID+":creator-proposal-write", creatorSubmitProposalCapabilityID); got != 1 {
		t.Fatalf("Creator write receipt rows=%d, want one successful receipt for its intent and input", got)
	}

	replayed, err := fx.executor.Execute(fx.ctx, writeClaims, creatorSubmitProposalCapabilityID, input)
	var replayedOutput CreatorSubmitProposalOutput
	if err != nil || !replayed.OK || !replayed.Replayed || json.Unmarshal(replayed.Data, &replayedOutput) != nil || replayedOutput.ProposalID != output.ProposalID {
		t.Fatalf("creator.submitProposal receipt replay=%+v err=%v, want original response", replayed, err)
	}
	if got := fx.count(`SELECT count(*) FROM creator_proposals WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("receipt replay left %d Creator proposals, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, creatorSubmitProposalCapabilityID); got != 1 {
		t.Fatalf("receipt replay appended %d Creator execution audits, want exactly one", got)
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO creator_proposals (org_id, title, summary, diff_text, proposed_by_actor_type)
		VALUES ($1::uuid, 'Foreign proposal sentinel', 'A proposal belonging to another organization.', 'foreign diff', 'system')`, fx.otherOrgID); err != nil {
		t.Fatalf("seed foreign Creator proposal: %v", err)
	}
	listInput := json.RawMessage(`{}`)
	listClaims := waveModuleClaims(fx, creatorListProposalsCapabilityID, "platform.creator", listInput, "human", "", "creator-proposal-org-list")
	listed, err := fx.executor.Execute(fx.ctx, listClaims, creatorListProposalsCapabilityID, listInput)
	if err != nil || !listed.OK {
		t.Fatalf("creator.listProposals result=%+v err=%v", listed, err)
	}
	var listOutput CreatorListProposalsOutput
	if err := json.Unmarshal(listed.Data, &listOutput); err != nil {
		t.Fatalf("decode creator.listProposals output %s: %v", listed.Data, err)
	}
	if len(listOutput.Proposals) != 1 || listOutput.Proposals[0].ID != output.ProposalID || listOutput.Proposals[0].Title != "Governed Creator proposal" {
		t.Fatalf("local organization proposal list=%+v, want only its own proposal and not foreign sentinel", listOutput.Proposals)
	}
	listedProposal := listOutput.Proposals[0]
	if listedProposal.Summary != "A complete proposal submitted through the capability executor." || !strings.Contains(listedProposal.DiffText, "+export {};") || listedProposal.TestEvidence == nil || *listedProposal.TestEvidence != "focused tests passed" || listedProposal.RiskAssessment == nil || *listedProposal.RiskAssessment != "No production change until review." || listedProposal.GapTicketID != nil || len(listedProposal.Releases) != 0 {
		t.Fatalf("full proposal list item=%+v, missing page-required fields or empty release list", listedProposal)
	}

	reviewInput := json.RawMessage(`{"proposalId":"` + output.ProposalID + `","decision":"approved","comment":"Reviewed through Go"}`)
	reviewClaims := waveModuleClaims(fx, creatorReviewProposalCapabilityID, "platform.creator", reviewInput, "human", "", "creator-proposal-review")
	reviewed, err := fx.executor.Execute(fx.ctx, reviewClaims, creatorReviewProposalCapabilityID, reviewInput)
	if err != nil || !reviewed.OK {
		t.Fatalf("creator.reviewProposal result=%+v err=%v, want recorded decision", reviewed, err)
	}
	var reviewOutput CreatorReviewProposalOutput
	if err := json.Unmarshal(reviewed.Data, &reviewOutput); err != nil || reviewOutput.Note != "decision recorded; merge the change through your normal PR flow" {
		t.Fatalf("creator.reviewProposal output=%s parsed=%+v err=%v", reviewed.Data, reviewOutput, err)
	}
	conflictInput := json.RawMessage(`{"proposalId":"` + output.ProposalID + `","decision":"rejected"}`)
	conflict, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, creatorReviewProposalCapabilityID, "platform.creator", conflictInput, "human", "", "creator-proposal-review-conflict"), creatorReviewProposalCapabilityID, conflictInput)
	if err == nil || !strings.Contains(err.Error(), "conflict: proposal already decided") {
		t.Fatalf("creator.reviewProposal second decision=%+v err=%v, want compare-and-set conflict", conflict, err)
	}

	localGapID := executorUUID(t)
	foreignGapID := executorUUID(t)
	for _, gap := range []struct {
		id    string
		orgID string
		title string
	}{{localGapID, fx.orgID, "Local capability gap"}, {foreignGapID, fx.otherOrgID, "Foreign capability gap"}} {
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO tickets (id, org_id, title, description, origin) VALUES ($1::uuid, $2::uuid, $3, 'A capability gap for listing verification.', 'capability_gap')`, gap.id, gap.orgID, gap.title); err != nil {
			t.Fatalf("seed %s: %v", gap.title, err)
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE creator_proposals SET gap_ticket_id=$2::uuid WHERE id=$1::uuid`, output.ProposalID, localGapID); err != nil {
		t.Fatalf("link proposal to local gap: %v", err)
	}
	_, refusalErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := creatorStageCandidate(fx.ctx, tx, fx.orgID, CreatorStageCandidateInput{
			ProposalID: output.ProposalID, GapTicketID: localGapID,
			CandidateDigest: strings.Repeat("a", 64), ArtifactRef: "artifact://creator/unverified",
		})
		return struct{}{}, err
	})
	var creatorRefusal CreatorDomainError
	if !errors.As(refusalErr, &creatorRefusal) || !strings.Contains(creatorRefusal.Error(), "valid isolated candidate evidence") {
		t.Fatalf("stage unverified Creator proposal error=%v, want typed domain refusal", refusalErr)
	}
	var releaseID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO creator_evolution_releases (org_id, proposal_id, gap_ticket_id, candidate_digest, artifact_ref, status, staged_at, promoted_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, repeat('a', 64), 'artifact://creator/list-proof', 'promoted', '2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z')
		RETURNING id::text`, fx.orgID, output.ProposalID, localGapID).Scan(&releaseID); err != nil {
		t.Fatalf("seed Creator release: %v", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO creator_evolution_outcomes (org_id, release_id, gap_ticket_id, candidate_digest, verdict, evidence_ref, metrics, observed_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, repeat('a', 64), 'pass', 'evidence://creator/list-proof', '{"latencyMs":12,"healthy":true}'::jsonb, '2026-10-03T12:00:00Z')`, fx.orgID, releaseID, localGapID); err != nil {
		t.Fatalf("seed Creator release outcome: %v", err)
	}
	var secondReleaseID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO creator_evolution_releases (org_id, proposal_id, gap_ticket_id, candidate_digest, artifact_ref, status, staged_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, repeat('b', 64), 'artifact://creator/list-proof-second', 'rolled_back', '2026-10-04T12:00:00Z')
		RETURNING id::text`, fx.orgID, output.ProposalID, localGapID).Scan(&secondReleaseID); err != nil {
		t.Fatalf("seed second Creator release: %v", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO creator_evolution_outcomes (org_id, release_id, gap_ticket_id, candidate_digest, verdict, evidence_ref, metrics, observed_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, repeat('b', 64), 'fail', 'evidence://creator/list-proof-second', '{"healthy":false}'::jsonb, '2026-10-05T12:00:00Z')`, fx.orgID, secondReleaseID, localGapID); err != nil {
		t.Fatalf("seed second Creator release outcome: %v", err)
	}
	listed, err = fx.executor.Execute(fx.ctx, waveModuleClaims(fx, creatorListProposalsCapabilityID, "platform.creator", listInput, "human", "", "creator-proposal-org-list-full"), creatorListProposalsCapabilityID, listInput)
	if err != nil || !listed.OK || json.Unmarshal(listed.Data, &listOutput) != nil {
		t.Fatalf("creator.listProposals full result=%+v err=%v", listed, err)
	}
	if len(listOutput.Proposals) != 1 {
		t.Fatalf("full proposal list=%+v, want one local proposal", listOutput.Proposals)
	}
	listedProposal = listOutput.Proposals[0]
	if listedProposal.Status != "approved" || listedProposal.GapTicketID == nil || *listedProposal.GapTicketID != localGapID || listedProposal.ReviewComment == nil || *listedProposal.ReviewComment != "Reviewed through Go" || len(listedProposal.Releases) != 2 {
		t.Fatalf("reviewed proposal=%+v, missing review or release data", listedProposal)
	}
	listedRelease := listedProposal.Releases[0]
	var metrics map[string]any
	if len(listedRelease.Outcomes) == 1 {
		_ = json.Unmarshal(listedRelease.Outcomes[0].Metrics, &metrics)
	}
	if listedRelease.ID != releaseID || listedRelease.Status != "promoted" || listedRelease.GapTicketID == nil || *listedRelease.GapTicketID != localGapID || len(listedRelease.Outcomes) != 1 || listedRelease.Outcomes[0].ID == "" || metrics["healthy"] != true || metrics["latencyMs"] != float64(12) || listedProposal.Releases[1].ID != secondReleaseID || len(listedProposal.Releases[1].Outcomes) != 1 || listedProposal.Releases[1].Outcomes[0].Verdict != "fail" {
		t.Fatalf("listed release=%+v, missing nested release evidence", listedRelease)
	}

	gapInput := json.RawMessage(`{}`)
	gaps, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, creatorListCapabilityGapsCapabilityID, "platform.creator", gapInput, "human", "", "creator-gap-list"), creatorListCapabilityGapsCapabilityID, gapInput)
	if err != nil || !gaps.OK {
		t.Fatalf("creator.listCapabilityGaps result=%+v err=%v", gaps, err)
	}
	var gapOutput CreatorListCapabilityGapsOutput
	if err := json.Unmarshal(gaps.Data, &gapOutput); err != nil || len(gapOutput.Gaps) != 1 || gapOutput.Gaps[0].ID != localGapID {
		t.Fatalf("creator.listCapabilityGaps output=%s parsed=%+v err=%v, want only local capability gap", gaps.Data, gapOutput, err)
	}
}
