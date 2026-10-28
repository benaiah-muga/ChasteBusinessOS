package signals

import (
	"context"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	purchasingDelayedDays    = 1
	purchasingOverdueDays    = 30
	purchasingOverdueRedDays = 60
	purchasingRowCap         = 200
)

type delayedPurchaseOrderRow struct {
	id         string
	number     int64
	vendorName string
	status     string
	promisedAt time.Time
}

type overdueVendorBillRow struct {
	id            string
	number        int64
	vendorName    string
	dueAt         time.Time
	totalMinor    int64
	paidMinor     int64
	creditedMinor int64
}

type getPurchaseOrderDraft struct {
	PONumber int64 `json:"poNumber"`
}

// NewPurchasingProducer raises the supply-side exceptions that the
// receivables feed cannot see: a supplier promise that has lapsed and a bill
// whose due date has passed. Both are advisory; paying or chasing remains a
// human decision.
func NewPurchasingProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return purchasingSignals(ctx, tx, orgID, now)
		})
	}
}

func purchasingSignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	var collected []capability.BusinessSignal

	orders, err := delayedPurchaseOrders(ctx, tx, orgID, now)
	if err != nil {
		return nil, err
	}
	for _, order := range orders {
		days := ageDays(now.Sub(order.promisedAt))
		severity := "orange"
		if days >= 7 {
			severity = "red"
		}
		collected = append(collected, capability.BusinessSignal{
			ID:       fmt.Sprintf("purchasing.orderDelayed:%s", order.id),
			Severity: severity,
			Module:   "purchasing",
			Subject:  fmt.Sprintf("Purchase order #%d is %d %s past its promised date", order.number, days, dayWord(days)),
			Detail:   fmt.Sprintf("%s promised delivery on %s; the order is still %s. Confirm whether it shipped, revise the promise, or source elsewhere before the shortage reaches a customer.", quoteTitle(order.vendorName), order.promisedAt.UTC().Format("2006-01-02"), order.status),
			Evidence: evidence("purchase_order", order.id),
			SuggestedAction: suggestedAction("purchasing.getPurchaseOrder", getPurchaseOrderDraft{
				PONumber: order.number,
			}),
		})
	}

	bills, err := overdueVendorBills(ctx, tx, orgID, now)
	if err != nil {
		return nil, err
	}
	for _, bill := range bills {
		outstanding := bill.totalMinor - bill.paidMinor - bill.creditedMinor
		if outstanding <= 0 {
			continue
		}
		days := ageDays(now.Sub(bill.dueAt))
		if days < purchasingOverdueDays {
			continue
		}
		severity := "orange"
		if days >= purchasingOverdueRedDays {
			severity = "red"
		}
		collected = append(collected, capability.BusinessSignal{
			ID:       fmt.Sprintf("purchasing.billOverdue:%s", bill.id),
			Severity: severity,
			Module:   "purchasing",
			Subject:  fmt.Sprintf("Supplier bill #%d is %d days past due", bill.number, days),
			Detail:   fmt.Sprintf("%s is still owed to %s (due %s). Review the cash position and pay it, or record why it is being withheld.", formatMinor(outstanding), quoteTitle(bill.vendorName), bill.dueAt.UTC().Format("2006-01-02")),
			Evidence: evidence("bill", bill.id),
		})
	}

	return collected, nil
}

func delayedPurchaseOrders(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]delayedPurchaseOrderRow, error) {
	cutoff := now.Add(-time.Duration(purchasingDelayedDays) * 24 * time.Hour)
	rows, err := tx.Query(ctx, `
		SELECT po.id::text, po.number, v.name, po.status, po.promised_at
		FROM purchase_orders po
		JOIN vendors v ON v.id = po.vendor_id AND v.org_id = po.org_id
		WHERE po.org_id = $1::uuid
		  AND po.status IN ('ordered', 'partial')
		  AND po.voided_at IS NULL
		  AND po.promised_at IS NOT NULL
		  AND po.promised_at < $2
		ORDER BY po.promised_at ASC, po.id ASC
		LIMIT $3`, orgID, cutoff, purchasingRowCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	orders := make([]delayedPurchaseOrderRow, 0)
	for rows.Next() {
		var order delayedPurchaseOrderRow
		if err := rows.Scan(&order.id, &order.number, &order.vendorName, &order.status, &order.promisedAt); err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, rows.Err()
}

func overdueVendorBills(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]overdueVendorBillRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT b.id::text, b.number, v.name, b.due_at, b.total_minor, b.paid_minor, b.credited_minor
		FROM vendor_bills b
		JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
		WHERE b.org_id = $1::uuid
		  AND b.status = 'open'
		  AND b.voided_at IS NULL
		  AND b.due_at IS NOT NULL
		  AND b.due_at < $2
		ORDER BY b.due_at ASC, b.id ASC
		LIMIT $3`, orgID, now, purchasingRowCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bills := make([]overdueVendorBillRow, 0)
	for rows.Next() {
		var bill overdueVendorBillRow
		if err := rows.Scan(&bill.id, &bill.number, &bill.vendorName, &bill.dueAt, &bill.totalMinor, &bill.paidMinor, &bill.creditedMinor); err != nil {
			return nil, err
		}
		bills = append(bills, bill)
	}
	return bills, rows.Err()
}
