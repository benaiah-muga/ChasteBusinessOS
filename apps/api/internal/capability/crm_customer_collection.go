package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type ListCRMCustomerCollectionInput struct{}

func ParseListCRMCustomerCollectionInput(raw json.RawMessage) (ListCRMCustomerCollectionInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListCRMCustomerCollectionInput{}, err
	}
	return ListCRMCustomerCollectionInput{}, nil
}

type crmCustomerRow struct {
	item       CRMCustomerCollectionItem
	createdAt  time.Time
	ownerEmail *string
}

func listCRMCustomerCollection(ctx context.Context, tx pgx.Tx, orgID string, _ ListCRMCustomerCollectionInput, now time.Time) (ListCRMCustomerCollectionOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT c.id::text, c.name, c.email, c.owner_user_id::text, owner.name, owner.email,
			c.phone, c.preferred_contact_method, c.do_not_contact,
			c.updated_by_user_id::text, editor.name, editor.email, c.tags, c.notes,
			c.created_at, c.updated_at, c.deactivated_at
		FROM customers c
		LEFT JOIN users owner ON owner.id = c.owner_user_id
		LEFT JOIN users editor ON editor.id = c.updated_by_user_id
		WHERE c.org_id = $1::uuid AND c.merged_into_customer_id IS NULL
		ORDER BY c.name
		LIMIT 500`, orgID)
	if err != nil {
		return ListCRMCustomerCollectionOutput{}, err
	}
	customers := make([]crmCustomerRow, 0, 500)
	for rows.Next() {
		var row crmCustomerRow
		var updatedAt time.Time
		var deactivatedAt *time.Time
		if err := rows.Scan(
			&row.item.ID, &row.item.Name, &row.item.Email, &row.item.OwnerUserID, &row.item.OwnerName, &row.ownerEmail,
			&row.item.Phone, &row.item.PreferredContactMethod, &row.item.DoNotContact,
			&row.item.UpdatedByUserID, &row.item.UpdatedByName, &row.item.UpdatedByEmail, &row.item.Tags, &row.item.Notes,
			&row.createdAt, &updatedAt, &deactivatedAt,
		); err != nil {
			rows.Close()
			return ListCRMCustomerCollectionOutput{}, err
		}
		if row.item.OwnerName == nil {
			row.item.OwnerName = row.ownerEmail
		}
		row.item.CreatedAt = crmCustomerJSDate(row.createdAt)
		row.item.UpdatedAt = crmCustomerJSDate(updatedAt)
		if deactivatedAt != nil {
			value := crmCustomerJSDate(*deactivatedAt)
			row.item.DeactivatedAt = &value
		}
		if row.item.Tags == nil {
			row.item.Tags = []string{}
		}
		row.item.MergedRecords = []CRMCustomerMergedRecord{}
		row.item.LastActivityAt = row.item.CreatedAt
		customers = append(customers, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ListCRMCustomerCollectionOutput{}, err
	}
	rows.Close()

	mergedRecords := make(map[string][]CRMCustomerMergedRecord)
	canonicalCustomerID := make(map[string]string)
	mergedRows, err := tx.Query(ctx, `
		SELECT id::text, name, merged_into_customer_id::text, merged_at
		FROM customers
		WHERE org_id = $1::uuid AND merged_into_customer_id IS NOT NULL
		ORDER BY name`, orgID)
	if err != nil {
		return ListCRMCustomerCollectionOutput{}, err
	}
	for mergedRows.Next() {
		var id, name, canonicalID string
		var mergedAt *time.Time
		if err := mergedRows.Scan(&id, &name, &canonicalID, &mergedAt); err != nil {
			mergedRows.Close()
			return ListCRMCustomerCollectionOutput{}, err
		}
		var mergedAtISO *string
		if mergedAt != nil {
			value := crmCustomerJSDate(*mergedAt)
			mergedAtISO = &value
		}
		mergedRecords[canonicalID] = append(mergedRecords[canonicalID], CRMCustomerMergedRecord{ID: id, Name: name, MergedAt: mergedAtISO})
		canonicalCustomerID[id] = canonicalID
	}
	if err := mergedRows.Err(); err != nil {
		mergedRows.Close()
		return ListCRMCustomerCollectionOutput{}, err
	}
	mergedRows.Close()

	if err := readCRMCustomerPurchaseStats(ctx, tx, orgID, canonicalCustomerID, customers); err != nil {
		return ListCRMCustomerCollectionOutput{}, err
	}
	if err := readCRMCustomerActivity(ctx, tx, orgID, canonicalCustomerID, customers); err != nil {
		return ListCRMCustomerCollectionOutput{}, err
	}
	if err := readCRMCustomerNextSteps(ctx, tx, orgID, canonicalCustomerID, now, customers); err != nil {
		return ListCRMCustomerCollectionOutput{}, err
	}
	for i := range customers {
		if records, ok := mergedRecords[customers[i].item.ID]; ok {
			customers[i].item.MergedRecords = records
		}
	}
	output := ListCRMCustomerCollectionOutput{Customers: make([]CRMCustomerCollectionItem, len(customers))}
	for i := range customers {
		output.Customers[i] = customers[i].item
	}
	return output, nil
}

func readCRMCustomerPurchaseStats(ctx context.Context, tx pgx.Tx, orgID string, aliases map[string]string, customers []crmCustomerRow) error {
	rows, err := tx.Query(ctx, `
		SELECT customer_id::text, count(*)::bigint,
			COALESCE(sum(total_minor - credited_minor), 0)::bigint
		FROM invoices
		WHERE org_id = $1::uuid AND pos_session_id IS NOT NULL AND customer_id IS NOT NULL
		GROUP BY customer_id`, orgID)
	if err != nil {
		return err
	}
	indexes := make(map[string]int, len(customers))
	for i := range customers {
		indexes[customers[i].item.ID] = i
	}
	for rows.Next() {
		var id string
		var count, spend int64
		if err := rows.Scan(&id, &count, &spend); err != nil {
			rows.Close()
			return err
		}
		if canonical, ok := aliases[id]; ok {
			id = canonical
		}
		if index, ok := indexes[id]; ok {
			customers[index].item.PurchaseCount += count
			customers[index].item.LifetimeSpendMinor += spend
		}
	}
	err = rows.Err()
	rows.Close()
	return err
}

func readCRMCustomerActivity(ctx context.Context, tx pgx.Tx, orgID string, aliases map[string]string, customers []crmCustomerRow) error {
	rows, err := tx.Query(ctx, `
		WITH activity AS (
			SELECT customer_id, max(updated_at) AS activity_at FROM deals
			WHERE org_id = $1::uuid AND customer_id IS NOT NULL GROUP BY customer_id
			UNION ALL
			SELECT ref_id, max(created_at) FROM tasks
			WHERE org_id = $1::uuid AND ref_type = 'customer' AND ref_id IS NOT NULL GROUP BY ref_id
			UNION ALL
			SELECT ref_id, max(done_at) FROM tasks
			WHERE org_id = $1::uuid AND ref_type = 'customer' AND ref_id IS NOT NULL GROUP BY ref_id
			UNION ALL
			SELECT customer_id, max(issued_at) FROM invoices
			WHERE org_id = $1::uuid GROUP BY customer_id
			UNION ALL
			SELECT customer_id, max(created_at) FROM quotes
			WHERE org_id = $1::uuid GROUP BY customer_id
			UNION ALL
			SELECT customer_id, max(decided_at) FROM quotes
			WHERE org_id = $1::uuid GROUP BY customer_id
			UNION ALL
			SELECT ref_id, max(updated_at) FROM documents
			WHERE org_id = $1::uuid AND ref_type = 'customer' AND ref_id IS NOT NULL GROUP BY ref_id
		), canonical_activity AS (
			SELECT COALESCE(c.merged_into_customer_id, a.customer_id) AS customer_id, a.activity_at
			FROM activity a
			LEFT JOIN customers c ON c.id = a.customer_id AND c.org_id = $1::uuid
			WHERE a.activity_at IS NOT NULL
		)
		SELECT customer_id::text, max(activity_at)
		FROM canonical_activity
		GROUP BY customer_id`, orgID)
	if err != nil {
		return err
	}
	indexes := make(map[string]int, len(customers))
	for i := range customers {
		indexes[customers[i].item.ID] = i
	}
	for rows.Next() {
		var id string
		var last time.Time
		if err := rows.Scan(&id, &last); err != nil {
			rows.Close()
			return err
		}
		if canonical, ok := aliases[id]; ok {
			id = canonical
		}
		if index, ok := indexes[id]; ok && last.After(parseCRMCustomerDate(customers[index].item.LastActivityAt)) {
			customers[index].item.LastActivityAt = crmCustomerJSDate(last)
		}
	}
	err = rows.Err()
	rows.Close()
	return err
}

type crmCustomerNextStepCandidate struct {
	step CRMCustomerNextStep
	rank int
	at   time.Time
}

func readCRMCustomerNextSteps(ctx context.Context, tx pgx.Tx, orgID string, aliases map[string]string, now time.Time, customers []crmCustomerRow) error {
	indexes := make(map[string]int, len(customers))
	best := make(map[string]crmCustomerNextStepCandidate)
	for i := range customers {
		indexes[customers[i].item.ID] = i
	}
	setCandidate := func(customerID string, candidate crmCustomerNextStepCandidate) {
		if canonical, ok := aliases[customerID]; ok {
			customerID = canonical
		}
		if _, ok := indexes[customerID]; !ok {
			return
		}
		current, exists := best[customerID]
		if !exists || candidate.rank < current.rank {
			best[customerID] = candidate
		}
	}

	invoiceRows, err := tx.Query(ctx, `
		SELECT id::text, customer_id::text, number, total_minor, paid_minor, credited_minor, due_at
		FROM invoices
		WHERE org_id = $1::uuid AND status = 'sent' AND due_at IS NOT NULL AND due_at < $2
		ORDER BY due_at
		LIMIT 2000`, orgID, now)
	if err != nil {
		return err
	}
	for invoiceRows.Next() {
		var id, customerID string
		var number, total, paid, credited int64
		var dueAt time.Time
		if err := invoiceRows.Scan(&id, &customerID, &number, &total, &paid, &credited, &dueAt); err != nil {
			invoiceRows.Close()
			return err
		}
		outstanding := max(int64(0), total-paid-credited)
		if outstanding == 0 {
			continue
		}
		days := int(now.Sub(dueAt).Hours() / 24)
		amount := outstanding
		setCandidate(customerID, crmCustomerNextStepCandidate{
			step: CRMCustomerNextStep{Kind: "invoice", Summary: fmt.Sprintf("Invoice #%d is overdue by %dd", number, days), RefID: id, AmountMinor: &amount},
			rank: 1, at: dueAt,
		})
	}
	if err := invoiceRows.Err(); err != nil {
		invoiceRows.Close()
		return err
	}
	invoiceRows.Close()

	todayStart := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	todayEnd := todayStart.Add(24*time.Hour - time.Millisecond)
	taskRows, err := tx.Query(ctx, `
		SELECT id::text, ref_id::text, title, due_at
		FROM tasks
		WHERE org_id = $1::uuid AND ref_type = 'customer' AND done_at IS NULL AND ref_id IS NOT NULL
			AND due_at IS NOT NULL AND due_at <= $2
		ORDER BY due_at
		LIMIT 2000`, orgID, todayEnd)
	if err != nil {
		return err
	}
	for taskRows.Next() {
		var id, customerID, title string
		var dueAt time.Time
		if err := taskRows.Scan(&id, &customerID, &title, &dueAt); err != nil {
			taskRows.Close()
			return err
		}
		rank := 3
		label := "Follow-up due today"
		if dueAt.Before(todayStart) {
			rank = 2
			label = "Overdue follow-up"
		}
		setCandidate(customerID, crmCustomerNextStepCandidate{
			step: CRMCustomerNextStep{Kind: "task", Summary: label + ": " + title, RefID: id}, rank: rank, at: dueAt,
		})
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return err
	}
	taskRows.Close()

	quoteBoundary := now.Add(-7 * 24 * time.Hour)
	quoteRows, err := tx.Query(ctx, `
		SELECT id::text, customer_id::text, number, created_at
		FROM quotes
		WHERE org_id = $1::uuid AND status = 'sent' AND created_at < $2
		ORDER BY created_at
		LIMIT 2000`, orgID, quoteBoundary)
	if err != nil {
		return err
	}
	for quoteRows.Next() {
		var id, customerID string
		var number int64
		var createdAt time.Time
		if err := quoteRows.Scan(&id, &customerID, &number, &createdAt); err != nil {
			quoteRows.Close()
			return err
		}
		days := int(now.Sub(createdAt).Hours() / 24)
		setCandidate(customerID, crmCustomerNextStepCandidate{
			step: CRMCustomerNextStep{Kind: "quote", Summary: fmt.Sprintf("Quote #%d is waiting for %d days", number, days), RefID: id},
			rank: 4, at: createdAt,
		})
	}
	if err := quoteRows.Err(); err != nil {
		quoteRows.Close()
		return err
	}
	quoteRows.Close()
	for customerID, candidate := range best {
		customers[indexes[customerID]].item.NextStep = &candidate.step
	}
	return nil
}

func crmCustomerJSDate(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func parseCRMCustomerDate(value string) time.Time {
	parsed, _ := time.Parse("2006-01-02T15:04:05.000Z", value)
	return parsed
}
