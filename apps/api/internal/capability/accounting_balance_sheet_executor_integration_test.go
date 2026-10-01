package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoBalanceSheetExecutorPreservesStatementParityAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")
	for _, account := range []struct {
		code, name, kind string
	}{
		{"1000", "Cash", "asset"},
		{"1100", "Accounts receivable", "asset"},
		{"2000", "Accounts payable", "liability"},
		{"3000", "Retained earnings", "equity"},
		{"4000", "Sales", "income"},
		{"6000", "Ops expense", "expense"},
	} {
		seedReportsAccount(t, fx, account.code, account.name, account.kind)
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`,
			fx.otherOrgID, account.code, "Other "+account.name, account.kind); err != nil {
			t.Fatal(err)
		}
	}

	postedAt := time.Date(2026, 9, 27, 10, 30, 0, 0, time.UTC)
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 25_000},
		{accountCode: "2000", creditMinor: 5_000},
		{accountCode: "3000", creditMinor: 10_000},
		{accountCode: "4000", creditMinor: 12_000},
		{accountCode: "6000", debitMinor: 2_000},
	})
	seedReportsJournalEntry(t, fx, fx.otherOrgID, "USD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 90_000},
		{accountCode: "4000", creditMinor: 90_000},
	})

	input := json.RawMessage(`{}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, balanceSheetCapabilityID, "crm.read", input, "human", "", "balance-sheet-denied"),
		balanceSheetCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("balanceSheet wrong-permission result=%+v err=%v, want accounting.read denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, balanceSheetCapabilityID); got != 0 {
		t.Fatalf("denied balanceSheet audit events=%d, want none", got)
	}

	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, balanceSheetCapabilityID, "accounting.read", input, "human", "", "balance-sheet-parity"),
		balanceSheetCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("balanceSheet result=%+v err=%v", result, err)
	}
	var output BalanceSheetOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode balanceSheet output %s: %v", result.Data, err)
	}
	want := BalanceSheetOutput{
		AssetsMinor:         25_000,
		LiabilitiesMinor:    5_000,
		EquityMinor:         10_000,
		RetainedResultMinor: 10_000,
		Balanced:            true,
	}
	if encoded, err := marshalJS(output); err != nil {
		t.Fatal(err)
	} else if expected, err := marshalJS(want); err != nil {
		t.Fatal(err)
	} else if string(encoded) != string(expected) {
		t.Fatalf("balanceSheet JSON=%s, want %s", encoded, expected)
	}
	if strings.Contains(string(result.Data), fx.otherOrgID) || strings.Contains(string(result.Data), "90000") {
		t.Fatalf("balanceSheet leaked another organization's entry: %s", result.Data)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, balanceSheetCapabilityID); got != 1 {
		t.Fatalf("balanceSheet human audit events=%d, want one", got)
	}
}
