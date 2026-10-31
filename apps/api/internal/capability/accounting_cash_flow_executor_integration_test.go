package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoCashFlowExecutorPreservesStatementParityAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")
	for _, account := range []struct {
		code, name, kind string
	}{
		{"1000", "Cash", "asset"},
		{"1100", "Accounts receivable", "asset"},
		{"1500", "Equipment", "asset"},
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

	entry := func(orgID, currency string, day int, lines []reportsSeedLine) {
		t.Helper()
		seedReportsJournalEntry(t, fx, orgID, currency, "operational", time.Date(2026, 1, day, 0, 0, 0, 0, time.UTC), nil, nil, lines)
	}
	entry(fx.orgID, "USD", 5, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 20_000}, {accountCode: "3000", creditMinor: 20_000},
	})
	entry(fx.orgID, "USD", 20, []reportsSeedLine{
		{accountCode: "1500", debitMinor: 5_000}, {accountCode: "1000", creditMinor: 5_000},
	})
	entry(fx.orgID, "USD", 21, []reportsSeedLine{
		{accountCode: "1100", debitMinor: 8_000}, {accountCode: "4000", creditMinor: 8_000},
	})
	entry(fx.orgID, "USD", 22, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 6_000}, {accountCode: "1100", creditMinor: 6_000},
	})
	entry(fx.orgID, "USD", 23, []reportsSeedLine{
		{accountCode: "6000", debitMinor: 2_500}, {accountCode: "1000", creditMinor: 2_500},
	})
	entry(fx.orgID, "EUR", 24, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 1_000}, {accountCode: "4000", creditMinor: 1_000},
	})
	entry(fx.orgID, "CAD", 25, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 700}, {accountCode: "4000", creditMinor: 700},
	})
	entry(fx.otherOrgID, "USD", 26, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 90_000}, {accountCode: "4000", creditMinor: 90_000},
	})

	input := json.RawMessage(`{"cashAccountCodes":["1000"]}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, cashFlowCapabilityID, "crm.read", input, "human", "", "cash-flow-denied"),
		cashFlowCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("cashFlow wrong-permission result=%+v err=%v, want accounting.read denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, cashFlowCapabilityID); got != 0 {
		t.Fatalf("denied cashFlow audit events=%d, want none", got)
	}

	claims := waveModuleClaims(fx, cashFlowCapabilityID, "accounting.read", input, "human", "", "cash-flow-parity")
	result, err := fx.executor.Execute(fx.ctx, claims, cashFlowCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("cashFlow result=%+v err=%v", result, err)
	}
	var output CashFlowOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode cashFlow output %s: %v", result.Data, err)
	}
	want := CashFlowOutput{
		OpeningMinor:          0,
		ClosingMinor:          18_500,
		NetMinor:              18_500,
		CashBalanceMinor:      18_500,
		Ties:                  true,
		UnsupportedCurrencies: []string{"CAD", "EUR"},
		Operating:             CashFlowCategoryTotal{InflowMinor: 6_000, OutflowMinor: 2_500, NetMinor: 3_500, Entries: 2},
		Investing:             CashFlowCategoryTotal{OutflowMinor: 5_000, NetMinor: -5_000, Entries: 1},
		Financing:             CashFlowCategoryTotal{InflowMinor: 20_000, NetMinor: 20_000, Entries: 1},
	}
	encoded, err := marshalJS(output)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := marshalJS(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != string(expected) {
		t.Fatalf("cashFlow JSON=%s, want parity result %s", encoded, expected)
	}
	if strings.Contains(string(result.Data), fx.otherOrgID) || strings.Contains(string(result.Data), "90000") {
		t.Fatalf("cashFlow included another organization's journal entry: %s", result.Data)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, cashFlowCapabilityID); got != 1 {
		t.Fatalf("cashFlow audit events=%d, want one", got)
	}
}
