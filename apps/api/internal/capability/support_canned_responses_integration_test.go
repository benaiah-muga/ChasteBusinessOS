package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoSupportCreateCannedResponseIsOrgScopedAndReplaysExactIntent(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.write")

	var foreignID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_canned_responses (org_id, shortcut, title, body)
		VALUES ($1::uuid, '/refund', 'Foreign refund', 'Foreign body')
		RETURNING id::text`, fx.otherOrgID).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}

	firstInput := json.RawMessage(`{"shortcut":"/refund","title":"Refund help","body":"Original refund guidance"}`)
	firstClaims := waveModuleClaims(fx, supportCreateCannedResponseCapabilityID, "support.write", firstInput, "human", "", "support-canned-create-first-intent")
	first, err := fx.executor.Execute(fx.ctx, firstClaims, supportCreateCannedResponseCapabilityID, firstInput)
	if err != nil || !first.OK || first.Replayed {
		t.Fatalf("first create result=%+v err=%v, want new successful effect", first, err)
	}
	var created SupportCreateCannedResponseOutput
	if err := json.Unmarshal(first.Data, &created); err != nil {
		t.Fatalf("decode create result %s: %v", first.Data, err)
	}
	if !isUUID(created.CannedResponseID) || string(first.Data) != `{"cannedResponseId":"`+created.CannedResponseID+`"}` {
		t.Fatalf("create output=%s, want only the created cannedResponseId", first.Data)
	}

	replay, err := fx.executor.Execute(fx.ctx, firstClaims, supportCreateCannedResponseCapabilityID, firstInput)
	var replayed SupportCreateCannedResponseOutput
	if err == nil {
		err = json.Unmarshal(replay.Data, &replayed)
	}
	if err != nil || !replay.OK || !replay.Replayed || replayed != created {
		t.Fatalf("same-intent replay=%+v err=%v, want the original output receipt", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2 AND capability_id=$3`, fx.orgID, fx.orgID+":"+firstClaims.IntentID, supportCreateCannedResponseCapabilityID); got != 1 {
		t.Fatalf("first intent receipts=%d, want one", got)
	}

	updatedInput := json.RawMessage(`{"shortcut":"/refund","title":"Updated refund help","body":"Updated refund guidance"}`)
	updatedClaims := waveModuleClaims(fx, supportCreateCannedResponseCapabilityID, "support.write", updatedInput, "human", "", "support-canned-create-update-intent")
	updated, err := fx.executor.Execute(fx.ctx, updatedClaims, supportCreateCannedResponseCapabilityID, updatedInput)
	if err != nil || !updated.OK || updated.Replayed {
		t.Fatalf("same-org upsert=%+v err=%v, want a new successful update", updated, err)
	}
	var updatedOut SupportCreateCannedResponseOutput
	if err := json.Unmarshal(updated.Data, &updatedOut); err != nil {
		t.Fatalf("decode upsert result %s: %v", updated.Data, err)
	}
	if updatedOut.CannedResponseID != created.CannedResponseID {
		t.Fatalf("upsert ID=%s, want original ID %s", updatedOut.CannedResponseID, created.CannedResponseID)
	}
	var title, body string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT title, body FROM support_canned_responses
		WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, created.CannedResponseID).Scan(&title, &body); err != nil {
		t.Fatal(err)
	}
	if title != "Updated refund help" || body != "Updated refund guidance" {
		t.Fatalf("upsert row=(%q,%q), want updated content", title, body)
	}
	if got := fx.count(`SELECT count(*) FROM support_canned_responses WHERE org_id=$1::uuid AND shortcut='/refund'`, fx.orgID); got != 1 {
		t.Fatalf("same-org rows with shortcut=%d, want one", got)
	}

	updatedReplay, err := fx.executor.Execute(fx.ctx, updatedClaims, supportCreateCannedResponseCapabilityID, updatedInput)
	var replayedUpdate SupportCreateCannedResponseOutput
	if err == nil {
		err = json.Unmarshal(updatedReplay.Data, &replayedUpdate)
	}
	if err != nil || !updatedReplay.OK || !updatedReplay.Replayed || replayedUpdate != updatedOut {
		t.Fatalf("upsert intent replay=%+v err=%v, want the original update receipt", updatedReplay, err)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND capability_id=$2`, fx.orgID, supportCreateCannedResponseCapabilityID); got != 2 {
		t.Fatalf("canned response receipts=%d, want one receipt per distinct intent", got)
	}

	var foreignTitle, foreignBody string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT title, body FROM support_canned_responses
		WHERE org_id=$1::uuid AND id=$2::uuid`, fx.otherOrgID, foreignID).Scan(&foreignTitle, &foreignBody); err != nil {
		t.Fatal(err)
	}
	if foreignTitle != "Foreign refund" || foreignBody != "Foreign body" {
		t.Fatalf("other organization row=(%q,%q), want its original content", foreignTitle, foreignBody)
	}
	if got := fx.count(`SELECT count(*) FROM support_canned_responses WHERE org_id=$1::uuid AND shortcut='/refund'`, fx.otherOrgID); got != 1 {
		t.Fatalf("other organization rows with shortcut=%d, want one", got)
	}

	denied, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportCreateCannedResponseCapabilityID, "crm.write", firstInput, "human", "", "support-canned-create-denied-intent"),
		supportCreateCannedResponseCapabilityID, firstInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: support.write") {
		t.Fatalf("missing support.write result=%+v err=%v, want permission denial", denied, err)
	}
}

func TestGoSupportCreateCannedResponseApprovalRevalidatesAndExecutes(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.write")
	fx.addAgentSession()
	fx.addPolicy(supportCreateCannedResponseCapabilityID, "read", nil)

	input := json.RawMessage(`{"shortcut":"/approval","title":"Approval help","body":"Approved guidance"}`)
	created := approveModuleWrite(t, fx, supportCreateCannedResponseCapabilityID, "support.write", input)
	if !created.OK || created.PendingApproval {
		t.Fatalf("approved create result=%+v, want completed effect", created)
	}
	var output SupportCreateCannedResponseOutput
	if err := json.Unmarshal(created.Data, &output); err != nil {
		t.Fatalf("decode approved create result %s: %v", created.Data, err)
	}
	if !isUUID(output.CannedResponseID) {
		t.Fatalf("approved create output=%+v, want UUID cannedResponseId", output)
	}
	if got := fx.count(`SELECT count(*) FROM support_canned_responses WHERE org_id=$1::uuid AND id=$2::uuid AND shortcut='/approval'`, fx.orgID, output.CannedResponseID); got != 1 {
		t.Fatalf("approved canned responses=%d, want one effect", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='executed'`, fx.orgID, supportCreateCannedResponseCapabilityID); got != 1 {
		t.Fatalf("executed approvals=%d, want one", got)
	}
}
