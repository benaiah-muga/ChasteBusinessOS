package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoTerminalApprovalIntentRequiresNewActionIntent(t *testing.T) {
	for _, terminalState := range []string{"rejected", "expired"} {
		t.Run(terminalState, func(t *testing.T) {
			fx := newExecutorFixture(t)
			fx.addAgentSession()
			fx.addPolicy("crm.*", "read", nil)
			input := json.RawMessage(`{"name":"Terminal approval customer","preferredContactMethod":"email","doNotContact":false}`)
			claims := fx.claims(input, "agent", fx.agentSession, "terminal-approval-"+terminalState)

			pending, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
			if err != nil || pending.OK || !pending.PendingApproval || pending.ApprovalID == "" {
				t.Fatalf("initial execution=%+v err=%v, want pending approval", pending, err)
			}

			decider := NewApprovalDecider(fx.runtime, fx.executor)
			decisionInput := ApprovalDecisionInput{ApprovalID: pending.ApprovalID}
			if terminalState == "rejected" {
				decisionInput.Decision = "reject"
			} else {
				if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid AND org_id=$2::uuid`, pending.ApprovalID, fx.orgID); err != nil {
					t.Fatalf("expire pending approval fixture: %v", err)
				}
				decisionInput.Decision = "approve"
			}
			decision, err := decider.Decide(fx.ctx, fx.humanClaims(input, ""), decisionInput)
			if terminalState == "rejected" {
				if err != nil || !decision.OK || decision.Status != terminalState {
					t.Fatalf("terminal decision=%+v err=%v, want rejected transition", decision, err)
				}
			} else if err != nil || decision.OK || decision.HTTPStatus != 410 || decision.Error != "this approval has expired; request it again" {
				t.Fatalf("terminal decision=%+v err=%v, want expired transition with 410 response", decision, err)
			}

			var storedStatus string
			if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, pending.ApprovalID, fx.orgID).Scan(&storedStatus); err != nil {
				t.Fatalf("read terminal approval state: %v", err)
			}
			if storedStatus != terminalState {
				t.Fatalf("stored approval status=%q, want %q", storedStatus, terminalState)
			}

			retry, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
			if err != nil || retry.OK || retry.PendingApproval || !strings.Contains(retry.Error, "use a new action intent") {
				t.Fatalf("same-intent terminal retry=%+v err=%v, want explicit new-action-intent instruction", retry, err)
			}
			if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND intent_id=$2`, fx.orgID, claims.IntentID); got != 1 {
				t.Fatalf("terminal same-intent retry created %d approvals, want 1", got)
			}

			newClaims := fx.claims(input, "agent", fx.agentSession, claims.IntentID+"-new")
			newPending, err := fx.executor.Execute(fx.ctx, newClaims, createCustomerCapabilityID, input)
			if err != nil || newPending.OK || !newPending.PendingApproval || newPending.ApprovalID == "" || newPending.ApprovalID == pending.ApprovalID {
				t.Fatalf("new-intent execution=%+v err=%v, want a distinct pending approval", newPending, err)
			}
			if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id=$2`, fx.orgID, createCustomerCapabilityID); got != 2 {
				t.Fatalf("approvals after new-intent retry=%d, want 2", got)
			}
		})
	}
}
