package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseRecordPaymentInputRejectsInvalidContractValues(t *testing.T) {
	full := `{"invoiceNumber":7,"amountMinor":1000,"method":"cash","settleFxRate":"1.0875","unknown":true}`
	input, err := ParseRecordPaymentInput(json.RawMessage(full))
	if err != nil {
		t.Fatalf("ParseRecordPaymentInput(%s) error = %v", full, err)
	}
	if input.InvoiceNumber != 7 || input.AmountMinor != 1000 || input.Method != "cash" || input.SettleFXRate == nil || *input.SettleFXRate != "1.0875" {
		t.Fatalf("ParseRecordPaymentInput(full) = %+v", input)
	}
	defaulted, err := ParseRecordPaymentInput(json.RawMessage(`{"invoiceNumber":7,"amountMinor":1000}`))
	if err != nil || defaulted.Method != "bank_transfer" || defaulted.SettleFXRate != nil {
		t.Fatalf("ParseRecordPaymentInput(defaults) = %+v, %v", defaulted, err)
	}
	emptyRate, err := ParseRecordPaymentInput(json.RawMessage(`{"invoiceNumber":7,"amountMinor":1000,"settleFxRate":""}`))
	if err != nil || emptyRate.SettleFXRate == nil || *emptyRate.SettleFXRate != "" {
		t.Fatalf("ParseRecordPaymentInput(empty settleFxRate) = %+v, %v, want empty string preserved for latest-rate defaulting", emptyRate, err)
	}
	for _, bad := range []string{
		`[]`,
		`{"invoiceNumber":7,"amountMinor":1000,"method":"cheque"}`,
		`{"invoiceNumber":0,"amountMinor":1000}`,
		`{"invoiceNumber":7,"amountMinor":0}`,
		`{"invoiceNumber":7,"amountMinor":1000,"settleFxRate":"abc"}`,
		`{"invoiceNumber":7,"amountMinor":1000,"settleFxRate":"0"}`,
		`{"invoiceNumber":7,"amountMinor":1000,"settleFxRate":"0.000"}`,
		`{"invoiceNumber":7,"amountMinor":1000,"settleFxRate":"-1.5"}`,
		`{"invoiceNumber":7,"amountMinor":1000,"settleFxRate":null}`,
	} {
		if _, err := ParseRecordPaymentInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseRecordPaymentInput accepted %s", bad)
		}
	}
}

func TestParseReversePaymentInputEnforcesReasonBounds(t *testing.T) {
	paymentID := "55555555-5555-4555-8555-555555555555"
	input, err := ParseReversePaymentInput(json.RawMessage(`{"paymentId":"` + paymentID + `","reason":"Refunded","unknown":1}`))
	if err != nil || input.PaymentID != paymentID || input.Reason != "Refunded" {
		t.Fatalf("ParseReversePaymentInput(full) = %+v, %v", input, err)
	}
	for _, bad := range []string{
		`[]`,
		`{"paymentId":"not-a-uuid","reason":"Refunded"}`,
		`{"paymentId":"` + paymentID + `"}`,
		`{"paymentId":"` + paymentID + `","reason":null}`,
		`{"paymentId":"` + paymentID + `","reason":""}`,
		`{"paymentId":"` + paymentID + `","reason":"ab"}`,
		`{"paymentId":"` + paymentID + `","reason":"` + strings.Repeat("r", 501) + `"}`,
	} {
		if _, err := ParseReversePaymentInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseReversePaymentInput accepted %s", bad)
		}
	}
}
