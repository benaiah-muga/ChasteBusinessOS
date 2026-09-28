package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const returnGoodsCapabilityID = "purchasing.returnGoods"

type ReturnGoodsLineInput struct {
	LineNumber int64  `json:"lineNumber"`
	Quantity   int64  `json:"quantity"`
	Reason     string `json:"reason"`
}

type ReturnGoodsInput struct {
	PONumber      int64                  `json:"poNumber"`
	ReceiptNumber *int64                 `json:"receiptNumber,omitempty"`
	Lines         []ReturnGoodsLineInput `json:"lines"`
}

type ReturnGoodsOutput struct {
	Returned bool  `json:"returned"`
	Lines    int64 `json:"lines"`
}

func ParseReturnGoodsInput(raw json.RawMessage) (ReturnGoodsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReturnGoodsInput{}, err
	}
	var input ReturnGoodsInput
	if input.PONumber, err = requiredSafeInteger(fields, "poNumber"); err != nil || input.PONumber <= 0 || input.PONumber > math.MaxInt32 {
		return ReturnGoodsInput{}, errors.New("poNumber must be a positive integer")
	}
	if rawReceipt, ok := fields["receiptNumber"]; ok {
		_ = rawReceipt
		number, err := requiredSafeInteger(fields, "receiptNumber")
		if err != nil || number <= 0 || number > math.MaxInt32 {
			return ReturnGoodsInput{}, errors.New("receiptNumber must be a positive integer")
		}
		input.ReceiptNumber = &number
	}
	rawLines, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawLines), []byte("null")) {
		return ReturnGoodsInput{}, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(rawLines, &lineValues); err != nil || len(lineValues) == 0 {
		return ReturnGoodsInput{}, errors.New("lines must contain at least one line")
	}
	input.Lines = make([]ReturnGoodsLineInput, 0, len(lineValues))
	for index, rawLine := range lineValues {
		lineFields, err := decodeJSONObject(rawLine)
		if err != nil {
			return ReturnGoodsInput{}, fmt.Errorf("line %d: %w", index+1, err)
		}
		var line ReturnGoodsLineInput
		if line.LineNumber, err = requiredSafeInteger(lineFields, "lineNumber"); err != nil || line.LineNumber <= 0 || line.LineNumber > math.MaxInt32 {
			return ReturnGoodsInput{}, fmt.Errorf("line %d: lineNumber must be a positive integer", index+1)
		}
		if line.Quantity, err = requiredSafeInteger(lineFields, "quantity"); err != nil || line.Quantity <= 0 || line.Quantity > math.MaxInt32 {
			return ReturnGoodsInput{}, fmt.Errorf("line %d: quantity must be a positive integer", index+1)
		}
		if line.Reason, err = requiredString(lineFields, "reason"); err != nil || utf16Length(line.Reason) < 3 || utf16Length(line.Reason) > 500 {
			return ReturnGoodsInput{}, fmt.Errorf("line %d: reason must contain between 3 and 500 characters", index+1)
		}
		input.Lines = append(input.Lines, line)
	}
	return input, nil
}

