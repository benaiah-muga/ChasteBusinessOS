package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoIncomeStatementExecutorPreservesPermissionAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")
	seedReportsAccount(t, fx, "1000", "Cash", "asset")
	seedReportsAccount(t, fx, "4000", "Sales", "income")
	for _, account := range []struct{ code, name, kind string }{
		{"1000", "Other cash", "asset"}, {"4000", "Other sales", "income"},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`, fx.otherOrgID, account.code, account.name, account.kind); err != nil {
			t.Fatal(err)
		}
	}
	postedAt := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 12_500}, {accountCode: "4000", creditMinor: 12_500},
	})
	seedReportsJournalEntry(t, fx, fx.otherOrgID, "USD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 90_000}, {accountCode: "4000", creditMinor: 90_000},
	})

	input := json.RawMessage(`{}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, incomeStatementCapabilityID, "crm.read", input, "human", "", "income-statement-denied"),
		incomeStatementCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("incomeStatement wrong-permission result=%+v err=%v", denied, err)
	}

	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, incomeStatementCapabilityID, "accounting.read", input, "human", "", "income-statement-scope"),
		incomeStatementCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("incomeStatement result=%+v err=%v", result, err)
	}
	var output IncomeStatementOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode incomeStatement output %s: %v", result.Data, err)
	}
	if output.RevenueMinor != 12_500 || output.ExpenseMinor != 0 || output.NetIncomeMinor != 12_500 || len(output.Lines) != 1 || output.Lines[0].Code != "4000" {
		t.Fatalf("incomeStatement output=%+v, want only the scoped 12500 sales entry", output)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, incomeStatementCapabilityID); got != 1 {
		t.Fatalf("incomeStatement human audit events=%d, want one", got)
	}
}
