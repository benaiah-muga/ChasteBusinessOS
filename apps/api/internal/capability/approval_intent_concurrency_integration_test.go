package capability

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func TestGoConcurrentApprovalIntentCreatesOnePendingRequest(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy("crm.*", "read", nil)

	input := json.RawMessage(`{"name":"Concurrent approval intent customer","preferredContactMethod":"email","doNotContact":false}`)
	claims := fx.claims(input, "agent", fx.agentSession, "approval-intent-concurrency")
	ctx, cancel := context.WithTimeout(fx.ctx, 20*time.Second)
	defer cancel()

	type execution struct {
		result Result
		err    error
	}
	start := make(chan struct{})
	ready := make(chan struct{}, 2)
	results := make(chan execution, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ready <- struct{}{}
			select {
			case <-start:
			case <-ctx.Done():
				results <- execution{err: ctx.Err()}
				return
			}
			result, err := fx.executor.Execute(ctx, claims, createCustomerCapabilityID, input)
			results <- execution{result: result, err: err}
		}()
	}

	for range 2 {
		select {
		case <-ready:
		case <-ctx.Done():
			t.Fatalf("concurrent executions did not reach the start barrier: %v", ctx.Err())
		}
	}
	close(start)
	workers.Wait()
	close(results)

	var approvalID string
	for execution := range results {
		if execution.err != nil {
			t.Fatalf("concurrent execution returned an error: %v", execution.err)
		}
		if execution.result.OK || !execution.result.PendingApproval || execution.result.ApprovalID == "" {
			t.Fatalf("concurrent execution=%+v, want a pending approval", execution.result)
		}
		if approvalID == "" {
			approvalID = execution.result.ApprovalID
		} else if execution.result.ApprovalID != approvalID {
			t.Fatalf("concurrent executions returned approval IDs %q and %q, want the same pending approval", approvalID, execution.result.ApprovalID)
		}
	}

	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND intent_id=$2`, fx.orgID, claims.IntentID); got != 1 {
		t.Fatalf("same-intent concurrent executions created %d approval rows, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND intent_id=$2 AND id=$3::uuid AND status='pending'`, fx.orgID, claims.IntentID, approvalID); got != 1 {
		t.Fatalf("shared approval %q has %d pending rows, want one", approvalID, got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, createCustomerCapabilityID); got != 1 {
		t.Fatalf("same-intent concurrent executions wrote %d approval.requested ledger events, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND user_id IS NULL AND kind='approval.requested' AND href='/approvals'`, fx.orgID); got != 1 {
		t.Fatalf("same-intent concurrent executions wrote %d approval notifications, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id=$1::uuid AND name=$2`, fx.orgID, "Concurrent approval intent customer"); got != 0 {
		t.Fatalf("pending approval created %d customer side effects, want zero", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":"+claims.IntentID); got != 0 {
		t.Fatalf("pending approval created %d action receipts, want zero", got)
	}
}
