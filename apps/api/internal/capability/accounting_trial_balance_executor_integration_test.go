package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoTrialBalanceExecutorPreservesCurrencyGroupsAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")
	for _, account := range []struct {
		code, name, kind string
	}{
		{"1000", "Cash", "asset"},
		{"1100", "Accounts receivable", "asset"},
		{"4000", "Sales", "income"},
	} {
		seedReportsAccount(t, fx, account.code, account.name, account.kind)
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`,
			fx.otherOrgID, account.code, "Other "+account.name, account.kind); err != nil {
			t.Fatal(err)
		}
	}

	postedAt := time.Date(2026, 9, 27, 10, 30, 0, 0, time.UTC)
	seedReportsJournalEntry(t, fx, fx.orgID, "EUR", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 50_000},
		{accountCode: "4000", creditMinor: 50_000},
	})
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1100", debitMinor: 30_000},
		{accountCode: "4000", creditMinor: 30_000},
	})
	seedReportsJournalEntry(t, fx, fx.otherOrgID, "CAD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 90_000},
		{accountCode: "4000", creditMinor: 90_000},
	})

	input := json.RawMessage(`{}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, trialBalanceCapabilityID, "crm.read", input, "human", "", "trial-balance-denied"),
		trialBalanceCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("trialBalance wrong-permission result=%+v err=%v, want accounting.read denial", denied, err)
	}

	claims := waveModuleClaims(fx, trialBalanceCapabilityID, "accounting.read", input, "human", "", "trial-balance-multicurrency")
	result, err := fx.executor.Execute(fx.ctx, claims, trialBalanceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("trialBalance result=%+v err=%v", result, err)
	}
	var output TrialBalanceOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode trialBalance output %s: %v", result.Data, err)
	}
	want := TrialBalanceOutput{
		Lines: []TrialBalanceLine{
			{Code: "1000", Name: "Cash", Currency: "EUR", DebitMinor: 50_000, CreditMinor: 0},
			{Code: "1100", Name: "Accounts receivable", Currency: "USD", DebitMinor: 30_000, CreditMinor: 0},
			{Code: "4000", Name: "Sales", Currency: "EUR", DebitMinor: 0, CreditMinor: 50_000},
			{Code: "4000", Name: "Sales", Currency: "USD", DebitMinor: 0, CreditMinor: 30_000},
		},
		Balanced: true,
	}
	if encoded, err := marshalJS(output); err != nil {
		t.Fatal(err)
	} else if expected, err := marshalJS(want); err != nil {
		t.Fatal(err)
	} else if string(encoded) != string(expected) {
		t.Fatalf("trialBalance JSON=%s, want %s", encoded, expected)
	}
	if strings.Contains(string(result.Data), fx.otherOrgID) || strings.Contains(string(result.Data), "CAD") {
		t.Fatalf("trialBalance leaked another organization's entry: %s", result.Data)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, trialBalanceCapabilityID); got != 1 {
		t.Fatalf("trialBalance audit events=%d, want one", got)
	}
}
