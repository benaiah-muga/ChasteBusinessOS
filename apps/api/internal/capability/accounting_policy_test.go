package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestAccountingPolicyParsersMirrorZodContracts(t *testing.T) {
	if _, err := ParseBuildRemindersInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseBuildRemindersInput({}) err = %v, want accepted", err)
	}
	if _, err := ParseBuildRemindersInput(json.RawMessage(`{"unknown":true}`)); err != nil {
		t.Fatalf("ParseBuildRemindersInput(unknown key) err = %v, want zod strip", err)
	}
	for _, raw := range []string{`[]`, `null`, `5`, `"x"`} {
		if _, err := ParseBuildRemindersInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseBuildRemindersInput accepted %s", raw)
		}
	}

	if _, err := parseAccountingPolicyInput("accounting.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported accounting policy capability" {
		t.Fatalf("parseAccountingPolicyInput(unknown) err = %v, want dispatcher refusal", err)
	}
	parsed, err := parseAccountingPolicyInput(setExpensePolicyCapabilityID, json.RawMessage(`{"category":"meals","limitMinor":0}`))
	if err != nil {
		t.Fatalf("parseAccountingPolicyInput(setExpensePolicy) err = %v", err)
	}
	if input, ok := parsed.(SetExpensePolicyInput); !ok || input.Category != "meals" || input.LimitMinor != 0 {
		t.Fatalf("delegated setExpensePolicy parse = %+v (%T), want SetExpensePolicyInput", parsed, parsed)
	}
	for _, raw := range []string{
		`{"category":"x","limitMinor":5}`,
		`{"category":"` + strings.Repeat("x", 41) + `"}`,
		`{"category":"meals","limitMinor":-1}`,
		`{"category":"meals","limitMinor":1.5}`,
		`{}`,
	} {
		if _, err := parseAccountingPolicyInput(setExpensePolicyCapabilityID, json.RawMessage(raw)); err == nil {
			t.Errorf("parseAccountingPolicyInput(setExpensePolicy) accepted %s", raw)
		}
	}
	if _, err := parseAccountingPolicyInput(listExpensePoliciesCapabilityID, json.RawMessage(`{"anything":true}`)); err != nil {
		t.Fatalf("parseAccountingPolicyInput(listExpensePolicies) err = %v", err)
	}
	if _, err := parseAccountingPolicyInput(buildRemindersCapabilityID, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("parseAccountingPolicyInput(buildReminders) err = %v", err)
	}
}

func TestAccountingPolicyReminderDomainMathMirrorsErpCore(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	for _, testCase := range []struct {
		totalMinor, minorUnits int64
		want                   string
	}{
		{12_345_678, 2, "123,456.78"},
		{500_000, 0, "500,000"},
		{5_000, 2, "50.00"},
		{1_000_000, 3, "1,000.000"},
		{123_456_789, 2, "1,234,567.89"},
		{5, 2, "0.05"},
		{0, 2, "0.00"},
	} {
		if got := formatReminderAmount(testCase.totalMinor, testCase.minorUnits); got != testCase.want {
			t.Fatalf("formatReminderAmount(%d, %d) = %q, want %q", testCase.totalMinor, testCase.minorUnits, got, testCase.want)
		}
	}

	if days := reminderDaysOverdue(now, now.Add(-10*24*time.Hour)); days != 10 {
		t.Fatalf("reminderDaysOverdue(10d) = %d, want 10", days)
	}
	if days := reminderDaysOverdue(now, now.Add(-30*time.Hour)); days != 1 {
		t.Fatalf("reminderDaysOverdue(30h) = %d, want 1", days)
	}
	if days := reminderDaysOverdue(now, now.Add(-time.Hour)); days != 0 {
		t.Fatalf("reminderDaysOverdue(1h) = %d, want 0", days)
	}

	due := func(days int) *time.Time {
		value := now.Add(time.Duration(-days) * 24 * time.Hour)
		return &value
	}
	row := func(id, name, currency string, total, paid, credited int64, dueAt, issuedAt *time.Time) reminderInvoiceRow {
		return reminderInvoiceRow{customerID: id, customerName: name, currency: currency,
			totalMinor: total, paidMinor: paid, creditedMinor: credited, dueAt: dueAt, issuedAt: issuedAt}
	}
	rows := []reminderInvoiceRow{
		row("c1", "Alpha", "USD", 20_000, 0, 0, due(9), nil),
		row("c1", "Alpha", "USD", 30_000, 5_000, 2_000, due(3), nil),
		row("c1", "Alpha", "EUR", 4_000, 0, 0, due(2), due(9)),
		row("c2", "Beta", "USD", 10_000, 0, 0, due(9), nil),
		row("c1", "Alpha", "USD", 9_999, 9_999, 0, due(30), nil),
		row("c1", "Alpha", "USD", 8_000, 0, 0, due(-5), nil),
		row("c1", "Alpha", "USD", 7_000, 0, 0, nil, nil),
	}
	reminders := buildOverdueReminders(rows, now)
	if len(reminders) != 3 {
		t.Fatalf("buildOverdueReminders = %+v, want three groups after skipping paid, future, and undated rows", reminders)
	}
	if reminders[0].CustomerName != "Alpha" || reminders[0].Currency != "USD" || reminders[0].OverdueCount != 2 ||
		reminders[0].TotalOverdueMinor != 43_000 || reminders[0].OldestDaysOverdue != 9 {
		t.Fatalf("first group = %+v, want Alpha USD with two balances oldest 9 days", reminders[0])
	}
	wantMessage := "Hi Alpha - a friendly nudge that 2 invoices totalling USD 430.00 are now 9 days past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."
	if reminders[0].Message != wantMessage {
		t.Fatalf("first message = %q, want %q", reminders[0].Message, wantMessage)
	}
	if reminders[1].CustomerName != "Beta" || reminders[2].CustomerName != "Alpha" || reminders[2].Currency != "EUR" {
		t.Fatalf("order = %s/%s, %s/%s, want oldest desc then name then currency",
			reminders[1].CustomerName, reminders[1].Currency, reminders[2].CustomerName, reminders[2].Currency)
	}
	if reminders[2].OldestDaysOverdue != 2 {
		t.Fatalf("dueAt must win over issuedAt, got oldest %d, want 2", reminders[2].OldestDaysOverdue)
	}
	single := buildOverdueReminders([]reminderInvoiceRow{row("c3", "Solo", "JPY", 500_000, 0, 0, due(1), nil)}, now)
	wantSingle := "Hi Solo - a friendly nudge that 1 invoice totalling JPY 500,000 is now 1 day past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."
	if len(single) != 1 || single[0].Message != wantSingle {
		t.Fatalf("single reminder = %+v, want JPY zero-decimal message %q", single, wantSingle)
	}
}

func cleanupAccountingPolicyFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin accounting policy fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		steps := []string{
			`DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, step := range steps {
			if _, err := tx.Exec(fx.ctx, step, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("accounting policy fixture cleanup step failed: %v", err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit accounting policy fixture cleanup: %v", err)
		}
	})
}

func seedAccountingPolicyCustomer(t *testing.T, fx *executorFixture, orgID, name string, reminderOptOut bool) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, reminder_opt_out)
		VALUES ($1::uuid, $2, $3)
		RETURNING id::text`, orgID, name, reminderOptOut).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func seedAccountingPolicyInvoice(t *testing.T, fx *executorFixture, orgID, customerID string, number int64, currency, status string, totalMinor, paidMinor, creditedMinor int64, dueAt, issuedAt, voidedAt *time.Time) string {
	t.Helper()
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, due_at, issued_at, voided_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 0, $6, $7, $8, $9, $10, $11)
		RETURNING id::text`, orgID, customerID, number, status, currency, totalMinor, paidMinor, creditedMinor, dueAt, issuedAt, voidedAt).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	return invoiceID
}

func policyTimePtr(daysBefore int, now time.Time) *time.Time {
	value := now.Add(time.Duration(-daysBefore) * 24 * time.Hour)
	return &value
}

func TestAccountingPolicyBuildRemindersGroupsOverdueInvoices(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingPolicyFixture(t, fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BuildRemindersOutput, error) {
		return buildReminders(fx.ctx, tx, fx.orgID, BuildRemindersInput{}, now)
	})
	if err != nil {
		t.Fatalf("buildReminders(empty): %v", err)
	}
	if encoded, err := marshalJS(empty); err != nil || string(encoded) != `{"reminders":[]}` {
		t.Fatalf("empty reminders JSON = %s, %v", encoded, err)
	}

	alphaID := seedAccountingPolicyCustomer(t, fx, fx.orgID, "Alpha Systems", false)
	betaID := seedAccountingPolicyCustomer(t, fx, fx.orgID, "Beta Corp", false)
	gammaID := seedAccountingPolicyCustomer(t, fx, fx.orgID, "Gamma Quiet", true)
	foreignCustomerID := seedAccountingPolicyCustomer(t, fx, fx.otherOrgID, "Delta Foreign", false)

	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 1, "USD", "sent", 50_000, 20_000, 5_000, policyTimePtr(10, now), policyTimePtr(12, now), nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 2, "USD", "sent", 12_345, 0, 0, policyTimePtr(3, now), policyTimePtr(5, now), nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 3, "USD", "sent", 7_000, 0, 0, nil, policyTimePtr(20, now), nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 4, "EUR", "sent", 5_000, 0, 0, policyTimePtr(1, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 5, "USD", "sent", 9_999, 9_999, 0, policyTimePtr(30, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 6, "USD", "sent", 8_000, 0, 0, policyTimePtr(-5, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 7, "USD", "draft", 6_000, 0, 0, policyTimePtr(30, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 8, "USD", "sent", 4_000, 0, 0, policyTimePtr(15, now), nil, policyTimePtr(1, now))
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 9, "USD", "sent", 3_000, 0, 0, nil, nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 10, "JPY", "sent", 500_000, 0, 0, policyTimePtr(5, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, betaID, 11, "USD", "sent", 20_000, 0, 0, policyTimePtr(20, now), policyTimePtr(22, now), nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, alphaID, 12, "USD", "paid", 99_000, 0, 0, policyTimePtr(40, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.orgID, gammaID, 13, "USD", "sent", 66_000, 0, 0, policyTimePtr(40, now), nil, nil)
	seedAccountingPolicyInvoice(t, fx, fx.otherOrgID, foreignCustomerID, 1, "USD", "sent", 77_000, 0, 0, policyTimePtr(9, now), nil, nil)

	built, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BuildRemindersOutput, error) {
		return buildReminders(fx.ctx, tx, fx.orgID, BuildRemindersInput{}, now)
	})
	if err != nil {
		t.Fatalf("buildReminders: %v", err)
	}
	if len(built.Reminders) != 4 {
		t.Fatalf("buildReminders = %+v, want four groups after skipping paid, draft, voided, future, undated, opted-out, and settled rows", built.Reminders)
	}
	alpha, beta, jpy, eur := built.Reminders[0], built.Reminders[1], built.Reminders[2], built.Reminders[3]
	if alpha.CustomerID != alphaID || alpha.CustomerName != "Alpha Systems" || alpha.Currency != "USD" ||
		alpha.OverdueCount != 3 || alpha.OldestDaysOverdue != 20 || alpha.TotalOverdueMinor != 44_345 {
		t.Fatalf("first reminder = %+v, want Alpha Systems USD 3 balances oldest 20 days", alpha)
	}
	wantAlphaMessage := "Hi Alpha Systems - a friendly nudge that 3 invoices totalling USD 443.45 are now 20 days past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."
	if alpha.Message != wantAlphaMessage {
		t.Fatalf("alpha message = %q, want %q", alpha.Message, wantAlphaMessage)
	}
	if beta.CustomerID != betaID || beta.Currency != "USD" || beta.OverdueCount != 1 || beta.TotalOverdueMinor != 20_000 || beta.OldestDaysOverdue != 20 {
		t.Fatalf("second reminder = %+v, want Beta Corp USD tied on 20 days", beta)
	}
	if jpy.CustomerID != alphaID || jpy.Currency != "JPY" || jpy.OldestDaysOverdue != 5 || jpy.TotalOverdueMinor != 500_000 {
		t.Fatalf("third reminder = %+v, want Alpha Systems JPY at 5 days", jpy)
	}
	if eur.Currency != "EUR" || eur.OldestDaysOverdue != 1 || eur.TotalOverdueMinor != 5_000 {
		t.Fatalf("fourth reminder = %+v, want Alpha Systems EUR at 1 day", eur)
	}
	if strings.Contains(alpha.Message, "\u2014") || !strings.Contains(alpha.Message, " - ") {
		t.Fatalf("alpha message separator = %q, want a plain hyphen and no em dash", alpha.Message)
	}
	encoded, err := marshalJS(built)
	if err != nil {
		t.Fatal(err)
	}
	wantEncoded := fmt.Sprintf(`{"reminders":[{"customerId":"%s","customerName":"Alpha Systems","currency":"USD","overdueCount":3,"oldestDaysOverdue":20,"totalOverdueMinor":44345,"message":"Hi Alpha Systems - a friendly nudge that 3 invoices totalling USD 443.45 are now 20 days past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."},`+
		`{"customerId":"%s","customerName":"Beta Corp","currency":"USD","overdueCount":1,"oldestDaysOverdue":20,"totalOverdueMinor":20000,"message":"Hi Beta Corp - a friendly nudge that 1 invoice totalling USD 200.00 is now 20 days past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."},`+
		`{"customerId":"%s","customerName":"Alpha Systems","currency":"JPY","overdueCount":1,"oldestDaysOverdue":5,"totalOverdueMinor":500000,"message":"Hi Alpha Systems - a friendly nudge that 1 invoice totalling JPY 500,000 is now 5 days past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."},`+
		`{"customerId":"%s","customerName":"Alpha Systems","currency":"EUR","overdueCount":1,"oldestDaysOverdue":1,"totalOverdueMinor":5000,"message":"Hi Alpha Systems - a friendly nudge that 1 invoice totalling EUR 50.00 is now 1 day past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience."}]}`,
		alphaID, betaID, alphaID, alphaID)
	if string(encoded) != wantEncoded {
		t.Fatalf("reminders JSON = %s, want %s", encoded, wantEncoded)
	}

	foreign, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (BuildRemindersOutput, error) {
		return buildReminders(fx.ctx, tx, fx.otherOrgID, BuildRemindersInput{}, now)
	})
	if err != nil {
		t.Fatalf("buildReminders(foreign): %v", err)
	}
	if len(foreign.Reminders) != 1 || foreign.Reminders[0].CustomerName != "Delta Foreign" ||
		foreign.Reminders[0].TotalOverdueMinor != 77_000 || foreign.Reminders[0].OldestDaysOverdue != 9 {
		t.Fatalf("foreign reminders = %+v, want only the other organization's overdue balance", foreign.Reminders)
	}
}
