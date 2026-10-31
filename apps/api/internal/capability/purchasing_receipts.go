package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const receiveGoodsCapabilityID = "purchasing.receiveGoods"

type ReceiveGoodsLineInput struct {
	LineNumber    int64   `json:"lineNumber"`
	Quantity      int64   `json:"quantity"`
	Rejected      int64   `json:"rejected"`
	RejectionNote *string `json:"rejectionNote,omitempty"`
}

type ReceiveGoodsInput struct {
	PONumber                int64                   `json:"poNumber"`
	Lines                   []ReceiveGoodsLineInput `json:"lines"`
	OverreceiptTolerancePct *int64                  `json:"overreceiptTolerancePct,omitempty"`
	AuthorityReason         *string                 `json:"authorityReason,omitempty"`
	Note                    *string                 `json:"note,omitempty"`
}

type ReceiveGoodsOutput struct {
	Received      bool  `json:"received"`
	FullyReceived bool  `json:"fullyReceived"`
	ReceiptNumber int64 `json:"receiptNumber"`
}

func ParseReceiveGoodsInput(raw json.RawMessage) (ReceiveGoodsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReceiveGoodsInput{}, err
	}
	var input ReceiveGoodsInput
	if input.PONumber, err = requiredSafeInteger(fields, "poNumber"); err != nil || input.PONumber <= 0 || input.PONumber > math.MaxInt32 {
		return ReceiveGoodsInput{}, errors.New("poNumber must be a positive integer")
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return ReceiveGoodsInput{}, errors.New("lines must contain at least one line")
	}
	var rawLines []json.RawMessage
	if err := json.Unmarshal(linesRaw, &rawLines); err != nil || len(rawLines) == 0 {
		return ReceiveGoodsInput{}, errors.New("lines must contain at least one line")
	}
	input.Lines = make([]ReceiveGoodsLineInput, 0, len(rawLines))
	for index, rawLine := range rawLines {
		lineFields, err := decodeJSONObject(rawLine)
		if err != nil {
			return ReceiveGoodsInput{}, fmt.Errorf("line %d: %w", index+1, err)
		}
		var line ReceiveGoodsLineInput
		if line.LineNumber, err = requiredSafeInteger(lineFields, "lineNumber"); err != nil || line.LineNumber <= 0 || line.LineNumber > math.MaxInt32 {
			return ReceiveGoodsInput{}, fmt.Errorf("line %d: lineNumber must be a positive integer", index+1)
		}
		if line.Quantity, err = requiredSafeInteger(lineFields, "quantity"); err != nil || line.Quantity < 0 || line.Quantity > math.MaxInt32 {
			return ReceiveGoodsInput{}, fmt.Errorf("line %d: quantity must be a nonnegative integer", index+1)
		}
		line.Rejected = 0
		if rawRejected, ok := lineFields["rejected"]; ok {
			if bytes.Equal(bytes.TrimSpace(rawRejected), []byte("null")) {
				return ReceiveGoodsInput{}, fmt.Errorf("line %d: rejected must be a nonnegative integer", index+1)
			}
			if err := json.Unmarshal(rawRejected, &line.Rejected); err != nil || line.Rejected < 0 || line.Rejected > math.MaxInt32 {
				return ReceiveGoodsInput{}, fmt.Errorf("line %d: rejected must be a nonnegative integer", index+1)
			}
		}
		if rawNote, ok := lineFields["rejectionNote"]; ok {
			value, err := readOptionalString(rawNote)
			if err != nil || value == nil || utf16Length(*value) > 500 {
				return ReceiveGoodsInput{}, fmt.Errorf("line %d: rejectionNote must be a string of at most 500 characters", index+1)
			}
			line.RejectionNote = value
		}
		input.Lines = append(input.Lines, line)
	}
	if _, ok := fields["overreceiptTolerancePct"]; ok {
		value, err := requiredSafeInteger(fields, "overreceiptTolerancePct")
		if err != nil || value < 0 || value > 10 {
			return ReceiveGoodsInput{}, errors.New("overreceiptTolerancePct must be an integer from 0 to 10")
		}
		input.OverreceiptTolerancePct = &value
	}
	if rawReason, ok := fields["authorityReason"]; ok {
		value, err := readOptionalString(rawReason)
		if err != nil || value == nil || utf16Length(*value) < 10 || utf16Length(*value) > 500 {
			return ReceiveGoodsInput{}, errors.New("authorityReason must be a string between 10 and 500 characters")
		}
		input.AuthorityReason = value
	}
	if rawNote, ok := fields["note"]; ok {
		value, err := readOptionalString(rawNote)
		if err != nil || value == nil || utf16Length(*value) > 500 {
			return ReceiveGoodsInput{}, errors.New("note must be a string of at most 500 characters")
		}
		input.Note = value
	}
	return input, nil
}

