package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoCustomerStatementExecutorPreservesResponseScopePermissionAndAudit(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")

	localCustomer := seedReportsCustomer(t, fx, fx.orgID, "Executor statement customer")
	otherCustomer := seedReportsCustomer(t, fx, fx.orgID, "Unrelated statement customer")
	foreignCustomer := seedReportsCustomer(t, fx, fx.otherOrgID, "Foreign statement customer")
	issuedAt := time.Date(2026, 8, 14, 10, 15, 0, 0, time.UTC)
	seedReportsInvoice(t, fx, fx.orgID, localCustomer, 81, "sent", "USD", 12_500, 0, 12_500, 0, 0, &issuedAt, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, otherCustomer, 82, "sent", "USD", 23_456, 0, 23_456, 0, 0, &issuedAt, nil, nil)
	seedReportsInvoice(t, fx, fx.otherOrgID, foreignCustomer, 83, "sent", "USD", 34_567, 0, 34_567, 0, 0, &issuedAt, nil, nil)

	input := json.RawMessage(`{"customerId":"` + localCustomer + `"}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, customerStatementCapabilityID, "crm.read", input, "human", "", "statement-wrong-permission"),
		customerStatementCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("customerStatement wrong-permission result=%+v err=%v, want accounting.read denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, customerStatementCapabilityID); got != 0 {
		t.Fatalf("denied statement audit events=%d, want none", got)
	}

	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, customerStatementCapabilityID, "accounting.read", input, "human", "", "statement-response-scope"),
		customerStatementCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("customerStatement result=%+v err=%v", result, err)
	}
	want := `{"currencies":[{"currency":"USD","openingBalanceMinor":0,"closingBalanceMinor":12500,"rows":[{"date":"2026-08-14T10:15:00.000Z","kind":"invoice","ref":"Invoice #81","amountMinor":12500,"balanceMinor":12500}]}]}`
	if got := string(result.Data); got != want {
		t.Fatalf("customerStatement JSON=%s, want %s", got, want)
	}
	if strings.Contains(string(result.Data), "23456") || strings.Contains(string(result.Data), "34567") || strings.Contains(string(result.Data), foreignCustomer) {
		t.Fatalf("customerStatement leaked another customer's or organization's data: %s", result.Data)
	}

	foreignInput := json.RawMessage(`{"customerId":"` + foreignCustomer + `"}`)
	foreignResult, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, customerStatementCapabilityID, "accounting.read", foreignInput, "human", "", "statement-foreign-customer-scope"),
		customerStatementCapabilityID,
		foreignInput,
	)
	if err != nil || !foreignResult.OK {
		t.Fatalf("foreign customer statement result=%+v err=%v", foreignResult, err)
	}
	if got := string(foreignResult.Data); got != `{"currencies":[]}` {
		t.Fatalf("local claims read foreign customer's statement: %s, want empty statement", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, customerStatementCapabilityID); got != 2 {
		t.Fatalf("statement audit events=%d, want one per governed human execution", got)
	}
}
