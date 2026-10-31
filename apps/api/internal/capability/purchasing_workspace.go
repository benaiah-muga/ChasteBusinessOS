package capability

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

type PurchasingListWorkspaceInput struct{}

type PurchasingWorkspaceVendor struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Email           *string    `json:"email"`
	PaymentTermDays *int64     `json:"paymentTermDays"`
	DeactivatedAt   *time.Time `json:"deactivatedAt"`
	CreatedAt       time.Time  `json:"createdAt"`
}

type PurchasingWorkspaceOrderLine struct {
	LineNumber           int64  `json:"lineNumber"`
	Description          string `json:"description"`
	Quantity             int64  `json:"quantity"`
	AcceptedThousandths  int64  `json:"acceptedThousandths"`
	RejectedThousandths  int64  `json:"rejectedThousandths"`
	ReturnedThousandths  int64  `json:"returnedThousandths"`
	RemainingThousandths int64  `json:"remainingThousandths"`
	UnitPriceMinor       int64  `json:"unitPriceMinor"`
}

type PurchasingWorkspaceOrder struct {
	ID           string                         `json:"id"`
	Number       int64                          `json:"number"`
	VendorName   string                         `json:"vendorName"`
	Status       string                         `json:"status"`
	Memo         *string                        `json:"memo"`
	OrderedMinor int64                          `json:"orderedMinor"`
	Lines        []PurchasingWorkspaceOrderLine `json:"lines"`
}

type PurchasingWorkspaceBill struct {
	ID            string                           `json:"id"`
	Number        int64                            `json:"number"`
	VendorName    string                           `json:"vendorName"`
	VendorRef     *string                          `json:"vendorRef"`
	Memo          *string                          `json:"memo"`
	TotalMinor    int64                            `json:"totalMinor"`
	Currency      string                           `json:"currency"`
	PaidMinor     int64                            `json:"paidMinor"`
	CreditedMinor int64                            `json:"creditedMinor"`
	Status        string                           `json:"status"`
	DueMinor      int64                            `json:"dueMinor"`
	CreatedAt     time.Time                        `json:"createdAt"`
	Payments      []PurchasingWorkspaceBillPayment `json:"payments"`
}

type PurchasingWorkspaceBillPayment struct {
	ID              string  `json:"id"`
	AmountMinor     int64   `json:"amountMinor"`
	Status          string  `json:"status"`
	PaymentRunID    *string `json:"paymentRunId"`
	ReversalEntryID *string `json:"reversalEntryId"`
}

type PurchasingListWorkspaceOutput struct {
	BaseCurrency        string                              `json:"baseCurrency"`
	Vendors             []PurchasingWorkspaceVendor         `json:"vendors"`
	Orders              []PurchasingWorkspaceOrder          `json:"orders"`
	Bills               []PurchasingWorkspaceBill           `json:"bills"`
	APAging             APAgingOutput                       `json:"apAging"`
	PriceHistory        PurchasingPriceHistoryOutput        `json:"priceHistory"`
	SupplierPerformance PurchasingSupplierPerformanceOutput `json:"supplierPerformance"`
	Requests            []PurchasingWorkspaceRequest        `json:"requests"`
}

type PurchasingWorkspaceRequest struct {
	ID                   string                          `json:"id"`
	Title                string                          `json:"title"`
	Justification        string                          `json:"justification"`
	EstimatedAmountMinor *int64                          `json:"estimatedAmountMinor"`
	Status               string                          `json:"status"`
	DecisionReason       *string                         `json:"decisionReason"`
	CreatedAt            string                          `json:"createdAt"`
	RFQs                 []PurchasingWorkspaceRequestRFQ `json:"rfqs"`
}

type PurchasingWorkspaceRequestRFQ struct {
	ID                string  `json:"id"`
	VendorName        string  `json:"vendorName"`
	Status            string  `json:"status"`
	QuoteAmountMinor  *int64  `json:"quoteAmountMinor"`
	QuoteLeadTimeDays *int64  `json:"quoteLeadTimeDays"`
	QuoteNotes        *string `json:"quoteNotes"`
}

func ParsePurchasingListWorkspaceInput(raw json.RawMessage) (PurchasingListWorkspaceInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return PurchasingListWorkspaceInput{}, err
	}
	return PurchasingListWorkspaceInput{}, nil
}

