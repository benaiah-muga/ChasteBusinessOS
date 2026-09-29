package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	billCreditNoteCapabilityID     = "purchasing.billCreditNote"
	closePurchaseOrderCapabilityID = "purchasing.closePurchaseOrder"
	listReceiptsCapabilityID       = "purchasing.listReceipts"
)

const vendorCreditNoteSourceType = "vendor_credit_note"

type BillCreditNoteInput struct {
	BillID      string `json:"billId"`
	AmountMinor int64  `json:"amountMinor"`
	Reason      string `json:"reason"`
}

type BillCreditNoteOutput struct {
	EntryID          string `json:"entryId"`
	CreditedMinor    int64  `json:"creditedMinor"`
	BillBalanceMinor int64  `json:"billBalanceMinor"`
}

type ClosePurchaseOrderInput struct {
	PONumber int64 `json:"poNumber"`
}

type ClosePurchaseOrderOutput struct {
	Closed           bool  `json:"closed"`
	Backordered      bool  `json:"backordered"`
	ShortThousandths int64 `json:"shortThousandths"`
}

type ListReceiptsInput struct {
	PONumber int64 `json:"poNumber"`
}

type LifecycleReceiptLine struct {
	Position            int64   `json:"position"`
	Description         string  `json:"description"`
	AcceptedThousandths int64   `json:"acceptedThousandths"`
	RejectedThousandths int64   `json:"rejectedThousandths"`
	ReturnedThousandths int64   `json:"returnedThousandths"`
	RejectionNote       *string `json:"rejectionNote"`
}

type LifecycleReceipt struct {
	Number     int64                  `json:"number"`
	ReceivedAt string                 `json:"receivedAt"`
	Note       *string                `json:"note"`
	Lines      []LifecycleReceiptLine `json:"lines"`
}

type LifecycleOrderLine struct {
	Position             int64  `json:"position"`
	Description          string `json:"description"`
	OrderedThousandths   int64  `json:"orderedThousandths"`
	AcceptedThousandths  int64  `json:"acceptedThousandths"`
	RejectedThousandths  int64  `json:"rejectedThousandths"`
	ReturnedThousandths  int64  `json:"returnedThousandths"`
	RemainingThousandths int64  `json:"remainingThousandths"`
}

type ListReceiptsOutput struct {
	Receipts   []LifecycleReceipt   `json:"receipts"`
	OrderLines []LifecycleOrderLine `json:"orderLines"`
}

func ParseBillCreditNoteInput(raw json.RawMessage) (BillCreditNoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return BillCreditNoteInput{}, err
	}
	var input BillCreditNoteInput
	if input.BillID, err = requiredCRMDealString(fields, "billId", 0, 0); err != nil {
		return BillCreditNoteInput{}, err
	}
	if !isZodUUID(input.BillID) {
		return BillCreditNoteInput{}, errors.New("billId must be a UUID")
	}
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return BillCreditNoteInput{}, errors.New("amountMinor must be a positive integer")
	}
	if input.Reason, err = requiredCRMDealString(fields, "reason", 3, 500); err != nil {
		return BillCreditNoteInput{}, err
	}
	return input, nil
}

func parseLifecyclePONumber(fields map[string]json.RawMessage) (int64, error) {
	number, err := requiredSafeInteger(fields, "poNumber")
	if err != nil || number <= 0 || number > math.MaxInt32 {
		return 0, errors.New("poNumber must be a positive integer")
	}
	return number, nil
}

func ParseClosePurchaseOrderInput(raw json.RawMessage) (ClosePurchaseOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ClosePurchaseOrderInput{}, err
	}
	number, err := parseLifecyclePONumber(fields)
	if err != nil {
		return ClosePurchaseOrderInput{}, err
	}
	return ClosePurchaseOrderInput{PONumber: number}, nil
}

func ParseListReceiptsInput(raw json.RawMessage) (ListReceiptsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListReceiptsInput{}, err
	}
	number, err := parseLifecyclePONumber(fields)
	if err != nil {
		return ListReceiptsInput{}, err
	}
	return ListReceiptsInput{PONumber: number}, nil
}

