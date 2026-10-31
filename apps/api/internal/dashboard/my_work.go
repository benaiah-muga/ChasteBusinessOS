package dashboard

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type PendingApproval struct {
	ID           string
	CapabilityID string
	Rationale    *string
	RiskClass    string
	CreatedAt    time.Time
}

type ReceiptRemainder struct {
	PurchaseOrderID string
	Number          int64
	Remaining       int64
	Lines           []ReceiptRemainderLine
}

type ReceiptRemainderLine struct {
	Position    int64
	Description string
	Remaining   int64
}

type MyWorkData struct {
	Approvals  []PendingApproval
	Remainders []ReceiptRemainder
}

type MyWorkPostgresReader struct {
	pool dbx.Beginner
}

func NewMyWorkPostgresReader(pool dbx.Beginner) *MyWorkPostgresReader {
	return &MyWorkPostgresReader{pool: pool}
}

func (r *MyWorkPostgresReader) ForOrg(ctx context.Context, orgID string, includePurchasing bool) (MyWorkData, error) {
	if r == nil || r.pool == nil {
		return MyWorkData{}, fmt.Errorf("my work reader is unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (MyWorkData, error) {
		data := MyWorkData{Approvals: []PendingApproval{}, Remainders: []ReceiptRemainder{}}
		approvals, err := readPendingWorkApprovals(ctx, tx, orgID)
		if err != nil {
			return MyWorkData{}, fmt.Errorf("read my work approvals: %w", err)
		}
		data.Approvals = approvals
		if includePurchasing {
			remainders, err := readReceiptRemainders(ctx, tx, orgID)
			if err != nil {
				return MyWorkData{}, fmt.Errorf("read my work receipt remainders: %w", err)
			}
			data.Remainders = remainders
		}
		return data, nil
	})
}

func readPendingWorkApprovals(ctx context.Context, tx pgx.Tx, orgID string) ([]PendingApproval, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, capability_id, rationale, risk_class, created_at
		FROM approvals
		WHERE org_id = $1::uuid AND status = 'pending'
		ORDER BY created_at ASC LIMIT 20`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	approvals := make([]PendingApproval, 0)
	for rows.Next() {
		var approval PendingApproval
		if err := rows.Scan(&approval.ID, &approval.CapabilityID, &approval.Rationale, &approval.RiskClass, &approval.CreatedAt); err != nil {
			return nil, err
		}
		approvals = append(approvals, approval)
	}
	return approvals, rows.Err()
}

func readReceiptRemainders(ctx context.Context, tx pgx.Tx, orgID string) ([]ReceiptRemainder, error) {
	rows, err := tx.Query(ctx, `
		WITH partial_pos AS (
			SELECT id, number, row_number() OVER () AS legacy_order
			FROM purchase_orders
			WHERE org_id = $1::uuid AND status = 'partial'
			LIMIT 20
		)
		SELECT po.id::text, po.number, line.position, line.description, line.quantity,
			COALESCE((SELECT sum(gr.accepted_thousandths) FROM goods_receipt_lines gr WHERE gr.org_id=$1::uuid AND gr.po_line_id=line.id), 0)
				+ COALESCE((SELECT sum(sm.quantity_delta) FROM stock_movements sm WHERE sm.org_id=$1::uuid AND sm.ref_type='po_line' AND sm.ref_id=line.id AND sm.quantity_delta > 0), 0),
			COALESCE((SELECT sum(gr.rejected_thousandths) FROM goods_receipt_lines gr WHERE gr.org_id=$1::uuid AND gr.po_line_id=line.id), 0),
			COALESCE((SELECT sum(gr.returned_thousandths) FROM goods_receipt_lines gr WHERE gr.org_id=$1::uuid AND gr.po_line_id=line.id), 0)
				+ COALESCE((SELECT sum(-sm.quantity_delta) FROM stock_movements sm WHERE sm.org_id=$1::uuid AND sm.ref_type='po_line' AND sm.ref_id=line.id AND sm.quantity_delta < 0), 0)
		FROM partial_pos po
		JOIN po_lines line ON line.po_id = po.id
		ORDER BY po.legacy_order`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[string]int)
	ordered := make([]ReceiptRemainder, 0)
	for rows.Next() {
		var poID, description string
		var number, position, orderedQuantity, accepted, rejected, returned int64
		if err := rows.Scan(&poID, &number, &position, &description, &orderedQuantity, &accepted, &rejected, &returned); err != nil {
			return nil, err
		}
		remaining := remainingReceiptQuantity(orderedQuantity, accepted, rejected, returned)
		if remaining <= 0 {
			continue
		}
		index, exists := byID[poID]
		if !exists {
			index = len(ordered)
			byID[poID] = index
			ordered = append(ordered, ReceiptRemainder{PurchaseOrderID: poID, Number: number})
		}
		ordered[index].Remaining += remaining
		ordered[index].Lines = append(ordered[index].Lines, ReceiptRemainderLine{Position: position, Description: description, Remaining: remaining})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// The legacy route uses stable sorting, preserving the database order for ties.
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Remaining > ordered[j].Remaining })
	return ordered, nil
}

func FormatWorkThousandths(thousandths int64) string {
	whole := thousandths / 1000
	fraction := thousandths % 1000
	if fraction == 0 {
		return fmt.Sprintf("%d units", whole)
	}
	fractionText := strings.TrimRight(fmt.Sprintf("%03d", fraction), "0")
	return fmt.Sprintf("%d.%s units", whole, fractionText)
}

func remainingReceiptQuantity(ordered, accepted, rejected, returned int64) int64 {
	return ordered - accepted - rejected + returned
}
