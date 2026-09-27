package capability

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type CustomerTimelineInput struct {
	CustomerID string `json:"customerId"`
	Limit      *int64 `json:"limit,omitempty"`
}

type CustomerTimelineEntry struct {
	Kind    string `json:"kind"`
	Date    string `json:"date"`
	RefID   string `json:"refId"`
	Summary string `json:"summary"`
}

type CustomerTimelineOutput struct {
	Entries []CustomerTimelineEntry `json:"entries"`
}

type customerTimelineRow struct {
	kind    string
	date    time.Time
	refID   string
	summary string
}

func ParseCustomerTimelineInput(raw json.RawMessage) (CustomerTimelineInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CustomerTimelineInput{}, err
	}
	customerID, err := requiredString(fields, "customerId")
	if err != nil {
		return CustomerTimelineInput{}, errors.New("customerId must be a string")
	}
	input := CustomerTimelineInput{CustomerID: customerID}
	if _, ok := fields["limit"]; ok {
		limit, err := requiredSafeInteger(fields, "limit")
		if err != nil || limit < 1 || limit > 200 {
			return CustomerTimelineInput{}, errors.New("limit must be a positive integer at most 200")
		}
		input.Limit = &limit
	}
	return input, nil
}

func customerTimeline(ctx context.Context, tx pgx.Tx, orgID string, input CustomerTimelineInput) (CustomerTimelineOutput, error) {
	limit := int64(50)
	if input.Limit != nil {
		limit = *input.Limit
	}
	var ownedID string
	err := tx.QueryRow(ctx, `
		SELECT id::text
		FROM customers
		WHERE id = $1::uuid AND org_id = $2::uuid`, input.CustomerID, orgID).Scan(&ownedID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomerTimelineOutput{}, errors.New("customer not found in this organization")
		}
		return CustomerTimelineOutput{}, err
	}

	entries := make([]customerTimelineRow, 0)
	linkedCustomers := `
		SELECT id
		FROM customers
		WHERE org_id = $1::uuid AND (id = $2::uuid OR merged_into_customer_id = $2::uuid)`

	// Keep the same source order as the legacy capability. Stable sorting below
	// preserves this order when JavaScript Date values have equal milliseconds.
	invoiceRows, err := tx.Query(ctx, `
		SELECT id::text, number, status, total_minor, issued_at
		FROM invoices
		WHERE org_id = $1::uuid AND customer_id IN (`+linkedCustomers+`)
		ORDER BY issued_at DESC
		LIMIT $3`, orgID, ownedID, limit)
	if err != nil {
		return CustomerTimelineOutput{}, err
	}
	for invoiceRows.Next() {
		var id, status string
		var number, totalMinor int64
		var issuedAt *time.Time
		if err := invoiceRows.Scan(&id, &number, &status, &totalMinor, &issuedAt); err != nil {
			invoiceRows.Close()
			return CustomerTimelineOutput{}, err
		}
		if issuedAt == nil {
			continue
		}
		entries = append(entries, customerTimelineRow{
			kind: "invoice", date: jsDate(*issuedAt), refID: id,
			summary: "Invoice #" + strconv.FormatInt(number, 10) + " (" + status + ", " + timelineMoney(totalMinor) + ")",
		})
	}
	if err := invoiceRows.Err(); err != nil {
		invoiceRows.Close()
		return CustomerTimelineOutput{}, err
	}
	invoiceRows.Close()

	paymentRows, err := tx.Query(ctx, `
		SELECT p.id::text, p.amount_minor, p.method, p.received_at
		FROM payments p
		INNER JOIN invoices i ON p.invoice_id = i.id
		WHERE p.org_id = $1::uuid AND i.customer_id IN (`+linkedCustomers+`)
		ORDER BY p.received_at DESC
		LIMIT $3`, orgID, ownedID, limit)
	if err != nil {
		return CustomerTimelineOutput{}, err
	}
	for paymentRows.Next() {
		var id, method string
		var amountMinor int64
		var receivedAt time.Time
		if err := paymentRows.Scan(&id, &amountMinor, &method, &receivedAt); err != nil {
			paymentRows.Close()
			return CustomerTimelineOutput{}, err
		}
		entries = append(entries, customerTimelineRow{
			kind: "payment", date: jsDate(receivedAt), refID: id,
			summary: "Payment " + timelineMoney(amountMinor) + " via " + method,
		})
	}
	if err := paymentRows.Err(); err != nil {
		paymentRows.Close()
		return CustomerTimelineOutput{}, err
	}
	paymentRows.Close()

	quoteRows, err := tx.Query(ctx, `
		SELECT id::text, number, status, total_minor, decided_at, created_at
		FROM quotes
		WHERE org_id = $1::uuid AND customer_id IN (`+linkedCustomers+`)
		LIMIT $3`, orgID, ownedID, limit)
	if err != nil {
		return CustomerTimelineOutput{}, err
	}
	for quoteRows.Next() {
		var id, status string
		var number, totalMinor int64
		var decidedAt *time.Time
		var createdAt time.Time
		if err := quoteRows.Scan(&id, &number, &status, &totalMinor, &decidedAt, &createdAt); err != nil {
			quoteRows.Close()
			return CustomerTimelineOutput{}, err
		}
		date := createdAt
		if decidedAt != nil {
			date = *decidedAt
		}
		entries = append(entries, customerTimelineRow{
			kind: "quote", date: jsDate(date), refID: id,
			summary: "Quote #" + strconv.FormatInt(number, 10) + " (" + status + ", " + timelineMoney(totalMinor) + ")",
		})
	}
	if err := quoteRows.Err(); err != nil {
		quoteRows.Close()
		return CustomerTimelineOutput{}, err
	}
	quoteRows.Close()

	dealRows, err := tx.Query(ctx, `
		SELECT id::text, title, stage, value_minor, updated_at
		FROM deals
		WHERE org_id = $1::uuid AND customer_id IN (`+linkedCustomers+`)
		LIMIT $3`, orgID, ownedID, limit)
	if err != nil {
		return CustomerTimelineOutput{}, err
	}
	for dealRows.Next() {
		var id, title, stage string
		var valueMinor int64
		var updatedAt time.Time
		if err := dealRows.Scan(&id, &title, &stage, &valueMinor, &updatedAt); err != nil {
			dealRows.Close()
			return CustomerTimelineOutput{}, err
		}
		entries = append(entries, customerTimelineRow{
			kind: "deal", date: jsDate(updatedAt), refID: id,
			summary: "Deal \"" + title + "\" (" + stage + ", " + timelineMoney(valueMinor) + ")",
		})
	}
	if err := dealRows.Err(); err != nil {
		dealRows.Close()
		return CustomerTimelineOutput{}, err
	}
	dealRows.Close()

	taskRows, err := tx.Query(ctx, `
		SELECT id::text, title, due_at, done_at, created_at
		FROM tasks
		WHERE org_id = $1::uuid AND ref_type = 'customer' AND ref_id IN (`+linkedCustomers+`)
		LIMIT $3`, orgID, ownedID, limit)
	if err != nil {
		return CustomerTimelineOutput{}, err
	}
	for taskRows.Next() {
		var id, title string
		var dueAt, doneAt *time.Time
		var createdAt time.Time
		if err := taskRows.Scan(&id, &title, &dueAt, &doneAt, &createdAt); err != nil {
			taskRows.Close()
			return CustomerTimelineOutput{}, err
		}
		date := createdAt
		if dueAt != nil {
			date = *dueAt
		}
		if doneAt != nil {
			date = *doneAt
		}
		summary := "Task \"" + title + "\""
		if doneAt != nil {
			summary += " (done)"
		}
		entries = append(entries, customerTimelineRow{kind: "task", date: jsDate(date), refID: id, summary: summary})
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return CustomerTimelineOutput{}, err
	}
	taskRows.Close()

	documentRows, err := tx.Query(ctx, `
		SELECT id::text, title, status, updated_at
		FROM documents
		WHERE org_id = $1::uuid AND ref_type = 'customer' AND ref_id IN (`+linkedCustomers+`)
		LIMIT $3`, orgID, ownedID, limit)
	if err != nil {
		return CustomerTimelineOutput{}, err
	}
	for documentRows.Next() {
		var id, title, status string
		var updatedAt time.Time
		if err := documentRows.Scan(&id, &title, &status, &updatedAt); err != nil {
			documentRows.Close()
			return CustomerTimelineOutput{}, err
		}
		entries = append(entries, customerTimelineRow{
			kind: "document", date: jsDate(updatedAt), refID: id,
			summary: "Document \"" + title + "\" (" + status + ")",
		})
	}
	if err := documentRows.Err(); err != nil {
		documentRows.Close()
		return CustomerTimelineOutput{}, err
	}
	documentRows.Close()

	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].date.After(entries[j].date)
	})
	if int64(len(entries)) > limit {
		entries = entries[:limit]
	}

	output := CustomerTimelineOutput{Entries: make([]CustomerTimelineEntry, len(entries))}
	for index, entry := range entries {
		output.Entries[index] = CustomerTimelineEntry{
			Kind: entry.kind, Date: entry.date.Format("2006-01-02T15:04:05.000Z"), RefID: entry.refID, Summary: entry.summary,
		}
	}
	return output, nil
}

func jsDate(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

func timelineMoney(minor int64) string {
	whole := minor / 100
	cents := minor % 100
	if cents < 0 {
		cents = -cents
	}
	wholeText := strconv.FormatInt(whole, 10)
	if minor < 0 && whole == 0 {
		wholeText = "-0"
	}
	if cents < 10 {
		return wholeText + ".0" + strconv.FormatInt(cents, 10)
	}
	return wholeText + "." + strconv.FormatInt(cents, 10)
}
