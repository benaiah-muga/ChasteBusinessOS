package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const buildRemindersCapabilityID = "accounting.buildReminders"

type BuildRemindersInput struct{}

type PaymentReminderSummary struct {
	CustomerID        string `json:"customerId"`
	CustomerName      string `json:"customerName"`
	Currency          string `json:"currency"`
	OverdueCount      int    `json:"overdueCount"`
	OldestDaysOverdue int64  `json:"oldestDaysOverdue"`
	TotalOverdueMinor int64  `json:"totalOverdueMinor"`
	Message           string `json:"message"`
}

type BuildRemindersOutput struct {
	Reminders []PaymentReminderSummary `json:"reminders"`
}

func ParseBuildRemindersInput(raw json.RawMessage) (BuildRemindersInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return BuildRemindersInput{}, err
	}
	return BuildRemindersInput{}, nil
}

type reminderInvoiceRow struct {
	customerID    string
	customerName  string
	currency      string
	totalMinor    int64
	paidMinor     int64
	creditedMinor int64
	dueAt         *time.Time
	issuedAt      *time.Time
}

type reminderGroup struct {
	customerID   string
	customerName string
	currency     string
	count        int
	totalMinor   int64
	oldestDays   int64
}

// reminderDaysOverdue mirrors Math.floor((now - due) / 86_400_000).
func reminderDaysOverdue(now, due time.Time) int64 {
	return int64(math.Floor(now.Sub(due).Hours() / 24))
}

// aggregateOverdueReminders mirrors erp-core buildReminders grouping: only
// invoices with a positive balance and a past due-or-issue date count, one
// group per customer and currency, oldest days kept as the maximum.
func aggregateOverdueReminders(rows []reminderInvoiceRow, now time.Time) []reminderGroup {
	groups := make(map[string]*reminderGroup)
	keys := make([]string, 0)
	for _, row := range rows {
		balance := row.totalMinor - row.paidMinor - row.creditedMinor
		if balance <= 0 {
			continue
		}
		due := row.dueAt
		if due == nil {
			due = row.issuedAt
		}
		if due == nil {
			continue
		}
		daysOverdue := reminderDaysOverdue(now, *due)
		if daysOverdue <= 0 {
			continue
		}
		key := row.customerID + ":" + row.currency
		group, ok := groups[key]
		if !ok {
			group = &reminderGroup{customerID: row.customerID, customerName: row.customerName, currency: row.currency}
			groups[key] = group
			keys = append(keys, key)
		}
		group.count++
		group.totalMinor += balance
		if daysOverdue > group.oldestDays {
			group.oldestDays = daysOverdue
		}
	}
	grouped := make([]reminderGroup, 0, len(keys))
	for _, key := range keys {
		grouped = append(grouped, *groups[key])
	}
	return grouped
}

// formatReminderAmount mirrors (totalMinor / 10**minorUnits).toLocaleString(
// "en-US", { minimumFractionDigits: minorUnits, maximumFractionDigits:
// minorUnits }) with exact integer math, so no rounding can occur.
func formatReminderAmount(totalMinor, minorUnits int64) string {
	units, fraction := totalMinor, int64(0)
	if minorUnits > 0 {
		scale := int64(1)
		for index := int64(0); index < minorUnits; index++ {
			scale *= 10
		}
		units, fraction = totalMinor/scale, totalMinor%scale
	}
	digits := strconv.FormatInt(units, 10)
	sign := ""
	if strings.HasPrefix(digits, "-") {
		sign, digits = "-", digits[1:]
	}
	var builder strings.Builder
	builder.WriteString(sign)
	for position, digit := range digits {
		if position > 0 && (len(digits)-position)%3 == 0 {
			builder.WriteByte(',')
		}
		builder.WriteRune(digit)
	}
	if minorUnits <= 0 {
		return builder.String()
	}
	return fmt.Sprintf("%s.%0*d", builder.String(), int(minorUnits), fraction)
}

func buildReminderMessage(group reminderGroup) string {
	minorUnits := int64(2)
	if units, ok := currencyMinorUnits(group.currency); ok {
		minorUnits = units
	}
	amount := formatReminderAmount(group.totalMinor, minorUnits)
	invoiceNoun, invoiceVerb := "invoices", "are"
	if group.count == 1 {
		invoiceNoun, invoiceVerb = "invoice", "is"
	}
	dayNoun := "days"
	if group.oldestDays == 1 {
		dayNoun = "day"
	}
	return fmt.Sprintf("Hi %s - a friendly nudge that %d %s totalling %s %s %s now %d %s past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience.",
		group.customerName, group.count, invoiceNoun, group.currency, amount, invoiceVerb, group.oldestDays, dayNoun)
}

func buildOverdueReminders(rows []reminderInvoiceRow, now time.Time) []PaymentReminderSummary {
	groups := aggregateOverdueReminders(rows, now)
	reminders := make([]PaymentReminderSummary, 0, len(groups))
	for _, group := range groups {
		reminders = append(reminders, PaymentReminderSummary{
			CustomerID:        group.customerID,
			CustomerName:      group.customerName,
			Currency:          group.currency,
			OverdueCount:      group.count,
			OldestDaysOverdue: group.oldestDays,
			TotalOverdueMinor: group.totalMinor,
			Message:           buildReminderMessage(group),
		})
	}
	sort.Slice(reminders, func(i, j int) bool {
		if reminders[i].OldestDaysOverdue != reminders[j].OldestDaysOverdue {
			return reminders[i].OldestDaysOverdue > reminders[j].OldestDaysOverdue
		}
		if reminders[i].CustomerName != reminders[j].CustomerName {
			return reminders[i].CustomerName < reminders[j].CustomerName
		}
		return reminders[i].Currency < reminders[j].Currency
	})
	return reminders
}

func buildReminders(ctx context.Context, tx pgx.Tx, orgID string, _ BuildRemindersInput, now time.Time) (BuildRemindersOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT i.total_minor, i.paid_minor, i.credited_minor, i.currency, i.due_at, i.issued_at, c.id::text, c.name
		FROM invoices i
		JOIN customers c ON c.id = i.customer_id
		WHERE i.org_id = $1::uuid AND i.status = 'sent' AND i.voided_at IS NULL AND c.reminder_opt_out = false
		LIMIT 500`, orgID)
	if err != nil {
		return BuildRemindersOutput{}, err
	}
	defer rows.Close()
	invoices := make([]reminderInvoiceRow, 0, 16)
	for rows.Next() {
		var invoice reminderInvoiceRow
		if err := rows.Scan(&invoice.totalMinor, &invoice.paidMinor, &invoice.creditedMinor,
			&invoice.currency, &invoice.dueAt, &invoice.issuedAt, &invoice.customerID, &invoice.customerName); err != nil {
			return BuildRemindersOutput{}, err
		}
		invoices = append(invoices, invoice)
	}
	if err := rows.Err(); err != nil {
		return BuildRemindersOutput{}, err
	}
	return BuildRemindersOutput{Reminders: buildOverdueReminders(invoices, now)}, nil
}

func parseAccountingPolicyInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case setExpensePolicyCapabilityID:
		return ParseSetExpensePolicyInput(raw)
	case listExpensePoliciesCapabilityID:
		return ParseListExpensePoliciesInput(raw)
	case buildRemindersCapabilityID:
		return ParseBuildRemindersInput(raw)
	default:
		return nil, errors.New("unsupported accounting policy capability")
	}
}
