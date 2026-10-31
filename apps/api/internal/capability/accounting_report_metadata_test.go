package capability

import (
	"encoding/json"
	"testing"
	"time"
)

func TestValidReportCurrencyCode(t *testing.T) {
	for _, test := range []struct {
		value string
		valid bool
	}{
		{value: "USD", valid: true},
		{value: "UGX", valid: true},
		{value: "usd"},
		{value: "US"},
		{value: "US1"},
		{value: " U S"},
	} {
		if got := validReportCurrencyCode(test.value); got != test.valid {
			t.Errorf("validReportCurrencyCode(%q) = %v, want %v", test.value, got, test.valid)
		}
	}
}

func TestReportCurrencyMetadataCapabilityIsOrganizationScoped(t *testing.T) {
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
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET base_currency = 'UGX' WHERE id = $1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	postedAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	for _, currency := range []string{"UGX", "USD", "EUR", "EUR"} {
		seedReportsJournalEntry(t, fx, fx.orgID, currency, "operational", postedAt, nil, nil, []reportsSeedLine{
			{accountCode: "1000", debitMinor: 100}, {accountCode: "4000", creditMinor: 100},
		})
	}
	seedReportsJournalEntry(t, fx, fx.otherOrgID, "CAD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 100}, {accountCode: "4000", creditMinor: 100},
	})

	input := json.RawMessage(`{}`)
	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, reportCurrencyMetadataCapabilityID, "accounting.read", input, "human", "", "report-currency-metadata"),
		reportCurrencyMetadataCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("reportCurrencyMetadata result=%+v err=%v", result, err)
	}
	var output ReportCurrencyMetadataOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.BaseCurrency != "UGX" || len(output.UnsupportedCurrencies) != 2 ||
		output.UnsupportedCurrencies[0] != "EUR" || output.UnsupportedCurrencies[1] != "USD" {
		t.Fatalf("reportCurrencyMetadata output=%+v, want UGX with sorted unique EUR and USD, excluding other-organization CAD", output)
	}
	if got := string(result.Data); got != `{"baseCurrency":"UGX","unsupportedCurrencies":["EUR","USD"]}` {
		t.Fatalf("reportCurrencyMetadata JSON=%s, want stable exact response", got)
	}

	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, reportCurrencyMetadataCapabilityID, "crm.read", input, "human", "", "report-currency-metadata-denied"),
		reportCurrencyMetadataCapabilityID,
		input,
	)
	if err != nil || denied.OK {
		t.Fatalf("reportCurrencyMetadata wrong permission result=%+v err=%v, want denied", denied, err)
	}
}