// billCreditNoteTaxShare mirrors the TypeScript BigInt split: the recoverable
// input tax leg takes amount * recoverableTax / total rounded half up, so the
// arithmetic cannot overflow int64 the way the direct product can.
func billCreditNoteTaxShare(amountMinor, recoverableTaxMinor, totalMinor int64) int64 {
	if totalMinor == 0 {
		return 0
	}
	numerator := new(big.Int).Mul(big.NewInt(amountMinor), big.NewInt(recoverableTaxMinor))
	numerator.Mul(numerator, big.NewInt(2))
	numerator.Add(numerator, big.NewInt(totalMinor))
	denominator := new(big.Int).Mul(big.NewInt(totalMinor), big.NewInt(2))
	return new(big.Int).Quo(numerator, denominator).Int64()
}

// Posting rule for supplier credits (ADR 0037): DR Accounts Payable, CR the
// expense split net of recoverable input tax, CR the input tax asset. The
// bill document is never edited; the credit is a new entry linked back to the
// bill's posting entry.
func purchasingBillCreditNote(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input BillCreditNoteInput, now time.Time) (BillCreditNoteOutput, error) {
	orgID := claims.OrganizationID
	var billID, status string
	var number, totalMinor, paidMinor, creditedMinor int64
	var billEntryID *string
	// N11: serialize money application per document, so two concurrent
	// credits cannot both pass the open-balance gate on a stale snapshot.
	err := tx.QueryRow(ctx, `
		SELECT id::text, number, status, total_minor, paid_minor, credited_minor, entry_id::text
		FROM vendor_bills
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1
		FOR UPDATE`, orgID, input.BillID).
		Scan(&billID, &number, &status, &totalMinor, &paidMinor, &creditedMinor, &billEntryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return BillCreditNoteOutput{}, errors.New("bill not found")
	}
	if err != nil {
		return BillCreditNoteOutput{}, err
	}
	if status == "void" {
		return BillCreditNoteOutput{}, errors.New("bill is void; nothing to credit")
	}
	if _, err := purchasingBalance(totalMinor, paidMinor, creditedMinor); err != nil {
		return BillCreditNoteOutput{}, err
	}
	openBalance := totalMinor - paidMinor - creditedMinor
	if input.AmountMinor > openBalance {
		return BillCreditNoteOutput{}, fmt.Errorf("credit %d exceeds the open balance %d (total %d - paid %d - credited %d)",
			input.AmountMinor, openBalance, totalMinor, paidMinor, creditedMinor)
	}
	var recoverableTax int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(vbl.tax_minor), 0)
		FROM vendor_bill_lines vbl
		JOIN tax_codes tc ON tc.id = vbl.tax_code_id
		WHERE vbl.bill_id = $1::uuid AND tc.direction = 'input' AND tc.recoverable = true`, billID).Scan(&recoverableTax); err != nil {
		return BillCreditNoteOutput{}, err
	}
	taxCreditMinor := billCreditNoteTaxShare(input.AmountMinor, recoverableTax, totalMinor)
	expenseCreditMinor := input.AmountMinor - taxCreditMinor
	var baseCurrency string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&baseCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			baseCurrency = "USD"
		} else {
			return BillCreditNoteOutput{}, err
		}
	}
	lines := make([]JournalEntryLineInput, 0, 3)
	lines = append(lines, JournalEntryLineInput{AccountCode: accountsPayableAccountCode, DebitMinor: input.AmountMinor})
	// The TypeScript leg keeps a zero expense credit when tax absorbs the
	// whole amount; the shared posting door refuses zero lines, so it is
	// omitted there and the split stays balanced either way.
	if expenseCreditMinor > 0 {
		lines = append(lines, JournalEntryLineInput{AccountCode: "6000", CreditMinor: expenseCreditMinor})
	}
	if taxCreditMinor > 0 {
		lines = append(lines, JournalEntryLineInput{AccountCode: inputTaxAssetAccountCode, CreditMinor: taxCreditMinor})
	}
	var reversalOfID *string
	if billEntryID != nil && *billEntryID != "" {
		var alreadyReversed bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid)`,
			orgID, *billEntryID).Scan(&alreadyReversed); err != nil {
			return BillCreditNoteOutput{}, err
		}
		// The ledger door allows one reversal per entry; later partial
		// credits stay linked through source_id instead of the reversal link.
		if !alreadyReversed {
			link := *billEntryID
			reversalOfID = &link
		}
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      orgID,
		Memo:       fmt.Sprintf("Supplier credit on bill %d: %s", number, input.Reason),
		SourceType: vendorCreditNoteSourceType, SourceID: &billID, ReversalOfID: reversalOfID,
		Currency: baseCurrency, PostedAt: now,
		ActorType: claims.ActorType, ActorID: claims.ActorID, Lines: lines,
	})
	if err != nil {
		return BillCreditNoteOutput{}, err
	}
	credited := creditedMinor + input.AmountMinor
	if _, err := tx.Exec(ctx, `UPDATE vendor_bills SET credited_minor = $2 WHERE id = $1::uuid`, billID, credited); err != nil {
		return BillCreditNoteOutput{}, err
	}
	return BillCreditNoteOutput{
		EntryID:          entryID,
		CreditedMinor:    credited,
		BillBalanceMinor: totalMinor - paidMinor - credited,
	}, nil
}