func returnGoods(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReturnGoodsInput, now time.Time) (ReturnGoodsOutput, error) {
	_ = now
	var poID, status string
	err := tx.QueryRow(ctx, `SELECT id::text, status FROM purchase_orders WHERE org_id=$1::uuid AND number=$2 FOR UPDATE`, claims.OrganizationID, input.PONumber).Scan(&poID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReturnGoodsOutput{}, errors.New("purchase order not found")
	}
	if err != nil {
		return ReturnGoodsOutput{}, err
	}
	if status == "void" {
		return ReturnGoodsOutput{}, errors.New("order is void")
	}

	type poLine struct {
		id       string
		position int64
		itemID   *string
		unitCost int64
	}
	rows, err := tx.Query(ctx, `SELECT id::text, position, item_id::text, unit_price_minor FROM po_lines WHERE po_id=$1::uuid ORDER BY position FOR UPDATE`, poID)
	if err != nil {
		return ReturnGoodsOutput{}, err
	}
	linesByPosition := make(map[int64]poLine)
	for rows.Next() {
		var line poLine
		if err := rows.Scan(&line.id, &line.position, &line.itemID, &line.unitCost); err != nil {
			rows.Close()
			return ReturnGoodsOutput{}, err
		}
		linesByPosition[line.position] = line
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReturnGoodsOutput{}, err
	}
	rows.Close()

	type demand struct {
		line     poLine
		quantity int64
		reason   string
		draws    []receiptReturnDraw
	}
	wanted := make([]*demand, 0, len(input.Lines))
	byPosition := make(map[int64]*demand)
	for _, line := range input.Lines {
		poLine, ok := linesByPosition[line.LineNumber]
		if !ok {
			return ReturnGoodsOutput{}, fmt.Errorf("no line %d on order %d", line.LineNumber, input.PONumber)
		}
		entry := byPosition[line.LineNumber]
		if entry == nil {
			entry = &demand{line: poLine}
			byPosition[line.LineNumber] = entry
			wanted = append(wanted, entry)
		}
		if line.Quantity > math.MaxInt32-entry.quantity {
			return ReturnGoodsOutput{}, fmt.Errorf("line %d: total return quantity exceeds the database range", line.LineNumber)
		}
		entry.quantity += line.Quantity
		if entry.reason == "" {
			entry.reason = line.Reason
		} else {
			entry.reason += "; " + line.Reason
		}
	}

	receiptIDs := make([]string, 0)
	if input.ReceiptNumber != nil {
		var receiptID string
		err = tx.QueryRow(ctx, `SELECT id::text FROM goods_receipts WHERE org_id=$1::uuid AND po_id=$2::uuid AND number=$3 FOR UPDATE`, claims.OrganizationID, poID, *input.ReceiptNumber).Scan(&receiptID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ReturnGoodsOutput{}, fmt.Errorf("receipt %d does not belong to order %d", *input.ReceiptNumber, input.PONumber)
		}
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		receiptIDs = append(receiptIDs, receiptID)
	} else {
		receiptRows, err := tx.Query(ctx, `SELECT id::text FROM goods_receipts WHERE org_id=$1::uuid AND po_id=$2::uuid ORDER BY number FOR UPDATE`, claims.OrganizationID, poID)
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		for receiptRows.Next() {
			var id string
			if err := receiptRows.Scan(&id); err != nil {
				receiptRows.Close()
				return ReturnGoodsOutput{}, err
			}
			receiptIDs = append(receiptIDs, id)
		}
		if err := receiptRows.Err(); err != nil {
			receiptRows.Close()
			return ReturnGoodsOutput{}, err
		}
		receiptRows.Close()
	}

	itemIDs := make([]string, 0, len(wanted))
	for _, entry := range wanted {
		if entry.line.itemID == nil {
			return ReturnGoodsOutput{}, fmt.Errorf("line %d is a service line; nothing to return", entry.line.position)
		}
		accepted, err := purchasingAcceptedForLine(ctx, tx, entry.line.id)
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		returned, err := purchasingReturnedForLine(ctx, tx, entry.line.id)
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		netAvailable := accepted - returned
		if entry.quantity > netAvailable {
			return ReturnGoodsOutput{}, fmt.Errorf("line %d: cannot return %d; only %d thousandths were received and not already returned", entry.line.position, entry.quantity, netAvailable)
		}
		onHand, err := inventoryStockOnHand(ctx, tx, claims.OrganizationID, *entry.line.itemID, nil)
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		if onHand < entry.quantity {
			return ReturnGoodsOutput{}, fmt.Errorf("line %d: only %d thousandths of this item are on hand; goods already shipped need a customer return, not a vendor return", entry.line.position, onHand)
		}

		var receiptLines []struct {
			id       string
			receipt  string
			position int64
			accepted int64
			returned int64
		}
		if len(receiptIDs) > 0 {
			receiptRows, err := tx.Query(ctx, `
				SELECT id::text, receipt_id::text, position, accepted_thousandths, returned_thousandths
				FROM goods_receipt_lines
				WHERE org_id=$1::uuid AND po_line_id=$2::uuid AND receipt_id=ANY($3::uuid[])
				ORDER BY receipt_id, position FOR UPDATE`, claims.OrganizationID, entry.line.id, receiptIDs)
			if err != nil {
				return ReturnGoodsOutput{}, err
			}
			for receiptRows.Next() {
				var row struct {
					id       string
					receipt  string
					position int64
					accepted int64
					returned int64
				}
				if err := receiptRows.Scan(&row.id, &row.receipt, &row.position, &row.accepted, &row.returned); err != nil {
					receiptRows.Close()
					return ReturnGoodsOutput{}, err
				}
				receiptLines = append(receiptLines, row)
			}
			if err := receiptRows.Err(); err != nil {
				receiptRows.Close()
				return ReturnGoodsOutput{}, err
			}
			receiptRows.Close()
		}
		remaining := entry.quantity
		for _, receiptLine := range receiptLines {
			if remaining == 0 {
				break
			}
			available := receiptLine.accepted - receiptLine.returned
			if available <= 0 {
				continue
			}
			take := available
			if take > remaining {
				take = remaining
			}
			entry.draws = append(entry.draws, receiptReturnDraw{id: receiptLine.id, quantity: take})
			remaining -= take
		}
		if remaining > 0 && len(receiptLines) > 0 {
			if input.ReceiptNumber != nil {
				return ReturnGoodsOutput{}, fmt.Errorf("line %d: receipt %d does not carry %d thousandths available to return on this line", entry.line.position, *input.ReceiptNumber, entry.quantity)
			}
			return ReturnGoodsOutput{}, fmt.Errorf("line %d: no receipt carries %d thousandths available to return on this line", entry.line.position, entry.quantity)
		}
		itemIDs = append(itemIDs, *entry.line.itemID)
	}

	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return ReturnGoodsOutput{}, err
	}
	for _, entry := range wanted {
		for _, draw := range entry.draws {
			if _, err := tx.Exec(ctx, `UPDATE goods_receipt_lines SET returned_thousandths=returned_thousandths+$2 WHERE id=$1::uuid`, draw.id, draw.quantity); err != nil {
				return ReturnGoodsOutput{}, err
			}
		}
		legacy := len(entry.draws) == 0
		refType, refID := "po_line", entry.line.id
		if !legacy {
			refType, refID = "goods_receipt_line", entry.draws[0].id
		}
		scope := "receipts"
		if input.ReceiptNumber != nil {
			scope = fmt.Sprintf("receipt %d", *input.ReceiptNumber)
		}
		note := fmt.Sprintf("Return to vendor (PO %d, %s): %s", input.PONumber, scope, entry.reason)
		if legacy {
			note = fmt.Sprintf("Return to vendor (PO %d): %s", input.PONumber, entry.reason)
		}
		onHand, err := inventoryStockOnHand(ctx, tx, claims.OrganizationID, *entry.line.itemID, nil)
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		if onHand < entry.quantity {
			return ReturnGoodsOutput{}, fmt.Errorf("cannot move %d thousandths of stock that is not there: only %d on hand for this item", entry.quantity, onHand)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO stock_movements (org_id,item_id,quantity_delta,reason,note,ref_type,ref_id,unit_cost_minor,location_id,lot_id,actor_type,actor_id)
			VALUES ($1::uuid,$2::uuid,$3,'purchase',$4,$5,$6::uuid,$7,NULL,NULL,$8,$9::uuid)`,
			claims.OrganizationID, *entry.line.itemID, -entry.quantity, note, refType, refID, entry.line.unitCost, claims.ActorType, claims.ActorID); err != nil {
			return ReturnGoodsOutput{}, err
		}
	}
	if status == "received" {
		fullyReceived, err := purchasingOrderFullyReceived(ctx, tx, poID)
		if err != nil {
			return ReturnGoodsOutput{}, err
		}
		if !fullyReceived {
			if _, err := tx.Exec(ctx, `UPDATE purchase_orders SET status='partial' WHERE org_id=$1::uuid AND id=$2::uuid`, claims.OrganizationID, poID); err != nil {
				return ReturnGoodsOutput{}, err
			}
		}
	}
	return ReturnGoodsOutput{Returned: true, Lines: int64(len(input.Lines))}, nil
}

type receiptReturnDraw struct {
	id       string
	quantity int64
}
