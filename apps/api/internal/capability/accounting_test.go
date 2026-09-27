package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseCreateInvoiceInputAcceptsLegacyDemoShapeAndStripsUnknownFields(t *testing.T) {
	input, err := ParseCreateInvoiceInput(json.RawMessage(`{"customerId":"01234567-89ab-4cde-8fab-0123456789ab","memo":"Demo","lines":[{"description":"Pendant lamp","quantity":2e4,"unitPriceMinor":12000.0,"taxMinor":6000,"ignored":"legacy strips me"}],"currency":"USD","dueAt":"2026-09-27T10:30:00.125Z","ignored":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.CustomerID != "01234567-89ab-4cde-8fab-0123456789ab" || input.Memo == nil || *input.Memo != "Demo" || len(input.Lines) != 1 {
		t.Fatalf("parsed invoice = %+v, want demo invoice fields", input)
	}
	line := input.Lines[0]
	if line.Quantity != 20_000 || line.UnitPriceMinor != 12_000 || line.TaxMinor == nil || *line.TaxMinor != 6_000 {
		t.Fatalf("parsed line = %+v, want quantity 20000, price 12000, tax 6000", line)
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "ignored") {
		t.Fatalf("unknown input members were retained: %s", encoded)
	}
}

func TestParseCreateInvoiceInputRejectsInvalidContractValues(t *testing.T) {
	validCustomer := "01234567-89ab-4cde-8fab-0123456789ab"
	validTaxCode := "11111111-2222-4333-8444-555555555555"
	cases := []struct {
		name string
		json string
	}{
		{name: "non-object", json: `[]`},
		{name: "missing customer", json: `{"lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`},
		{name: "invalid customer uuid", json: `{"customerId":"bad","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`},
		{name: "missing lines", json: `{"customerId":"` + validCustomer + `"}`},
		{name: "empty lines", json: `{"customerId":"` + validCustomer + `","lines":[]}`},
		{name: "null line", json: `{"customerId":"` + validCustomer + `","lines":[null]}`},
		{name: "empty description", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"","quantity":1,"unitPriceMinor":1}]}`},
		{name: "zero quantity", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":0,"unitPriceMinor":1}]}`},
		{name: "fractional quantity", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":1.5,"unitPriceMinor":1}]}`},
		{name: "unsafe quantity", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":9007199254740992,"unitPriceMinor":1}]}`},
		{name: "negative unit price", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":-1}]}`},
		{name: "negative manual tax", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":1,"taxMinor":-1}]}`},
		{name: "tax code and manual tax", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":1,"taxMinor":0,"taxCodeId":"` + validTaxCode + `"}]}`},
		{name: "offset due date", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}],"dueAt":"2026-09-27T10:30:00+03:00"}`},
		{name: "trailing json", json: `{"customerId":"` + validCustomer + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]} {}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ParseCreateInvoiceInput(json.RawMessage(test.json)); err == nil {
				t.Fatalf("ParseCreateInvoiceInput(%s) succeeded, want validation error", test.json)
			}
		})
	}
}

func TestParseTrialBalanceInputRequiresObject(t *testing.T) {
	if _, err := ParseTrialBalanceInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseTrialBalanceInput({}) error = %v", err)
	}
	for _, raw := range []string{`null`, `[]`, `"x"`, `{} {}`} {
		if _, err := ParseTrialBalanceInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseTrialBalanceInput(%s) succeeded, want error", raw)
		}
	}
}

func TestCalculateInvoiceLineMatchesLegacyIntegerRounding(t *testing.T) {
	cases := []struct {
		name                        string
		quantity, price             int64
		rate                        *int64
		includes                    bool
		manualTax                   *int64
		wantNet, wantTax, wantGross int64
	}{
		{name: "demo manual tax", quantity: 20_000, price: 12_000, manualTax: accountingInt64Pointer(6_000), wantNet: 240_000, wantTax: 6_000, wantGross: 246_000},
		{name: "half minor unit rounds up", quantity: 1, price: 500, wantNet: 1, wantGross: 1},
		{name: "below half rounds down", quantity: 1, price: 499, wantGross: 0},
		{name: "exclusive tax rounds half up", quantity: 1_000, price: 101, rate: accountingInt64Pointer(500), wantNet: 101, wantTax: 5, wantGross: 106},
		{name: "inclusive tax snapshot", quantity: 1_000, price: 118, rate: accountingInt64Pointer(1_800), includes: true, wantNet: 100, wantTax: 18, wantGross: 118},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			net, tax, gross, err := calculateInvoiceLine(test.quantity, test.price, test.rate, test.includes, test.manualTax)
			if err != nil {
				t.Fatal(err)
			}
			if net != test.wantNet || tax != test.wantTax || gross != test.wantGross {
				t.Fatalf("calculateInvoiceLine() = (%d,%d,%d), want (%d,%d,%d)", net, tax, gross, test.wantNet, test.wantTax, test.wantGross)
			}
		})
	}
}

func accountingInt64Pointer(value int64) *int64 { return &value }

func TestCalculateInvoiceLineRejectsSafeIntegerOverflow(t *testing.T) {
	if _, _, _, err := calculateInvoiceLine(maxSafeInteger, maxSafeInteger, nil, false, nil); err == nil {
		t.Fatal("line multiplication overflow succeeded")
	}
	manualTax := maxSafeInteger
	if _, _, _, err := calculateInvoiceLine(1_000, maxSafeInteger, nil, false, &manualTax); err == nil {
		t.Fatal("line gross overflow succeeded")
	}
}

func TestToBaseMinorExactRespectsCurrencyExponents(t *testing.T) {
	cases := []struct {
		name          string
		foreignMinor  int64
		rate          fxRateSnapshot
		quoteCurrency string
		baseCurrency  string
		want          int64
	}{
		{name: "zero decimal quote", foreignMinor: 150, rate: fxRateSnapshot{Num: 1, Den: 150}, quoteCurrency: "JPY", baseCurrency: "USD", want: 100},
		{name: "three decimal base", foreignMinor: 100, rate: fxRateSnapshot{Num: 1, Den: 1}, quoteCurrency: "EUR", baseCurrency: "KWD", want: 1_000},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := toBaseMinorExact(test.foreignMinor, test.rate, test.quoteCurrency, test.baseCurrency)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("toBaseMinorExact() = %d, want %d", got, test.want)
			}
		})
	}
}
