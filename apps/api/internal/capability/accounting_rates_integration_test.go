package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func TestGoRecordFxRateMatchesLegacy(t *testing.T) {
	fx := newExecutorFixture(t)
	validInput := json.RawMessage(`{"quoteCurrency":"eur","rate":"1.2500","effectiveAt":"2025-02-03T04:05:06.123456Z","ignored":"stripped"}`)
	fx.setModuleList(`["crm"]`)
	result, err := fx.executor.Execute(fx.ctx, recordFxRateClaims(fx, validInput, "human", "", ""), recordFxRateCapabilityID, validInput)
	if err != nil || result.OK || result.Error != `module "accounting" is disabled for this organization` {
		t.Fatalf("disabled module result=%+v err=%v, want accounting module denial", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM fx_rates WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("disabled module wrote %d FX rates, want none", got)
	}
	fx.setModuleList(`null`)

	withoutPermission := recordFxRateClaims(fx, validInput, "human", "", "")
	withoutPermission.Permissions = []string{"crm.write"}
	result, err = fx.executor.Execute(fx.ctx, withoutPermission, recordFxRateCapabilityID, validInput)
	if err != nil || result.OK || result.Error != "forbidden: missing permission: accounting.post" {
		t.Fatalf("missing permission result=%+v err=%v, want accounting.post denial", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM fx_rates WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("permission-denied call wrote %d FX rates, want none", got)
	}

	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'accounting.post', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	fx.addAgentSession()
	fx.addPolicy(recordFxRateCapabilityID, "read", nil)
	agentClaims := recordFxRateClaims(fx, validInput, "agent", fx.agentSession, "agent-rate-policy")
	result, err = fx.executor.Execute(fx.ctx, agentClaims, recordFxRateCapabilityID, validInput)
	if err != nil || result.OK || !result.PendingApproval || result.Error != "pending human approval" {
		t.Fatalf("agent policy result=%+v err=%v, want pending approval", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM fx_rates WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("policy-gated call wrote %d FX rates, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("policy-gated call wrote %d action receipts, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'`, fx.orgID, recordFxRateCapabilityID); got != 1 {
		t.Fatalf("policy-gated approvals=%d, want one pending approval", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, recordFxRateCapabilityID); got != 1 {
		t.Fatalf("policy approval audit events=%d, want one", got)
	}
	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals
		WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'`, fx.orgID, recordFxRateCapabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	approvalInput := json.RawMessage(`{"quoteCurrency":"eur","rate":"1.2500","effectiveAt":"2025-02-03T04:05:06.123456Z"}`)
	approvalClaims := recordFxRateClaims(fx, approvalInput, "human", "", "")
	comment := "verified treasury rate"
	decision, err := NewApprovalDecider(fx.runtime, fx.executor).Decide(fx.ctx, approvalClaims, ApprovalDecisionInput{
		ApprovalID: approvalID,
		Decision:   "approve",
		Comment:    &comment,
	})
	if err != nil || !decision.OK || decision.Status != "executed" || decision.Result == nil || !decision.Result.OK {
		t.Fatalf("approve FX-rate decision=%+v err=%v, want one successful execution", decision, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id=$1::uuid AND status='executed' AND decided_by_user_id=$2::uuid AND decision_comment=$3`, approvalID, fx.userID, comment); got != 1 {
		t.Fatalf("approved FX-rate rows=%d, want one attributed decision", got)
	}
	var approvedOutput RecordFxRateOutput
	if err := json.Unmarshal(decision.Result.Data, &approvedOutput); err != nil {
		t.Fatalf("decode approved FX-rate output %s: %v", decision.Result.Data, err)
	}
	if approvedOutput.RateID == "" || approvedOutput.Num != 5 || approvedOutput.Den != 4 {
		t.Fatalf("approved FX-rate output=%+v, want one persisted 5/4 rate", approvedOutput)
	}
	if got := fx.count(`SELECT count(*) FROM fx_rates WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("human approval created %d FX-rate rows, want exactly one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human' AND actor_id=$3::uuid`, fx.orgID, recordFxRateCapabilityID, fx.userID); got != 1 {
		t.Fatalf("human approval execution audit events=%d, want exactly one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":agent-rate-policy"); got != 1 {
		t.Fatalf("approval execution wrote %d action receipts for its intent, want one replay receipt", got)
	}
	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM policies WHERE org_id=$1::uuid AND capability_pattern=$2`, fx.orgID, recordFxRateCapabilityID); err != nil {
		t.Fatal(err)
	}

	claims := recordFxRateClaims(fx, validInput, "human", "", "record-eur-rate-once")
	result, err = fx.executor.Execute(fx.ctx, claims, recordFxRateCapabilityID, validInput)
	if err != nil || !result.OK || result.PendingApproval {
		t.Fatalf("recordFxRate result=%+v err=%v, want successful rate record", result, err)
	}
	var output RecordFxRateOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode recordFxRate output %s: %v", result.Data, err)
	}
	if output.RateID == "" || output.Num != 5 || output.Den != 4 {
		t.Fatalf("recordFxRate output=%+v, want a stored 5/4 rate", output)
	}
	var base, quote, source, actorType, actorID string
	var rateNum, rateDen int64
	var effectiveAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT base, quote, rate_num, rate_den, effective_at, source, recorded_by_actor_type, recorded_by_actor_id::text
		FROM fx_rates WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, output.RateID).
		Scan(&base, &quote, &rateNum, &rateDen, &effectiveAt, &source, &actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	wantEffectiveAt := time.Date(2025, time.February, 3, 4, 5, 6, 123_000_000, time.UTC)
	if base != "USD" || quote != "EUR" || rateNum != 5 || rateDen != 4 || !effectiveAt.Equal(wantEffectiveAt) || source != "manual" || actorType != "human" || actorID != fx.userID {
		t.Fatalf("stored FX rate base=%s quote=%s ratio=%d/%d effectiveAt=%s source=%s actor=%s/%s", base, quote, rateNum, rateDen, effectiveAt, source, actorType, actorID)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human' AND actor_id=$3::uuid`, fx.orgID, recordFxRateCapabilityID, fx.userID); got != 2 {
		t.Fatalf("recorded FX rate audit events=%d, want one approved and one direct execution", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":record-eur-rate-once"); got != 1 {
		t.Fatalf("recorded FX rate receipts=%d, want one", got)
	}
	replayed, err := fx.executor.Execute(fx.ctx, claims, recordFxRateCapabilityID, validInput)
	if err != nil || !replayed.OK || !replayed.Replayed {
		t.Fatalf("same-intent replay=%+v err=%v, want stored successful receipt", replayed, err)
	}
	var replayedOutput RecordFxRateOutput
	if err := json.Unmarshal(replayed.Data, &replayedOutput); err != nil || replayedOutput != output {
		t.Fatalf("same-intent replay data=%s, want output %+v (decode error %v)", replayed.Data, output, err)
	}
	if got := fx.count(`SELECT count(*) FROM fx_rates WHERE org_id=$1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("same-intent replay left %d FX rates, want two", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, recordFxRateCapabilityID); got != 2 {
		t.Fatalf("same-intent replay emitted %d execution audit events, want two", got)
	}

	defaultInput := json.RawMessage(`{"quoteCurrency":"gbp","rate":"0.75"}`)
	defaultClaims := recordFxRateClaims(fx, defaultInput, "human", "", "record-gbp-rate-once")
	startedAt := time.Now().UTC().Add(-time.Second)
	defaultResult, err := fx.executor.Execute(fx.ctx, defaultClaims, recordFxRateCapabilityID, defaultInput)
	finishedAt := time.Now().UTC().Add(time.Second)
	if err != nil || !defaultResult.OK {
		t.Fatalf("default-effectiveAt record result=%+v err=%v, want success", defaultResult, err)
	}
	var defaultRateID string
	var defaultQuote string
	var defaultNum, defaultDen int64
	var defaultEffectiveAt time.Time
	if err := json.Unmarshal(defaultResult.Data, &output); err != nil {
		t.Fatal(err)
	}
	defaultRateID = output.RateID
	if err := fx.owner.QueryRow(fx.ctx, `SELECT quote, rate_num, rate_den, effective_at FROM fx_rates WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, defaultRateID).
		Scan(&defaultQuote, &defaultNum, &defaultDen, &defaultEffectiveAt); err != nil {
		t.Fatal(err)
	}
	if defaultQuote != "GBP" || defaultNum != 3 || defaultDen != 4 || defaultEffectiveAt.Before(startedAt) || defaultEffectiveAt.After(finishedAt) {
		t.Fatalf("defaulted rate quote=%s ratio=%d/%d effectiveAt=%s, want GBP 3/4 and operation time", defaultQuote, defaultNum, defaultDen, defaultEffectiveAt)
	}

	invalidInput := json.RawMessage(`{"quoteCurrency":"JPY","rate":"0"}`)
	invalidClaims := recordFxRateClaims(fx, invalidInput, "human", "", "invalid-rate-no-effects")
	if _, err := fx.executor.Execute(fx.ctx, invalidClaims, recordFxRateCapabilityID, invalidInput); err == nil || !strings.Contains(err.Error(), "invalid rate; use a positive decimal like 1.0875") {
		t.Fatalf("zero FX rate error=%v, want legacy invalid-rate failure", err)
	}
	if got := fx.count(`SELECT count(*) FROM fx_rates WHERE org_id=$1::uuid`, fx.orgID); got != 3 {
		t.Fatalf("invalid rate left %d FX rate rows, want only the three valid rows", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 3 {
		t.Fatalf("invalid rate left %d receipts, want two successful direct intents plus the approved action receipt", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":invalid-rate-no-effects"); got != 0 {
		t.Fatalf("invalid rate wrote %d intent receipts, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, recordFxRateCapabilityID); got != 3 {
		t.Fatalf("invalid rate emitted %d execution audit events, want only the three successful executions", got)
	}

	for _, invalid := range []string{
		`{"quoteCurrency":"US","rate":"1.2"}`,
		`{"quoteCurrency":"EUR","rate":"1.2","effectiveAt":"2025-02-03T04:05:06+00:00"}`,
	} {
		if _, err := ParseRecordFxRateInput(json.RawMessage(invalid)); err == nil {
			t.Errorf("ParseRecordFxRateInput(%s) succeeded, want validation error", invalid)
		}
	}
}

func recordFxRateClaims(fx *executorFixture, input json.RawMessage, actorType, agentSession, intent string) authbridge.CapabilityClaims {
	claims := fx.claims(input, actorType, agentSession, intent)
	claims.CapabilityID = recordFxRateCapabilityID
	claims.Permissions = []string{"accounting.post"}
	return claims
}
