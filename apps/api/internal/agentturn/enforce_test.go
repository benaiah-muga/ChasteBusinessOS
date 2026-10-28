package agentturn

import (
	"strings"
	"testing"
)

func TestSanitize(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"parenthetical em dash", "The invoice is ready \u2014 send it.", "The invoice is ready, send it."},
		{"tight em dash", "Ready\u2014send it.", "Ready, send it."},
		{"em dash before space", "Ready\u2014 send it.", "Ready, send it."},
		{"em dash after space", "Ready \u2014send it.", "Ready, send it."},
		{"leading em dash", "\u2014 first", "first"},
		{"line leading em dash", "one\ntwo\n\u2014 three", "one\ntwo\nthree"},
		{"en dash range", "Range 10\u201320.", "Range 10-20."},
		{"no dash", "Nothing to change here.", "Nothing to change here."},
		{"hyphen untouched", "A well-known name", "A well-known name"},
		{"empty", "", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := Sanitize(testCase.in)
			if got != testCase.want {
				t.Fatalf("Sanitize(%q)=%q want %q", testCase.in, got, testCase.want)
			}
			if again := Sanitize(got); again != got {
				t.Fatalf("Sanitize is not idempotent: %q then %q", got, again)
			}
		})
	}

	samples := []string{
		"a \u2014 b \u2014 c",
		"1\u20132\u20133",
		"mix \u2013 of \u2014 both",
		"start \u2014",
		"\u2014\u2014\u2014",
	}
	for _, sample := range samples {
		if got := Sanitize(sample); strings.ContainsAny(got, "\u2014\u2013") {
			t.Fatalf("Sanitize(%q)=%q still holds a dash", sample, got)
		}
	}
}

func TestEnforce(t *testing.T) {
	invoiceGate := Effect{CapabilityID: "accounting.createInvoice", Risk: "money", PendingApproval: true, ApprovalID: "appr-1", Error: "pending human approval"}
	orderGate := Effect{CapabilityID: "purchasing.createPurchaseOrder", Risk: "write", PendingApproval: true, ApprovalID: "appr-2", Error: "pending human approval"}

	t.Run("surfaces an omitted pending approval", func(t *testing.T) {
		enforced := Enforce("The invoice is created and sent to Acme.", []Effect{invoiceGate})
		if !strings.Contains(enforced.Text, "Not done yet: accounting.createInvoice is waiting for your approval (approval id appr-1).") {
			t.Fatalf("text=%q", enforced.Text)
		}
		if !strings.Contains(enforced.Text, "Nothing has changed until you approve or reject it.") {
			t.Fatalf("text=%q", enforced.Text)
		}
		if strings.Contains(enforced.Text, "did not complete") {
			t.Fatalf("a gated action must not be reported as a failure as well: %q", enforced.Text)
		}
		if len(enforced.Violations) != 1 || enforced.Violations[0].Kind != ViolationPendingApproval {
			t.Fatalf("violations=%+v", enforced.Violations)
		}
	})

	t.Run("keeps an answer that already says it", func(t *testing.T) {
		enforced := Enforce("I prepared the invoice, but it is waiting for your approval before it runs.", []Effect{invoiceGate})
		if len(enforced.Violations) != 0 || strings.Contains(enforced.Text, "Not done yet") {
			t.Fatalf("text=%q violations=%+v", enforced.Text, enforced.Violations)
		}
	})

	t.Run("lists several gates once each", func(t *testing.T) {
		enforced := Enforce("Both are ready.", []Effect{invoiceGate, invoiceGate, orderGate})
		if strings.Count(enforced.Text, "accounting.createInvoice") != 1 || !strings.Contains(enforced.Text, "purchasing.createPurchaseOrder") {
			t.Fatalf("text=%q", enforced.Text)
		}
		if !strings.Contains(enforced.Text, "these are waiting for your approval") {
			t.Fatalf("text=%q", enforced.Text)
		}
	})

	t.Run("surfaces a failed material action", func(t *testing.T) {
		failure := Effect{CapabilityID: "accounting.recordPayment", Risk: "money", OK: false, Error: "missing permission: accounting.post"}
		enforced := Enforce("Payment recorded.", []Effect{failure})
		if !strings.Contains(enforced.Text, "The accounting.recordPayment step did not complete: missing permission: accounting.post.") {
			t.Fatalf("text=%q", enforced.Text)
		}
		if !strings.Contains(enforced.Text, "I have not confirmed any change from it.") {
			t.Fatalf("text=%q", enforced.Text)
		}
		if len(enforced.Violations) != 1 || enforced.Violations[0].Kind != ViolationFailedAction {
			t.Fatalf("violations=%+v", enforced.Violations)
		}
	})

	t.Run("keeps an honest failure", func(t *testing.T) {
		failure := Effect{CapabilityID: "accounting.recordPayment", Risk: "money", OK: false, Error: "missing permission: accounting.post"}
		enforced := Enforce("I could not record the payment because the accounting.post permission is missing.", []Effect{failure})
		if len(enforced.Violations) != 0 || strings.Contains(enforced.Text, "did not complete") {
			t.Fatalf("text=%q violations=%+v", enforced.Text, enforced.Violations)
		}
	})

	t.Run("leaves a failed read alone", func(t *testing.T) {
		enforced := Enforce("Here is what I found.", []Effect{{CapabilityID: "inventory.stockReport", Risk: "read", OK: false, Error: "unavailable"}})
		if len(enforced.Violations) != 0 || strings.Contains(enforced.Text, "did not complete") {
			t.Fatalf("text=%q violations=%+v", enforced.Text, enforced.Violations)
		}
	})

	t.Run("an empty answer still reports the gate", func(t *testing.T) {
		enforced := Enforce("", []Effect{invoiceGate})
		if !strings.HasPrefix(enforced.Text, "Not done yet:") {
			t.Fatalf("text=%q", enforced.Text)
		}
	})

	t.Run("is idempotent", func(t *testing.T) {
		first := Enforce("Done.", []Effect{invoiceGate})
		second := Enforce(first.Text, []Effect{invoiceGate})
		if second.Text != first.Text || len(second.Violations) != 0 {
			t.Fatalf("first=%q second=%q violations=%+v", first.Text, second.Text, second.Violations)
		}
	})

	t.Run("cleans a dash and the obligation together", func(t *testing.T) {
		enforced := Enforce("Invoice ready \u2014 created.", []Effect{invoiceGate})
		if strings.ContainsAny(enforced.Text, "\u2014\u2013") {
			t.Fatalf("text=%q", enforced.Text)
		}
		if len(enforced.Violations) != 2 {
			t.Fatalf("violations=%+v", enforced.Violations)
		}
	})
}
