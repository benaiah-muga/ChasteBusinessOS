package capability

import (
	"encoding/json"
	"strings"
	"testing"
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
}