// N16 close basis: the shortfall still owed is ordered minus what remains
// accepted net of returns plus recorded rejections; rejections were
// delivered (refused, not owed), returns are owed again. Service lines
// deliver through their accepted milestones.
func closePurchaseOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ClosePurchaseOrderInput) (ClosePurchaseOrderOutput, error) {
	var poID, status string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status
		FROM purchase_orders
		WHERE org_id = $1::uuid AND number = $2
		LIMIT 1
		FOR UPDATE`, claims.OrganizationID, input.PONumber).Scan(&poID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ClosePurchaseOrderOutput{}, errors.New("purchase order not found")
	}
	if err != nil {
		return ClosePurchaseOrderOutput{}, err
	}
	if status == "void" {
		return ClosePurchaseOrderOutput{}, errors.New("order is void")
	}
	if status == "closed" {
		return ClosePurchaseOrderOutput{}, errors.New("order is already closed")
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, item_id::text, quantity, COALESCE(service_accepted_thousandths, 0)
		FROM po_lines
		WHERE po_id = $1::uuid
		ORDER BY position`, poID)
	if err != nil {
		return ClosePurchaseOrderOutput{}, err
	}
	type poLineState struct {
		id              string
		itemID          *string
		quantity        int64
		serviceAccepted int64
	}
	lines := make([]poLineState, 0, 8)
	for rows.Next() {
		var line poLineState
		if err := rows.Scan(&line.id, &line.itemID, &line.quantity, &line.serviceAccepted); err != nil {
			rows.Close()
			return ClosePurchaseOrderOutput{}, err
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ClosePurchaseOrderOutput{}, err
	}
	rows.Close()
	var short int64
	for _, line := range lines {
		delivered := line.serviceAccepted
		if line.itemID != nil {
			accepted, err := purchasingAcceptedForLine(ctx, tx, line.id)
			if err != nil {
				return ClosePurchaseOrderOutput{}, err
			}
			returned, err := purchasingReturnedForLine(ctx, tx, line.id)
			if err != nil {
				return ClosePurchaseOrderOutput{}, err
			}
			rejected, err := purchasingReceiptRejectedForLine(ctx, tx, line.id)
			if err != nil {
				return ClosePurchaseOrderOutput{}, err
			}
			delivered = accepted - returned + rejected
		}
		if line.quantity > delivered {
			short += line.quantity - delivered
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE purchase_orders
		SET status = 'closed', backordered = $2
		WHERE id = $1::uuid`, poID, short > 0); err != nil {
		return ClosePurchaseOrderOutput{}, err
	}
	return ClosePurchaseOrderOutput{Closed: true, Backordered: short > 0, ShortThousandths: short}, nil
}

func listReceipts(ctx context.Context, tx pgx.Tx, orgID string, input ListReceiptsInput) (ListReceiptsOutput, error) {
	var poID string
	err := tx.QueryRow(ctx, `
		SELECT id::text
		FROM purchase_orders
		WHERE org_id = $1::uuid AND number = $2
		LIMIT 1`, orgID, input.PONumber).Scan(&poID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ListReceiptsOutput{}, errors.New("purchase order not found")
	}
	if err != nil {
		return ListReceiptsOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, position, description, quantity
		FROM po_lines
		WHERE po_id = $1::uuid
		ORDER BY position`, poID)
	if err != nil {
		return ListReceiptsOutput{}, err
	}
	type poLineRow struct {
		id          string
		position    int64
		description string
		quantity    int64
	}
	lines := make([]poLineRow, 0, 8)
	descriptions := make(map[string]string, 8)
	for rows.Next() {
		var line poLineRow
		if err := rows.Scan(&line.id, &line.position, &line.description, &line.quantity); err != nil {
			rows.Close()
			return ListReceiptsOutput{}, err
		}
		descriptions[line.id] = line.description
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ListReceiptsOutput{}, err
	}
	rows.Close()

	receiptRows, err := tx.Query(ctx, `
		SELECT id::text, number, received_at, note
		FROM goods_receipts
		WHERE org_id = $1::uuid AND po_id = $2::uuid
		ORDER BY number`, orgID, poID)
	if err != nil {
		return ListReceiptsOutput{}, err
	}
	type receiptRow struct {
		id         string
		number     int64
		receivedAt time.Time
		note       *string
	}
	receipts := make([]receiptRow, 0, 4)
	for receiptRows.Next() {
		var receipt receiptRow
		if err := receiptRows.Scan(&receipt.id, &receipt.number, &receipt.receivedAt, &receipt.note); err != nil {
			receiptRows.Close()
			return ListReceiptsOutput{}, err
		}
		receipts = append(receipts, receipt)
	}
	if err := receiptRows.Err(); err != nil {
		receiptRows.Close()
		return ListReceiptsOutput{}, err
	}
	receiptRows.Close()

	receiptIDs := make([]string, 0, len(receipts))
	for _, receipt := range receipts {
		receiptIDs = append(receiptIDs, receipt.id)
	}
	type receiptLineRow struct {
		receiptID string
		position  int64
		poLineID  string
		accepted  int64
		rejected  int64
		returned  int64
		note      *string
	}
	receiptLines := make([]receiptLineRow, 0, 8)
	if len(receiptIDs) > 0 {
		lineRows, err := tx.Query(ctx, `
			SELECT receipt_id::text, position, po_line_id::text, accepted_thousandths, rejected_thousandths, returned_thousandths, rejection_note
			FROM goods_receipt_lines
			WHERE org_id = $1::uuid AND receipt_id = ANY($2::uuid[])
			ORDER BY receipt_id, position`, orgID, receiptIDs)
		if err != nil {
			return ListReceiptsOutput{}, err
		}
		for lineRows.Next() {
			var line receiptLineRow
			if err := lineRows.Scan(&line.receiptID, &line.position, &line.poLineID, &line.accepted, &line.rejected, &line.returned, &line.note); err != nil {
				lineRows.Close()
				return ListReceiptsOutput{}, err
			}
			receiptLines = append(receiptLines, line)
		}
		if err := lineRows.Err(); err != nil {
			lineRows.Close()
			return ListReceiptsOutput{}, err
		}
		lineRows.Close()
	}

	out := ListReceiptsOutput{
		Receipts:   make([]LifecycleReceipt, 0, len(receipts)),
		OrderLines: make([]LifecycleOrderLine, 0, len(lines)),
	}
	for _, receipt := range receipts {
		item := LifecycleReceipt{
			Number:     receipt.number,
			ReceivedAt: paymentRunsTimestamp(receipt.receivedAt),
			Note:       receipt.note,
			Lines:      make([]LifecycleReceiptLine, 0, 4),
		}
		for _, line := range receiptLines {
			if line.receiptID != receipt.id {
				continue
			}
			item.Lines = append(item.Lines, LifecycleReceiptLine{
				Position:            line.position,
				Description:         descriptions[line.poLineID],
				AcceptedThousandths: line.accepted,
				RejectedThousandths: line.rejected,
				ReturnedThousandths: line.returned,
				RejectionNote:       line.note,
			})
		}
		out.Receipts = append(out.Receipts, item)
	}
	for _, line := range lines {
		accepted, err := purchasingAcceptedForLine(ctx, tx, line.id)
		if err != nil {
			return ListReceiptsOutput{}, err
		}
		rejected, err := purchasingReceiptRejectedForLine(ctx, tx, line.id)
		if err != nil {
			return ListReceiptsOutput{}, err
		}
		returned, err := purchasingReturnedForLine(ctx, tx, line.id)
		if err != nil {
			return ListReceiptsOutput{}, err
		}
		remaining := line.quantity - accepted - rejected
		if remaining < 0 {
			remaining = 0
		}
		out.OrderLines = append(out.OrderLines, LifecycleOrderLine{
			Position:             line.position,
			Description:          line.description,
			OrderedThousandths:   line.quantity,
			AcceptedThousandths:  accepted,
			RejectedThousandths:  rejected,
			ReturnedThousandths:  returned,
			RemainingThousandths: remaining,
		})
	}
	return out, nil
}

func parsePurchasingLifecycleInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case billCreditNoteCapabilityID:
		return ParseBillCreditNoteInput(raw)
	case closePurchaseOrderCapabilityID:
		return ParseClosePurchaseOrderInput(raw)
	case listReceiptsCapabilityID:
		return ParseListReceiptsInput(raw)
	default:
		return nil, errors.New("unsupported purchasing lifecycle capability")
	}
}