func purchasingListWorkspace(ctx context.Context, tx pgx.Tx, orgID string, _ PurchasingListWorkspaceInput, now time.Time) (PurchasingListWorkspaceOutput, error) {
	output := PurchasingListWorkspaceOutput{
		BaseCurrency: "USD",
		Vendors:      make([]PurchasingWorkspaceVendor, 0),
		Orders:       make([]PurchasingWorkspaceOrder, 0),
		Bills:        make([]PurchasingWorkspaceBill, 0),
		Requests:     make([]PurchasingWorkspaceRequest, 0),
	}
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id=$1::uuid`, orgID).Scan(&output.BaseCurrency); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PurchasingListWorkspaceOutput{}, err
	}

	vendorNames := make(map[string]string)
	vendorRows, err := tx.Query(ctx, `
		SELECT id::text, name, email, payment_term_days, deactivated_at, created_at
		FROM vendors WHERE org_id=$1::uuid ORDER BY name ASC`, orgID)
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	for vendorRows.Next() {
		var vendor PurchasingWorkspaceVendor
		if err := vendorRows.Scan(&vendor.ID, &vendor.Name, &vendor.Email, &vendor.PaymentTermDays, &vendor.DeactivatedAt, &vendor.CreatedAt); err != nil {
			vendorRows.Close()
			return PurchasingListWorkspaceOutput{}, err
		}
		vendorNames[vendor.ID] = vendor.Name
		output.Vendors = append(output.Vendors, vendor)
	}
	if err := vendorRows.Err(); err != nil {
		vendorRows.Close()
		return PurchasingListWorkspaceOutput{}, err
	}
	vendorRows.Close()

	orderRows, err := tx.Query(ctx, `
		SELECT id::text, vendor_id::text, number, status, memo
		FROM purchase_orders WHERE org_id=$1::uuid
		ORDER BY created_at DESC LIMIT 100`, orgID)
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	orderVendorIDs := make([]string, 0)
	for orderRows.Next() {
		var order PurchasingWorkspaceOrder
		var vendorID string
		order.Lines = make([]PurchasingWorkspaceOrderLine, 0)
		if err := orderRows.Scan(&order.ID, &vendorID, &order.Number, &order.Status, &order.Memo); err != nil {
			orderRows.Close()
			return PurchasingListWorkspaceOutput{}, err
		}
		order.VendorName = vendorNames[vendorID]
		output.Orders = append(output.Orders, order)
		orderVendorIDs = append(orderVendorIDs, order.ID)
	}
	if err := orderRows.Err(); err != nil {
		orderRows.Close()
		return PurchasingListWorkspaceOutput{}, err
	}
	orderRows.Close()

	if len(orderVendorIDs) > 0 {
		lineRows, err := tx.Query(ctx, `
			SELECT line.po_id::text, line.position, line.description, line.quantity, line.unit_price_minor,
			       COALESCE(received.accepted_thousandths, 0),
			       COALESCE(received.rejected_thousandths, 0),
			       COALESCE(received.returned_thousandths, 0)
			FROM po_lines line
			LEFT JOIN LATERAL (
				SELECT SUM(receipt_line.accepted_thousandths)::bigint AS accepted_thousandths,
				       SUM(receipt_line.rejected_thousandths)::bigint AS rejected_thousandths,
				       SUM(receipt_line.returned_thousandths)::bigint AS returned_thousandths
				FROM goods_receipt_lines receipt_line
				WHERE receipt_line.org_id=$2::uuid AND receipt_line.po_line_id=line.id
			) received ON true
			WHERE line.po_id = ANY($1::uuid[]) ORDER BY line.position ASC`, orderVendorIDs, orgID)
		if err != nil {
			return PurchasingListWorkspaceOutput{}, err
		}
		orderIndex := make(map[string]int, len(output.Orders))
		for i := range output.Orders {
			orderIndex[output.Orders[i].ID] = i
		}
		for lineRows.Next() {
			var poID string
			var line PurchasingWorkspaceOrderLine
			if err := lineRows.Scan(
				&poID,
				&line.LineNumber,
				&line.Description,
				&line.Quantity,
				&line.UnitPriceMinor,
				&line.AcceptedThousandths,
				&line.RejectedThousandths,
				&line.ReturnedThousandths,
			); err != nil {
				lineRows.Close()
				return PurchasingListWorkspaceOutput{}, err
			}
			line.RemainingThousandths = line.Quantity - line.AcceptedThousandths - line.RejectedThousandths
			if line.RemainingThousandths < 0 {
				line.RemainingThousandths = 0
			}
			index, ok := orderIndex[poID]
			if !ok {
				continue
			}
			// Legacy Math.round on the nonnegative per-line minor-unit product.
			output.Orders[index].OrderedMinor += int64(math.Round(float64(line.Quantity) * float64(line.UnitPriceMinor) / 1000))
			output.Orders[index].Lines = append(output.Orders[index].Lines, line)
		}
		if err := lineRows.Err(); err != nil {
			lineRows.Close()
			return PurchasingListWorkspaceOutput{}, err
		}
		lineRows.Close()
	}

	billRows, err := tx.Query(ctx, `
		SELECT id::text, vendor_id::text, number, vendor_ref, memo, total_minor, currency, paid_minor, credited_minor, status, created_at
		FROM vendor_bills WHERE org_id=$1::uuid ORDER BY created_at DESC LIMIT 100`, orgID)
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	for billRows.Next() {
		var bill PurchasingWorkspaceBill
		bill.Payments = make([]PurchasingWorkspaceBillPayment, 0)
		var vendorID string
		if err := billRows.Scan(&bill.ID, &vendorID, &bill.Number, &bill.VendorRef, &bill.Memo, &bill.TotalMinor, &bill.Currency, &bill.PaidMinor, &bill.CreditedMinor, &bill.Status, &bill.CreatedAt); err != nil {
			billRows.Close()
			return PurchasingListWorkspaceOutput{}, err
		}
		bill.VendorName = vendorNames[vendorID]
		bill.DueMinor = bill.TotalMinor - bill.PaidMinor - bill.CreditedMinor
		if bill.DueMinor < 0 {
			bill.DueMinor = 0
		}
		output.Bills = append(output.Bills, bill)
	}
	if err := billRows.Err(); err != nil {
		billRows.Close()
		return PurchasingListWorkspaceOutput{}, err
	}
	billRows.Close()
	if len(output.Bills) > 0 {
		billIDs := make([]string, 0, len(output.Bills))
		billIndexes := make(map[string]int, len(output.Bills))
		for i, bill := range output.Bills {
			billIDs = append(billIDs, bill.ID)
			billIndexes[bill.ID] = i
		}
		paymentRows, err := tx.Query(ctx, `
			SELECT vp.id::text, vp.bill_id::text, vp.amount_minor,
			       CASE WHEN vp.status = 'reversed' OR reversal.id IS NOT NULL THEN 'reversed' ELSE vp.status END,
			       vp.payment_run_id::text, COALESCE(vp.reversal_entry_id::text, reversal.id::text)
			FROM vendor_payments vp
			LEFT JOIN LATERAL (
				SELECT id FROM journal_entries
				WHERE org_id = vp.org_id AND reversal_of_id = vp.entry_id
				ORDER BY posted_at DESC, id DESC LIMIT 1
			) reversal ON true
			WHERE vp.org_id=$1::uuid AND vp.bill_id = ANY($2::uuid[])
			ORDER BY vp.paid_at, vp.id`, orgID, billIDs)
		if err != nil {
			return PurchasingListWorkspaceOutput{}, err
		}
		for paymentRows.Next() {
			var payment PurchasingWorkspaceBillPayment
			var billID string
			if err := paymentRows.Scan(&payment.ID, &billID, &payment.AmountMinor, &payment.Status, &payment.PaymentRunID, &payment.ReversalEntryID); err != nil {
				paymentRows.Close()
				return PurchasingListWorkspaceOutput{}, err
			}
			if index, ok := billIndexes[billID]; ok {
				output.Bills[index].Payments = append(output.Bills[index].Payments, payment)
			}
		}
		if err := paymentRows.Err(); err != nil {
			paymentRows.Close()
			return PurchasingListWorkspaceOutput{}, err
		}
		paymentRows.Close()
	}
	output.APAging, err = purchasingAPAging(ctx, tx, orgID, APAgingInput{}, now)
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	output.PriceHistory, err = purchasingPriceHistory(ctx, tx, orgID, PurchasingPriceHistoryInput{})
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	if output.PriceHistory.Rows == nil {
		output.PriceHistory.Rows = make([]PurchasingPriceHistoryRow, 0)
	}
	output.SupplierPerformance, err = purchasingSupplierPerformance(ctx, tx, orgID, PurchasingSupplierPerformanceInput{})
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	workflow, err := listPurchaseWorkflow(ctx, tx, orgID, ListPurchaseWorkflowInput{})
	if err != nil {
		return PurchasingListWorkspaceOutput{}, err
	}
	for _, request := range workflow.Requests {
		workspaceRequest := PurchasingWorkspaceRequest{
			ID: request.ID, Title: request.Title, Justification: request.Justification,
			EstimatedAmountMinor: request.EstimatedAmountMinor, Status: request.Status,
			DecisionReason: request.DecisionReason, CreatedAt: request.CreatedAt,
			RFQs: make([]PurchasingWorkspaceRequestRFQ, 0, len(request.RFQs)),
		}
		for _, rfq := range request.RFQs {
			workspaceRequest.RFQs = append(workspaceRequest.RFQs, PurchasingWorkspaceRequestRFQ{
				ID: rfq.ID, VendorName: rfq.VendorName, Status: rfq.Status,
				QuoteAmountMinor: rfq.QuoteAmountMinor, QuoteLeadTimeDays: rfq.QuoteLeadTimeDays,
				QuoteNotes: rfq.QuoteNotes,
			})
		}
		output.Requests = append(output.Requests, workspaceRequest)
	}

	return output, nil
}