func receiveGoods(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReceiveGoodsInput, now time.Time) (ReceiveGoodsOutput, error) {
	if (input.OverreceiptTolerancePct != nil && *input.OverreceiptTolerancePct > 0) != (input.AuthorityReason != nil) {
		return ReceiveGoodsOutput{}, errors.New("overreceiptTolerancePct and authorityReason go together: either omit overreceiptTolerancePct entirely, or send both the tolerance percent and an authorityReason naming who authorized the overdelivery")
	}
	var poID, poStatus string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status FROM purchase_orders
		WHERE org_id=$1::uuid AND number=$2 FOR UPDATE`, claims.OrganizationID, input.PONumber).Scan(&poID, &poStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReceiveGoodsOutput{}, errors.New("purchase order not found")
	}
	if err != nil {
		return ReceiveGoodsOutput{}, err
	}
	if poStatus == "void" || poStatus == "closed" {
		return ReceiveGoodsOutput{}, fmt.Errorf("order is %s", poStatus)
	}

	type poLine struct {
		id              string
		itemID          *string
		quantity        int64
		unitCost        int64
		serviceAccepted int64
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, position, item_id::text, quantity, unit_price_minor,
		       COALESCE(service_accepted_thousandths, 0)
		FROM po_lines WHERE po_id=$1::uuid ORDER BY position FOR UPDATE`, poID)
	if err != nil {
		return ReceiveGoodsOutput{}, err
	}
	linesByPosition := make(map[int64]poLine)
	for rows.Next() {
		var line poLine
		var position int64
		if err := rows.Scan(&line.id, &position, &line.itemID, &line.quantity, &line.unitCost, &line.serviceAccepted); err != nil {
			rows.Close()
			return ReceiveGoodsOutput{}, err
		}
		linesByPosition[position] = line
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReceiveGoodsOutput{}, err
	}
	rows.Close()

	type demand struct {
		position int64
		accepted int64
		rejected int64
		notes    []string
	}
	wanted := make([]*demand, 0, len(input.Lines))
	wantedByPosition := make(map[int64]*demand)
	for _, line := range input.Lines {
		if _, ok := linesByPosition[line.LineNumber]; !ok {
			return ReceiveGoodsOutput{}, fmt.Errorf("no line %d on order %d", line.LineNumber, input.PONumber)
		}
		if line.Rejected > 0 && (line.RejectionNote == nil || *line.RejectionNote == "") {
			return ReceiveGoodsOutput{}, fmt.Errorf("line %d: rejected goods need a rejectionNote saying why", line.LineNumber)
		}
		entry := wantedByPosition[line.LineNumber]
		if entry == nil {
			entry = &demand{position: line.LineNumber}
			wantedByPosition[line.LineNumber] = entry
			wanted = append(wanted, entry)
		}
		if line.Quantity > math.MaxInt32-entry.accepted || line.Rejected > math.MaxInt32-entry.rejected {
			return ReceiveGoodsOutput{}, fmt.Errorf("line %d: total receipt quantity exceeds the database range", line.LineNumber)
		}
		entry.accepted += line.Quantity
		entry.rejected += line.Rejected
		if line.RejectionNote != nil && *line.RejectionNote != "" {
			entry.notes = append(entry.notes, *line.RejectionNote)
		}
	}

	for _, entry := range wanted {
		if entry.accepted == 0 && entry.rejected == 0 {
			return ReceiveGoodsOutput{}, fmt.Errorf("line %d: a receipt line must accept or reject something", entry.position)
		}
		line := linesByPosition[entry.position]
		if line.itemID != nil {
			priorAccepted, err := purchasingAcceptedForLine(ctx, tx, line.id)
			if err != nil {
				return ReceiveGoodsOutput{}, err
			}
			priorRejected, err := purchasingReceiptRejectedForLine(ctx, tx, line.id)
			if err != nil {
				return ReceiveGoodsOutput{}, err
			}
			tolerancePct := int64(0)
			if input.OverreceiptTolerancePct != nil {
				tolerancePct = *input.OverreceiptTolerancePct
			}
			tolerance := (line.quantity * tolerancePct) / 100
			if priorAccepted+entry.accepted > line.quantity+tolerance {
				return ReceiveGoodsOutput{}, fmt.Errorf("line %d: receiving %d would exceed the ordered quantity (ordered %d, already accepted %d); overreceipt needs explicit authority (overreceiptTolerancePct + authorityReason) or an amended order", entry.position, entry.accepted, line.quantity, priorAccepted)
			}
			if priorAccepted+priorRejected+entry.accepted+entry.rejected > line.quantity+tolerance {
				return ReceiveGoodsOutput{}, fmt.Errorf("line %d: delivered %d exceeds what was ordered (ordered %d, already delivered %d)", entry.position, entry.accepted+entry.rejected, line.quantity, priorAccepted+priorRejected)
			}
		} else {
			if line.serviceAccepted+entry.accepted > line.quantity {
				return ReceiveGoodsOutput{}, fmt.Errorf("line %d: accepting %d would exceed the ordered quantity (ordered %d, already accepted %d)", entry.position, entry.accepted, line.quantity, line.serviceAccepted)
			}
		}
	}

	receiptNumber, err := nextGoodsReceiptNumber(ctx, tx, claims.OrganizationID)
	if err != nil {
		return ReceiveGoodsOutput{}, err
	}
	if receiptNumber <= 0 || receiptNumber > math.MaxInt32 {
		return ReceiveGoodsOutput{}, errors.New("goods receipt number exceeds the database integer range")
	}
	note := input.Note
	if note == nil && input.AuthorityReason != nil {
		value := "Overreceipt authorized: " + *input.AuthorityReason
		note = &value
	}
	var receiptID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO goods_receipts (org_id, po_id, number, received_at, received_by_actor_type, received_by_actor_id, note)
		VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7)
		RETURNING id::text`, claims.OrganizationID, poID, receiptNumber, now, claims.ActorType, claims.ActorID, note).Scan(&receiptID); err != nil {
		return ReceiveGoodsOutput{}, err
	}
	itemIDs := make([]string, 0, len(wanted))
	for _, entry := range wanted {
		line := linesByPosition[entry.position]
		if line.itemID != nil && entry.accepted > 0 {
			itemIDs = append(itemIDs, *line.itemID)
		}
	}
	if len(itemIDs) > 0 {
		if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
			return ReceiveGoodsOutput{}, err
		}
	}
	for index, entry := range wanted {
		line := linesByPosition[entry.position]
		var rejectionNote *string
		if len(entry.notes) > 0 {
			value := strings.Join(entry.notes, "; ")
			rejectionNote = &value
		}
		var receiptLineID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, rejection_note)
			VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) RETURNING id::text`,
			claims.OrganizationID, receiptID, line.id, index+1, entry.accepted, entry.rejected, rejectionNote).Scan(&receiptLineID); err != nil {
			return ReceiveGoodsOutput{}, err
		}
		if line.itemID == nil {
			if _, err := tx.Exec(ctx, `UPDATE po_lines SET service_accepted_thousandths=$1 WHERE id=$2::uuid`, line.serviceAccepted+entry.accepted, line.id); err != nil {
				return ReceiveGoodsOutput{}, err
			}
		}
		if line.itemID != nil && entry.accepted > 0 {
			movementNote := fmt.Sprintf("Receipt %d against PO %d", receiptNumber, input.PONumber)
			if _, err := tx.Exec(ctx, `
				INSERT INTO stock_movements (org_id,item_id,quantity_delta,reason,note,ref_type,ref_id,unit_cost_minor,location_id,lot_id,actor_type,actor_id)
				VALUES ($1::uuid,$2::uuid,$3,'purchase',$4,'goods_receipt_line',$5::uuid,$6,NULL,NULL,$7,$8::uuid)`,
				claims.OrganizationID, *line.itemID, entry.accepted, movementNote, receiptLineID, line.unitCost, claims.ActorType, claims.ActorID); err != nil {
				return ReceiveGoodsOutput{}, err
			}
		}
	}

	fullyReceived, err := purchasingOrderFullyReceived(ctx, tx, poID)
	if err != nil {
		return ReceiveGoodsOutput{}, err
	}
	status := "partial"
	if fullyReceived {
		status = "received"
	}
	if _, err := tx.Exec(ctx, `UPDATE purchase_orders SET status=$1 WHERE id=$2::uuid`, status, poID); err != nil {
		return ReceiveGoodsOutput{}, err
	}
	return ReceiveGoodsOutput{Received: true, FullyReceived: fullyReceived, ReceiptNumber: receiptNumber}, nil
}

func purchasingReceiptRejectedForLine(ctx context.Context, tx pgx.Tx, poLineID string) (int64, error) {
	var rejected int64
	err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(rejected_thousandths), 0) FROM goods_receipt_lines WHERE po_line_id=$1::uuid`, poLineID).Scan(&rejected)
	return rejected, err
}

func purchasingOrderFullyReceived(ctx context.Context, tx pgx.Tx, poID string) (bool, error) {
	rows, err := tx.Query(ctx, `SELECT id::text, item_id::text, quantity, COALESCE(service_accepted_thousandths,0) FROM po_lines WHERE po_id=$1::uuid ORDER BY position`, poID)
	if err != nil {
		return false, err
	}
	type lineState struct {
		id                        string
		itemID                    *string
		quantity, serviceAccepted int64
	}
	lines := make([]lineState, 0)
	for rows.Next() {
		var line lineState
		if err := rows.Scan(&line.id, &line.itemID, &line.quantity, &line.serviceAccepted); err != nil {
			rows.Close()
			return false, err
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()
	for _, line := range lines {
		if line.itemID == nil {
			if line.serviceAccepted < line.quantity {
				return false, nil
			}
			continue
		}
		accepted, err := purchasingAcceptedForLine(ctx, tx, line.id)
		if err != nil {
			return false, err
		}
		returned, err := purchasingReturnedForLine(ctx, tx, line.id)
		if err != nil {
			return false, err
		}
		rejected, err := purchasingReceiptRejectedForLine(ctx, tx, line.id)
		if err != nil {
			return false, err
		}
		if accepted-returned+rejected < line.quantity {
			return false, nil
		}
	}
	return true, nil
}

func nextGoodsReceiptNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'goods_receipt', COALESCE(MAX(number),0)+1
		FROM goods_receipts WHERE org_id=$1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next"=doc_counters."next"+1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate goods receipt number: %w", err)
	}
	return number, nil
}
