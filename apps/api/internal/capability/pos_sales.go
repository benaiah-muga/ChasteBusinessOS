package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	posOpenSessionCapabilityID  = "pos.openSession"
	posCompleteSaleCapabilityID = "pos.completeSale"
	posCloseSessionCapabilityID = "pos.closeSession"
	posReturnSaleCapabilityID   = "pos.returnSale"
	posShiftSummaryCapabilityID = "pos.shiftSummary"
)

const posWalkInCustomerName = "Walk-in Customer"

type PosSaleLineInput struct {
	Description    string  `json:"description"`
	Quantity       int64   `json:"quantity"`
	UnitPriceMinor int64   `json:"unitPriceMinor"`
	TaxMinor       int64   `json:"taxMinor"`
	SKU            *string `json:"sku,omitempty"`
}

type PosTenderInput struct {
	Method      string `json:"method"`
	AmountMinor int64  `json:"amountMinor"`
}

type PosOpenSessionInput struct {
	Register          string `json:"register"`
	OpeningFloatMinor int64  `json:"openingFloatMinor"`
}

type PosOpenSessionOutput struct {
	SessionID string `json:"sessionId"`
}

type PosCompleteSaleInput struct {
	SessionID         string             `json:"sessionId"`
	Lines             []PosSaleLineInput `json:"lines"`
	Method            string             `json:"method"`
	CustomerID        *string            `json:"customerId,omitempty"`
	CashReceivedMinor *int64             `json:"cashReceivedMinor,omitempty"`
	Tenders           []PosTenderInput   `json:"tenders,omitempty"`
}

type PosSaleTenderOutput struct {
	Method      string `json:"method"`
	AmountMinor int64  `json:"amountMinor"`
}

type PosCompleteSaleOutput struct {
	InvoiceID        string                `json:"invoiceId"`
	InvoiceNumber    int64                 `json:"invoiceNumber"`
	TotalMinor       int64                 `json:"totalMinor"`
	TenderedMinor    int64                 `json:"tenderedMinor"`
	ChangeGivenMinor int64                 `json:"changeGivenMinor"`
	Tenders          []PosSaleTenderOutput `json:"tenders"`
}

type PosCloseSessionInput struct {
	SessionID        string  `json:"sessionId"`
	CountedCashMinor int64   `json:"countedCashMinor"`
	VarianceReason   *string `json:"varianceReason,omitempty"`
}

type PosCloseSessionOutput struct {
	ExpectedCashMinor int64 `json:"expectedCashMinor"`
	VarianceMinor     int64 `json:"varianceMinor"`
	Flagged           bool  `json:"flagged"`
}

type PosReturnLineInput struct {
	InvoiceLineID string `json:"invoiceLineId"`
	Quantity      int64  `json:"quantity"`
}

type PosReturnSaleInput struct {
	InvoiceID    string               `json:"invoiceId"`
	Reason       string               `json:"reason"`
	RefundMethod string               `json:"refundMethod"`
	Lines        []PosReturnLineInput `json:"lines,omitempty"`
}

type PosReturnSaleOutput struct {
	RefundEntryID  string `json:"refundEntryId"`
	RefundMinor    int64  `json:"refundMinor"`
	CreditedMinor  int64  `json:"creditedMinor"`
	RestockedLines int64  `json:"restockedLines"`
	RefundMethod   string `json:"refundMethod"`
}

type PosShiftSummaryInput struct {
	SessionID string `json:"sessionId"`
}

type PosMethodTotal struct {
	Method      string `json:"method"`
	AmountMinor int64  `json:"amountMinor"`
}

type PosShiftSummaryOutput struct {
	Register          string           `json:"register"`
	Status            string           `json:"status"`
	SalesCount        int64            `json:"salesCount"`
	TakingsMinor      int64            `json:"takingsMinor"`
	TenderTotals      []PosMethodTotal `json:"tenderTotals"`
	RefundTotals      []PosMethodTotal `json:"refundTotals"`
	ExpectedCashMinor int64            `json:"expectedCashMinor"`
	CountedCashMinor  *int64           `json:"countedCashMinor"`
	VarianceMinor     *int64           `json:"varianceMinor"`
}

func parsePosSaleInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case posOpenSessionCapabilityID:
		return ParsePosOpenSessionInput(raw)
	case posCompleteSaleCapabilityID:
		return ParsePosCompleteSaleInput(raw)
	case posCloseSessionCapabilityID:
		return ParsePosCloseSessionInput(raw)
	case posReturnSaleCapabilityID:
		return ParsePosReturnSaleInput(raw)
	case posShiftSummaryCapabilityID:
		return ParsePosShiftSummaryInput(raw)
	default:
		return nil, errors.New("unsupported POS capability")
	}
}

func posRequiredUUID(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := requiredCRMDealString(fields, key, 0, 0)
	if err != nil {
		return "", err
	}
	if !isZodUUID(value) {
		return "", fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func ParsePosOpenSessionInput(raw json.RawMessage) (PosOpenSessionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PosOpenSessionInput{}, err
	}
	input := PosOpenSessionInput{Register: "main"}
	if rawRegister, ok := fields["register"]; ok {
		value, readErr := readOptionalString(rawRegister)
		if readErr != nil {
			return PosOpenSessionInput{}, errors.New("register must be a string")
		}
		input.Register = *value
	}
	openingFloatMinor, err := optionalSafeInteger(fields, "openingFloatMinor")
	if err != nil || openingFloatMinor != nil && *openingFloatMinor < 0 {
		return PosOpenSessionInput{}, errors.New("openingFloatMinor must be a non-negative integer")
	}
	if openingFloatMinor != nil {
		input.OpeningFloatMinor = *openingFloatMinor
	}
	return input, nil
}

func parsePosSaleLines(lineValues []json.RawMessage) ([]PosSaleLineInput, error) {
	lines := make([]PosSaleLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, errors.New("each sale line must be an object")
		}
		description, err := requiredCRMDealString(lineFields, "description", 1, 0)
		if err != nil {
			return nil, err
		}
		quantity, err := requiredSafeInteger(lineFields, "quantity")
		if err != nil || quantity <= 0 {
			return nil, errors.New("quantity must be a positive integer")
		}
		unitPriceMinor, err := requiredSafeInteger(lineFields, "unitPriceMinor")
		if err != nil || unitPriceMinor < 0 {
			return nil, errors.New("unitPriceMinor must be a non-negative integer")
		}
		taxMinor, err := optionalSafeInteger(lineFields, "taxMinor")
		if err != nil || taxMinor != nil && *taxMinor < 0 {
			return nil, errors.New("taxMinor must be a non-negative integer")
		}
		sku, err := optionalCRMDealString(lineFields, "sku", 0, false)
		if err != nil {
			return nil, err
		}
		tax := int64(0)
		if taxMinor != nil {
			tax = *taxMinor
		}
		lines = append(lines, PosSaleLineInput{
			Description: description, Quantity: quantity, UnitPriceMinor: unitPriceMinor,
			TaxMinor: tax, SKU: sku,
		})
	}
	return lines, nil
}

func parsePosTenders(rawTenders json.RawMessage) ([]PosTenderInput, error) {
	var lineValues []json.RawMessage
	if err := json.Unmarshal(rawTenders, &lineValues); err != nil {
		return nil, errors.New("tenders must be an array")
	}
	if len(lineValues) < 1 {
		return nil, errors.New("tenders must contain at least 1 item")
	}
	if len(lineValues) > 3 {
		return nil, errors.New("tenders must contain at most 3 items")
	}
	tenders := make([]PosTenderInput, 0, len(lineValues))
	for _, tenderRaw := range lineValues {
		tenderFields, err := decodeJSONObject(tenderRaw)
		if err != nil {
			return nil, errors.New("each tender must be an object")
		}
		method, err := requiredCRMDealString(tenderFields, "method", 0, 0)
		if err != nil {
			return nil, errors.New("tender method is invalid")
		}
		switch method {
		case "cash", "card", "mobile_money":
		default:
			return nil, errors.New("tender method is invalid")
		}
		amountMinor, err := requiredSafeInteger(tenderFields, "amountMinor")
		if err != nil || amountMinor <= 0 {
			return nil, errors.New("tender amountMinor must be a positive integer")
		}
		tenders = append(tenders, PosTenderInput{Method: method, AmountMinor: amountMinor})
	}
	return tenders, nil
}

func posSaleTotalMinor(lines []PosSaleLineInput) *big.Int {
	total := new(big.Int)
	for _, line := range lines {
		numerator := new(big.Int).Mul(big.NewInt(line.Quantity), big.NewInt(line.UnitPriceMinor))
		numerator.Add(numerator, big.NewInt(500))
		total.Add(total, numerator.Quo(numerator, big.NewInt(1000)))
		total.Add(total, big.NewInt(line.TaxMinor))
	}
	return total
}

func ParsePosCompleteSaleInput(raw json.RawMessage) (PosCompleteSaleInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PosCompleteSaleInput{}, err
	}
	input := PosCompleteSaleInput{Method: "cash"}
	if input.SessionID, err = requiredCRMDealString(fields, "sessionId", 0, 0); err != nil {
		return PosCompleteSaleInput{}, err
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return PosCompleteSaleInput{}, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return PosCompleteSaleInput{}, errors.New("lines must contain at least one line")
	}
	if input.Lines, err = parsePosSaleLines(lineValues); err != nil {
		return PosCompleteSaleInput{}, err
	}
	if rawMethod, ok := fields["method"]; ok {
		method, readErr := readOptionalString(rawMethod)
		if readErr != nil || method == nil || *method != "cash" && *method != "card" {
			return PosCompleteSaleInput{}, errors.New("method is invalid")
		}
		input.Method = *method
	}
	if input.CustomerID, err = crmTaskOptionalUUID(fields, "customerId"); err != nil {
		return PosCompleteSaleInput{}, err
	}
	cashReceivedMinor, err := optionalSafeInteger(fields, "cashReceivedMinor")
	if err != nil || cashReceivedMinor != nil && *cashReceivedMinor < 0 {
		return PosCompleteSaleInput{}, errors.New("cashReceivedMinor must be a non-negative integer")
	}
	input.CashReceivedMinor = cashReceivedMinor
	if rawTenders, ok := fields["tenders"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawTenders), []byte("null")) {
			return PosCompleteSaleInput{}, errors.New("tenders must be an array")
		}
		if input.Tenders, err = parsePosTenders(rawTenders); err != nil {
			return PosCompleteSaleInput{}, err
		}
	}
	total := posSaleTotalMinor(input.Lines)
	if input.Tenders != nil {
		allocated := new(big.Int)
		cashAllocated := new(big.Int)
		for _, tender := range input.Tenders {
			allocated.Add(allocated, big.NewInt(tender.AmountMinor))
			if tender.Method == "cash" {
				cashAllocated.Add(cashAllocated, big.NewInt(tender.AmountMinor))
			}
		}
		if allocated.Cmp(total) != 0 {
			return PosCompleteSaleInput{}, errors.New("tender allocations must exactly cover the sale total")
		}
		if cashAllocated.Sign() == 0 && input.CashReceivedMinor != nil {
			return PosCompleteSaleInput{}, errors.New("cash received only applies when cash is one of the tenders")
		}
		if cashAllocated.Sign() > 0 {
			received := new(big.Int).Set(cashAllocated)
			if input.CashReceivedMinor != nil {
				received.SetInt64(*input.CashReceivedMinor)
			}
			if received.Cmp(cashAllocated) < 0 {
				return PosCompleteSaleInput{}, errors.New("cash received cannot be less than its allocated amount")
			}
		}
	} else if input.Method != "cash" && input.CashReceivedMinor != nil {
		return PosCompleteSaleInput{}, errors.New("cash received only applies to cash sales")
	} else if input.Method == "cash" {
		received := new(big.Int).Set(total)
		if input.CashReceivedMinor != nil {
			received.SetInt64(*input.CashReceivedMinor)
		}
		if received.Cmp(total) < 0 {
			return PosCompleteSaleInput{}, errors.New("cash received must cover the sale total")
		}
	}
	return input, nil
}

func ParsePosCloseSessionInput(raw json.RawMessage) (PosCloseSessionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PosCloseSessionInput{}, err
	}
	input := PosCloseSessionInput{}
	if input.SessionID, err = requiredCRMDealString(fields, "sessionId", 0, 0); err != nil {
		return PosCloseSessionInput{}, err
	}
	if input.CountedCashMinor, err = requiredSafeInteger(fields, "countedCashMinor"); err != nil || input.CountedCashMinor < 0 {
		return PosCloseSessionInput{}, errors.New("countedCashMinor must be a non-negative integer")
	}
	if rawReason, ok := fields["varianceReason"]; ok {
		value, readErr := readOptionalString(rawReason)
		if readErr != nil {
			return PosCloseSessionInput{}, errors.New("varianceReason must be a string")
		}
		trimmed := strings.TrimFunc(*value, isJSWhitespace)
		if utf16Length(trimmed) < 3 {
			return PosCloseSessionInput{}, errors.New("varianceReason must contain at least 3 character(s)")
		}
		if utf16Length(trimmed) > 500 {
			return PosCloseSessionInput{}, errors.New("varianceReason must be at most 500 characters")
		}
		input.VarianceReason = &trimmed
	}
	return input, nil
}

func ParsePosReturnSaleInput(raw json.RawMessage) (PosReturnSaleInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PosReturnSaleInput{}, err
	}
	input := PosReturnSaleInput{RefundMethod: "cash"}
	if input.InvoiceID, err = posRequiredUUID(fields, "invoiceId"); err != nil {
		return PosReturnSaleInput{}, err
	}
	if input.Reason, err = requiredCRMDealString(fields, "reason", 3, 500); err != nil {
		return PosReturnSaleInput{}, err
	}
	if rawMethod, ok := fields["refundMethod"]; ok {
		method, readErr := readOptionalString(rawMethod)
		if readErr != nil || method == nil {
			return PosReturnSaleInput{}, errors.New("refundMethod is invalid")
		}
		switch *method {
		case "cash", "card", "mobile_money":
			input.RefundMethod = *method
		default:
			return PosReturnSaleInput{}, errors.New("refundMethod is invalid")
		}
	}
	if rawLines, ok := fields["lines"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawLines), []byte("null")) {
			return PosReturnSaleInput{}, errors.New("lines must be an array")
		}
		var lineValues []json.RawMessage
		if err := json.Unmarshal(rawLines, &lineValues); err != nil || len(lineValues) == 0 {
			return PosReturnSaleInput{}, errors.New("lines must contain at least one line")
		}
		lines := make([]PosReturnLineInput, 0, len(lineValues))
		for _, lineRaw := range lineValues {
			lineFields, err := decodeJSONObject(lineRaw)
			if err != nil {
				return PosReturnSaleInput{}, errors.New("each return line must be an object")
			}
			invoiceLineID, err := posRequiredUUID(lineFields, "invoiceLineId")
			if err != nil {
				return PosReturnSaleInput{}, err
			}
			quantity, err := requiredSafeInteger(lineFields, "quantity")
			if err != nil || quantity <= 0 {
				return PosReturnSaleInput{}, errors.New("quantity must be a positive integer")
			}
			lines = append(lines, PosReturnLineInput{InvoiceLineID: invoiceLineID, Quantity: quantity})
		}
		input.Lines = lines
	}
	return input, nil
}

func ParsePosShiftSummaryInput(raw json.RawMessage) (PosShiftSummaryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PosShiftSummaryInput{}, err
	}
	sessionID, err := posRequiredUUID(fields, "sessionId")
	if err != nil {
		return PosShiftSummaryInput{}, err
	}
	return PosShiftSummaryInput{SessionID: sessionID}, nil
}

type posSaleTotals struct {
	subtotalMinor int64
	taxMinor      int64
	totalMinor    int64
}

// posComputeSaleTotals mirrors erp-core computeInvoiceTotals over POS sale
// lines: subtotal is per-line rounding of quantity thousandths times unit
// price, tax rides on top, and a zero total refuses to post.
func posComputeSaleTotals(lines []PosSaleLineInput) (posSaleTotals, error) {
	var subtotal, tax big.Int
	for _, line := range lines {
		if line.Quantity <= 0 || line.Quantity > maxSafeInteger {
			return posSaleTotals{}, errors.New("invalid quantity")
		}
		if line.UnitPriceMinor < 0 || line.UnitPriceMinor > maxSafeInteger {
			return posSaleTotals{}, errors.New("invalid unit price")
		}
		if line.TaxMinor < 0 || line.TaxMinor > maxSafeInteger {
			return posSaleTotals{}, errors.New("invalid tax")
		}
		numerator := new(big.Int).Mul(big.NewInt(line.Quantity), big.NewInt(line.UnitPriceMinor))
		numerator.Add(numerator, big.NewInt(500))
		subtotal.Add(&subtotal, numerator.Quo(numerator, big.NewInt(1000)))
		tax.Add(&tax, big.NewInt(line.TaxMinor))
	}
	total := new(big.Int).Add(&subtotal, &tax)
	if total.Sign() <= 0 {
		return posSaleTotals{}, errors.New("invoice must have a non-zero total")
	}
	safeMax := big.NewInt(maxSafeInteger)
	if subtotal.Cmp(safeMax) > 0 || tax.Cmp(safeMax) > 0 || total.Cmp(safeMax) > 0 {
		return posSaleTotals{}, errors.New("invoice total exceeds the supported amount range")
	}
	return posSaleTotals{subtotalMinor: subtotal.Int64(), taxMinor: tax.Int64(), totalMinor: total.Int64()}, nil
}

func posWalkInCustomerID(ctx context.Context, tx pgx.Tx, orgID string) (string, error) {
	var customerID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM customers WHERE org_id = $1::uuid AND name = $2 LIMIT 1`,
		orgID, posWalkInCustomerName).Scan(&customerID)
	if err == nil {
		return customerID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, $2) RETURNING id::text`,
		orgID, posWalkInCustomerName).Scan(&customerID); err != nil {
		return "", err
	}
	return customerID, nil
}

func posUniqueMethodSummary(tenders []PosTenderInput) string {
	seen := make(map[string]struct{}, len(tenders))
	parts := make([]string, 0, len(tenders))
	for _, tender := range tenders {
		if _, ok := seen[tender.Method]; ok {
			continue
		}
		seen[tender.Method] = struct{}{}
		parts = append(parts, tender.Method)
	}
	return strings.Join(parts, " + ")
}

func posOpenSession(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PosOpenSessionInput) (PosOpenSessionOutput, error) {
	orgID := claims.OrganizationID
	// "One open register per org" is a check-then-insert invariant; the
	// advisory lock serializes concurrent opens so two sessions cannot
	// both pass the check and double the drawer.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 44))`, orgID); err != nil {
		return PosOpenSessionOutput{}, err
	}
	var openID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM pos_sessions WHERE org_id = $1::uuid AND status = 'open' LIMIT 1`, orgID).Scan(&openID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PosOpenSessionOutput{}, err
	}
	if err == nil {
		return PosOpenSessionOutput{}, errors.New("a register session is already open, close it first")
	}
	var openedByUserID *string
	if claims.ActorType == "human" {
		openedByUserID = claims.ActorID
	}
	var sessionID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO pos_sessions (org_id, register, opening_float_minor, opened_by_user_id)
		VALUES ($1::uuid, $2, $3, $4::uuid)
		RETURNING id::text`, orgID, input.Register, input.OpeningFloatMinor, openedByUserID).Scan(&sessionID); err != nil {
		return PosOpenSessionOutput{}, err
	}
	return PosOpenSessionOutput{SessionID: sessionID}, nil
}

// posApplyStockDelta mirrors the shared inventory command service: lock the
// item, refuse a negative resulting balance, then append the movement. The
// stock_balances projection is maintained by the database trigger.
func posApplyStockDelta(ctx context.Context, tx pgx.Tx, orgID, itemID string, quantityDelta int64, refType, refID, note string, unitCostMinor *int64, actorType string, actorID *string) error {
	if _, err := tx.Exec(ctx, `
		SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, []string{itemID}); err != nil {
		return err
	}
	var onHand int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances
		WHERE org_id = $1::uuid AND item_id = $2::uuid`, orgID, itemID).Scan(&onHand); err != nil {
		return err
	}
	if onHand+quantityDelta < 0 {
		return fmt.Errorf("cannot move %d thousandths of stock that is not there: only %d on hand for this item", -quantityDelta, onHand)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, ref_type, ref_id, unit_cost_minor, location_id, lot_id, actor_type, actor_id)
		VALUES ($1::uuid, $2::uuid, $3, 'sale', $4, $5, $6::uuid, $7, NULL, NULL, $8, $9::uuid)`,
		orgID, itemID, quantityDelta, note, refType, refID, unitCostMinor, actorType, actorID)
	return err
}

func posLockStockItems(ctx context.Context, tx pgx.Tx, orgID string, itemIDs []string) error {
	if len(itemIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		SELECT id FROM items WHERE org_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
		orgID, itemIDs)
	return err
}

func posCompleteSale(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PosCompleteSaleInput, now time.Time) (PosCompleteSaleOutput, error) {
	orgID := claims.OrganizationID
	if input.Tenders == nil && input.Method == "" {
		input.Method = "cash"
	}
	totals, err := posComputeSaleTotals(input.Lines)
	if err != nil {
		if err.Error() == "invoice must have a non-zero total" {
			return PosCompleteSaleOutput{}, errors.New("sale must have a non-zero total")
		}
		return PosCompleteSaleOutput{}, err
	}
	subtotal, tax, total := totals.subtotalMinor, totals.taxMinor, totals.totalMinor
	var sessionID, sessionStatus string
	err = tx.QueryRow(ctx, `
		SELECT id::text, status FROM pos_sessions WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1 FOR UPDATE`,
		input.SessionID, orgID).Scan(&sessionID, &sessionStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return PosCompleteSaleOutput{}, errors.New("session not found")
	}
	if err != nil {
		return PosCompleteSaleOutput{}, err
	}
	if sessionStatus != "open" {
		return PosCompleteSaleOutput{}, errors.New("session is closed")
	}

	// Graceful degradation (ADR 0035): with the inventory module disabled,
	// a sale is a pure money event with no item resolution and no stock
	// ledger legs. No configured gate behaves as enabled.
	inventoryEnabled, err := isModuleEnabled(ctx, tx, orgID, "inventory")
	if err != nil {
		return PosCompleteSaleOutput{}, err
	}

	type posResolvedStock struct {
		itemID   string
		sku      string
		quantity int64
	}
	var stockLines []posResolvedStock
	itemBySku := make(map[string]string)
	if inventoryEnabled {
		resolved := make([]posResolvedStock, 0, len(input.Lines))
		for _, line := range input.Lines {
			if line.SKU == nil {
				continue
			}
			var itemID, kind string
			err := tx.QueryRow(ctx, `
				SELECT id::text, kind FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
				orgID, *line.SKU).Scan(&itemID, &kind)
			if errors.Is(err, pgx.ErrNoRows) {
				return PosCompleteSaleOutput{}, fmt.Errorf("no stocked item with SKU %s", *line.SKU)
			}
			if err != nil {
				return PosCompleteSaleOutput{}, err
			}
			itemBySku[*line.SKU] = itemID
			if kind == "service" {
				continue
			}
			resolved = append(resolved, posResolvedStock{itemID: itemID, sku: *line.SKU, quantity: line.Quantity})
		}
		itemIDs := make([]string, 0, len(resolved))
		seen := make(map[string]struct{}, len(resolved))
		for _, entry := range resolved {
			if _, dup := seen[entry.itemID]; dup {
				continue
			}
			seen[entry.itemID] = struct{}{}
			itemIDs = append(itemIDs, entry.itemID)
		}
		sort.Strings(itemIDs)
		if len(itemIDs) > 0 {
			// Item rows are locked in a stable order so a concurrent
			// sales-order confirm cannot claim the same stock, and repeated
			// lines spend one running availability budget, not one each.
			if _, err := tx.Exec(ctx, `
				SELECT id FROM items WHERE org_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
				orgID, itemIDs); err != nil {
				return PosCompleteSaleOutput{}, err
			}
		}
		budget := make(map[string]int64, len(itemIDs))
		for _, itemID := range itemIDs {
			var onHand int64
			if err := tx.QueryRow(ctx, `
				SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements
				WHERE org_id = $1::uuid AND item_id = $2::uuid`, orgID, itemID).Scan(&onHand); err != nil {
				return PosCompleteSaleOutput{}, err
			}
			reserved, err := salesOpenReserved(ctx, tx, orgID, itemID)
			if err != nil {
				return PosCompleteSaleOutput{}, err
			}
			budget[itemID] = onHand - reserved
		}
		for _, entry := range resolved {
			available := budget[entry.itemID]
			if available < entry.quantity {
				return PosCompleteSaleOutput{}, fmt.Errorf(
					"insufficient stock for %s: %d thousandths available (on hand minus open reservations)",
					entry.sku, available)
			}
			budget[entry.itemID] = available - entry.quantity
			stockLines = append(stockLines, entry)
		}
	}

	appliedTenders := input.Tenders
	if appliedTenders == nil {
		appliedTenders = []PosTenderInput{{Method: input.Method, AmountMinor: total}}
	}
	var tenderSum int64
	for _, tender := range appliedTenders {
		if tender.AmountMinor <= 0 || tender.AmountMinor > maxSafeInteger {
			return PosCompleteSaleOutput{}, errors.New("tender allocations must exactly cover the sale total")
		}
		tenderSum += tender.AmountMinor
	}
	if tenderSum != total {
		return PosCompleteSaleOutput{}, errors.New("tender allocations must exactly cover the sale total")
	}
	paymentSummary := posUniqueMethodSummary(appliedTenders)
	var cashAllocatedMinor int64
	for _, tender := range appliedTenders {
		if tender.Method == "cash" {
			cashAllocatedMinor += tender.AmountMinor
		}
	}
	cashReceivedMinor := int64(0)
	if cashAllocatedMinor > 0 {
		if input.CashReceivedMinor != nil {
			cashReceivedMinor = *input.CashReceivedMinor
		} else {
			cashReceivedMinor = cashAllocatedMinor
		}
		if cashReceivedMinor < cashAllocatedMinor {
			return PosCompleteSaleOutput{}, errors.New("cash received cannot be less than its allocated amount")
		}
	}
	tenderedMinor := total
	if cashAllocatedMinor > 0 && len(appliedTenders) == 1 {
		// calculateCashTender: a lone cash tender reports the physical
		// amount handed over, which may exceed the sale total.
		if cashReceivedMinor < total {
			return PosCompleteSaleOutput{}, errors.New("cash received must be a safe integer at least equal to the sale total")
		}
		tenderedMinor = cashReceivedMinor
	}
	changeGivenMinor := cashReceivedMinor - cashAllocatedMinor
	if changeGivenMinor < 0 {
		changeGivenMinor = 0
	}

	customerID := input.CustomerID
	if customerID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM customers
				WHERE id = $1::uuid AND org_id = $2::uuid AND deactivated_at IS NULL
			)`, *customerID, orgID).Scan(&active); err != nil {
			return PosCompleteSaleOutput{}, err
		}
		if !active {
			return PosCompleteSaleOutput{}, errors.New("customer not found or inactive in this organization")
		}
	} else {
		walkInID, err := posWalkInCustomerID(ctx, tx, orgID)
		if err != nil {
			return PosCompleteSaleOutput{}, err
		}
		customerID = &walkInID
	}
	invoiceNumber, err := nextInvoiceNumber(ctx, tx, orgID)
	if err != nil {
		return PosCompleteSaleOutput{}, err
	}
	var currency string
	err = tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&currency)
	if errors.Is(err, pgx.ErrNoRows) {
		currency = "USD"
	} else if err != nil {
		return PosCompleteSaleOutput{}, err
	}

	// The invoice row exists before posting so the entry carries its source
	// link at insert time: posted journal rows are immutable, so there is no
	// post-hoc patch of the GL header.
	var invoiceID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, pos_session_id, issued_at, memo)
		VALUES ($1::uuid, $2::uuid, $3, 'paid', $4, $5, $6, $7, $8, $9::uuid, $10, $11)
		RETURNING id::text`,
		orgID, *customerID, invoiceNumber, currency, subtotal, tax, total, total, sessionID,
		now, fmt.Sprintf("POS (%s)", paymentSummary)).Scan(&invoiceID); err != nil {
		return PosCompleteSaleOutput{}, err
	}
	for _, line := range input.Lines {
		var itemID *string
		if line.SKU != nil {
			if resolved, ok := itemBySku[*line.SKU]; ok {
				itemID = &resolved
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (invoice_id, item_id, description, quantity, unit_price_minor, tax_minor)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
			invoiceID, itemID, line.Description, line.Quantity, line.UnitPriceMinor, line.TaxMinor); err != nil {
			return PosCompleteSaleOutput{}, err
		}
	}
	postingLines := []JournalEntryLineInput{
		{AccountCode: "1000", DebitMinor: total},
		{AccountCode: "4000", CreditMinor: subtotal},
	}
	if tax > 0 {
		postingLines = append(postingLines, JournalEntryLineInput{AccountCode: "2100", CreditMinor: tax})
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      orgID,
		Memo:       fmt.Sprintf("POS sale #%d (%s)", invoiceNumber, paymentSummary),
		SourceType: "pos_sale",
		SourceID:   &invoiceID,
		Currency:   currency,
		PostedAt:   now,
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines:      postingLines,
	})
	if err != nil {
		return PosCompleteSaleOutput{}, err
	}
	for _, tender := range appliedTenders {
		if _, err := tx.Exec(ctx, `
			INSERT INTO payments (org_id, invoice_id, amount_minor, method, entry_id)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)`,
			orgID, invoiceID, tender.AmountMinor, tender.Method, entryID); err != nil {
			return PosCompleteSaleOutput{}, err
		}
	}
	for _, stockLine := range stockLines {
		if err := posApplyStockDelta(ctx, tx, orgID, stockLine.itemID, -stockLine.quantity,
			"invoice", invoiceID, fmt.Sprintf("POS sale #%d", invoiceNumber), nil, claims.ActorType, claims.ActorID); err != nil {
			return PosCompleteSaleOutput{}, err
		}
	}
	// Only the cash allocation enters the physical drawer. Card and mobile
	// money remain visible as separate payment rows for reconciliation.
	if cashAllocatedMinor > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE pos_sessions SET expected_cash_minor = expected_cash_minor + $2 WHERE id = $1::uuid`,
			sessionID, cashAllocatedMinor); err != nil {
			return PosCompleteSaleOutput{}, err
		}
	}
	tenders := make([]PosSaleTenderOutput, 0, len(appliedTenders))
	for _, tender := range appliedTenders {
		tenders = append(tenders, PosSaleTenderOutput{Method: tender.Method, AmountMinor: tender.AmountMinor})
	}
	return PosCompleteSaleOutput{
		InvoiceID:        invoiceID,
		InvoiceNumber:    invoiceNumber,
		TotalMinor:       total,
		TenderedMinor:    tenderedMinor,
		ChangeGivenMinor: changeGivenMinor,
		Tenders:          tenders,
	}, nil
}

func posCloseSession(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PosCloseSessionInput, now time.Time) (PosCloseSessionOutput, error) {
	orgID := claims.OrganizationID
	var sessionID, status string
	var openingFloatMinor, expectedCashMinor int64
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, opening_float_minor, expected_cash_minor
		FROM pos_sessions WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1 FOR UPDATE`,
		input.SessionID, orgID).Scan(&sessionID, &status, &openingFloatMinor, &expectedCashMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return PosCloseSessionOutput{}, errors.New("session not found")
	}
	if err != nil {
		return PosCloseSessionOutput{}, err
	}
	if status != "open" {
		return PosCloseSessionOutput{}, errors.New("session already closed")
	}
	expected := openingFloatMinor + expectedCashMinor
	variance := input.CountedCashMinor - expected
	if variance != 0 && input.VarianceReason == nil {
		return PosCloseSessionOutput{}, errors.New("a reason is required to record a drawer variance")
	}
	var varianceReason *string
	if variance != 0 {
		varianceReason = input.VarianceReason
	}
	var closedByUserID *string
	if claims.ActorType == "human" {
		closedByUserID = claims.ActorID
	}
	if _, err := tx.Exec(ctx, `
		UPDATE pos_sessions SET status = 'closed', counted_cash_minor = $2, expected_cash_minor = $3,
			variance_minor = $4, variance_reason = $5, closed_by_user_id = $6::uuid, closed_at = $7
		WHERE id = $1::uuid`,
		sessionID, input.CountedCashMinor, expected, variance, varianceReason, closedByUserID, now); err != nil {
		return PosCloseSessionOutput{}, err
	}
	return PosCloseSessionOutput{ExpectedCashMinor: expected, VarianceMinor: variance, Flagged: variance != 0}, nil
}

// posRoundThousandths mirrors Math.round(product / 1000) for a non-negative
// exact integer product.
func posRoundThousandths(product *big.Int) *big.Int {
	numerator := new(big.Int).Set(product)
	numerator.Add(numerator, big.NewInt(500))
	return numerator.Quo(numerator, big.NewInt(1000))
}

// posRoundFraction mirrors Math.round(numerator / denominator) for
// non-negative integers: floor((2n + d) / (2d)).
func posRoundFraction(numerator, denominator *big.Int) *big.Int {
	doubled := new(big.Int).Lsh(numerator, 1)
	doubled.Add(doubled, denominator)
	twice := new(big.Int).Lsh(denominator, 1)
	return doubled.Quo(doubled, twice)
}

func posRemainingUnitLabel(remainingThousandths int64) string {
	return strconv.FormatFloat(float64(remainingThousandths)/1000, 'f', -1, 64)
}
func posReturnSale(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PosReturnSaleInput, now time.Time) (PosReturnSaleOutput, error) {
	orgID := claims.OrganizationID
	if input.RefundMethod == "" {
		input.RefundMethod = "cash"
	}
	var invoiceID, invoiceStatus, invoiceCurrency string
	var invoiceNumber, totalMinor, creditedMinor int64
	var posSessionID *string
	err := tx.QueryRow(ctx, `
		SELECT id::text, number, status, currency, total_minor, credited_minor, pos_session_id::text
		FROM invoices WHERE id = $1::uuid AND org_id = $2::uuid FOR UPDATE`,
		input.InvoiceID, orgID).Scan(&invoiceID, &invoiceNumber, &invoiceStatus, &invoiceCurrency, &totalMinor, &creditedMinor, &posSessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PosReturnSaleOutput{}, errors.New("sale not found")
	}
	if err != nil {
		return PosReturnSaleOutput{}, err
	}
	if invoiceStatus == "void" {
		return PosReturnSaleOutput{}, errors.New("sale is void")
	}
	refundable := totalMinor - creditedMinor
	if refundable <= 0 {
		return PosReturnSaleOutput{}, fmt.Errorf("sale has nothing left to return (total %d - credited %d)", totalMinor, creditedMinor)
	}
	var originalEntryID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM journal_entries
		WHERE org_id = $1::uuid AND source_type = 'pos_sale' AND source_id = $2::uuid LIMIT 1`,
		orgID, invoiceID).Scan(&originalEntryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PosReturnSaleOutput{}, errors.New("sale entry not found; cannot mirror a return")
	}
	if err != nil {
		return PosReturnSaleOutput{}, err
	}
	type posOriginalLine struct {
		accountID   string
		code        string
		debitMinor  int64
		creditMinor int64
	}
	origLines := make([]posOriginalLine, 0, 3)
	{
		rows, err := tx.Query(ctx, `
			SELECT jl.account_id::text, a.code, jl.debit_minor, jl.credit_minor
			FROM journal_lines jl JOIN accounts a ON jl.account_id = a.id
			WHERE jl.entry_id = $1::uuid`, originalEntryID)
		if err != nil {
			return PosReturnSaleOutput{}, err
		}
		for rows.Next() {
			var line posOriginalLine
			if err := rows.Scan(&line.accountID, &line.code, &line.debitMinor, &line.creditMinor); err != nil {
				rows.Close()
				return PosReturnSaleOutput{}, err
			}
			origLines = append(origLines, line)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosReturnSaleOutput{}, err
		}
		rows.Close()
	}
	type posInvoiceLineRow struct {
		id             string
		itemID         *string
		quantity       int64
		unitPriceMinor int64
		taxMinor       int64
	}
	invoiceLineRows := make([]posInvoiceLineRow, 0, 2)
	{
		rows, err := tx.Query(ctx, `
			SELECT id::text, item_id::text, quantity, unit_price_minor, tax_minor
			FROM invoice_lines WHERE invoice_id = $1::uuid ORDER BY id`, invoiceID)
		if err != nil {
			return PosReturnSaleOutput{}, err
		}
		for rows.Next() {
			var line posInvoiceLineRow
			if err := rows.Scan(&line.id, &line.itemID, &line.quantity, &line.unitPriceMinor, &line.taxMinor); err != nil {
				rows.Close()
				return PosReturnSaleOutput{}, err
			}
			invoiceLineRows = append(invoiceLineRows, line)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosReturnSaleOutput{}, err
		}
		rows.Close()
	}
	invoiceLineIDs := make([]string, 0, len(invoiceLineRows))
	for _, line := range invoiceLineRows {
		invoiceLineIDs = append(invoiceLineIDs, line.id)
	}
	returnedByLine := make(map[string]int64, len(invoiceLineIDs))
	if len(invoiceLineIDs) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT invoice_line_id::text, quantity FROM pos_return_lines
			WHERE org_id = $1::uuid AND invoice_line_id = ANY($2::uuid[])`, orgID, invoiceLineIDs)
		if err != nil {
			return PosReturnSaleOutput{}, err
		}
		for rows.Next() {
			var invoiceLineID string
			var quantity int64
			if err := rows.Scan(&invoiceLineID, &quantity); err != nil {
				rows.Close()
				return PosReturnSaleOutput{}, err
			}
			returnedByLine[invoiceLineID] += quantity
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosReturnSaleOutput{}, err
		}
		rows.Close()
	}
	var structuredCreditMinor int64
	{
		rows, err := tx.Query(ctx, `
			SELECT refund_minor FROM pos_returns
			WHERE org_id = $1::uuid AND invoice_id = $2::uuid`, orgID, invoiceID)
		if err != nil {
			return PosReturnSaleOutput{}, err
		}
		for rows.Next() {
			var refundMinor int64
			if err := rows.Scan(&refundMinor); err != nil {
				rows.Close()
				return PosReturnSaleOutput{}, err
			}
			structuredCreditMinor += refundMinor
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosReturnSaleOutput{}, err
		}
		rows.Close()
	}
	if structuredCreditMinor > creditedMinor {
		return PosReturnSaleOutput{}, errors.New("return history exceeds the invoice credit total; ask accounting to review the sale")
	}
	if structuredCreditMinor < creditedMinor {
		return PosReturnSaleOutput{}, errors.New("this sale has an older credit that is not linked to returned items; ask accounting to review it before returning more items")
	}
	type posSaleLeg struct {
		itemID        string
		quantityDelta int64
		unitCostMinor *int64
	}
	saleLegs := make([]posSaleLeg, 0, 2)
	{
		rows, err := tx.Query(ctx, `
			SELECT item_id::text, quantity_delta, unit_cost_minor FROM stock_movements
			WHERE org_id = $1::uuid AND ref_type = 'invoice' AND ref_id = $2::uuid`, orgID, invoiceID)
		if err != nil {
			return PosReturnSaleOutput{}, err
		}
		for rows.Next() {
			var leg posSaleLeg
			if err := rows.Scan(&leg.itemID, &leg.quantityDelta, &leg.unitCostMinor); err != nil {
				rows.Close()
				return PosReturnSaleOutput{}, err
			}
			saleLegs = append(saleLegs, leg)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosReturnSaleOutput{}, err
		}
		rows.Close()
	}
	stockSoldByItem := make(map[string]int64, len(saleLegs))
	for _, leg := range saleLegs {
		if leg.quantityDelta < 0 {
			stockSoldByItem[leg.itemID] += -leg.quantityDelta
		}
	}
	linkedStockItems := make(map[string]struct{}, len(invoiceLineRows))
	for _, line := range invoiceLineRows {
		if line.itemID != nil {
			linkedStockItems[*line.itemID] = struct{}{}
		}
	}
	hasUnlinkedLegacyStock := false
	for itemID := range stockSoldByItem {
		if _, linked := linkedStockItems[itemID]; !linked {
			hasUnlinkedLegacyStock = true
			break
		}
	}
	if input.Lines != nil && hasUnlinkedLegacyStock {
		return PosReturnSaleOutput{}, errors.New("this older sale does not link stock to individual lines; use its full return option")
	}
	type posReturnRequest struct {
		invoiceLineID string
		quantity      int64
	}
	requested := make([]posReturnRequest, 0, len(invoiceLineRows))
	if input.Lines != nil {
		for _, line := range input.Lines {
			requested = append(requested, posReturnRequest{invoiceLineID: line.InvoiceLineID, quantity: line.Quantity})
		}
	} else {
		for _, line := range invoiceLineRows {
			remaining := line.quantity - returnedByLine[line.id]
			if remaining > 0 {
				requested = append(requested, posReturnRequest{invoiceLineID: line.id, quantity: remaining})
			}
		}
	}
	if len(requested) == 0 {
		return PosReturnSaleOutput{}, errors.New("sale has no unreturned items")
	}
	seenLines := make(map[string]struct{}, len(requested))
	type posSelectedLine struct {
		id               string
		itemID           *string
		quantity         int64
		returnedQuantity int64
		subtotalMinor    int64
		returnTaxMinor   int64
	}
	selectedLines := make([]posSelectedLine, 0, len(requested))
	for _, selection := range requested {
		if _, dup := seenLines[selection.invoiceLineID]; dup {
			return PosReturnSaleOutput{}, errors.New("choose each sale line only once")
		}
		seenLines[selection.invoiceLineID] = struct{}{}
		var line *posInvoiceLineRow
		for index := range invoiceLineRows {
			if invoiceLineRows[index].id == selection.invoiceLineID {
				line = &invoiceLineRows[index]
				break
			}
		}
		if line == nil {
			return PosReturnSaleOutput{}, errors.New("a selected item does not belong to this sale")
		}
		returnedQuantity := returnedByLine[line.id]
		remainingQuantity := line.quantity - returnedQuantity
		if selection.quantity > remainingQuantity {
			return PosReturnSaleOutput{}, fmt.Errorf("return quantity exceeds the %s remaining units for this item", posRemainingUnitLabel(remainingQuantity))
		}
		cumulativeQuantity := returnedQuantity + selection.quantity
		subtotalMinor := new(big.Int).Sub(
			posRoundThousandths(new(big.Int).Mul(big.NewInt(cumulativeQuantity), big.NewInt(line.unitPriceMinor))),
			posRoundThousandths(new(big.Int).Mul(big.NewInt(returnedQuantity), big.NewInt(line.unitPriceMinor))),
		)
		returnTaxMinor := new(big.Int).Sub(
			posRoundFraction(new(big.Int).Mul(big.NewInt(line.taxMinor), big.NewInt(cumulativeQuantity)), big.NewInt(line.quantity)),
			posRoundFraction(new(big.Int).Mul(big.NewInt(line.taxMinor), big.NewInt(returnedQuantity)), big.NewInt(line.quantity)),
		)
		selectedLines = append(selectedLines, posSelectedLine{
			id: line.id, itemID: line.itemID, quantity: selection.quantity,
			returnedQuantity: returnedQuantity, subtotalMinor: subtotalMinor.Int64(),
			returnTaxMinor: returnTaxMinor.Int64(),
		})
	}
	var refund int64
	for _, line := range selectedLines {
		refund += line.subtotalMinor + line.returnTaxMinor
	}
	if refund <= 0 {
		return PosReturnSaleOutput{}, errors.New("selected items have no refundable balance")
	}
	if refund > refundable {
		return PosReturnSaleOutput{}, errors.New("selected items exceed the remaining sale balance")
	}
	var cashAccount, revenueAccount, taxAccount *posOriginalLine
	for index := range origLines {
		line := &origLines[index]
		if line.code == "1000" && line.debitMinor > 0 && cashAccount == nil {
			cashAccount = line
		}
		if line.code == "4000" && line.creditMinor > 0 && revenueAccount == nil {
			revenueAccount = line
		}
		if line.code == "2100" && line.creditMinor > 0 && taxAccount == nil {
			taxAccount = line
		}
	}
	var refundSubtotalMinor, refundTaxMinor int64
	for _, line := range selectedLines {
		refundSubtotalMinor += line.subtotalMinor
		refundTaxMinor += line.returnTaxMinor
	}
	if cashAccount == nil || revenueAccount == nil || refundTaxMinor > 0 && taxAccount == nil {
		return PosReturnSaleOutput{}, errors.New("the original POS accounts are unavailable; ask accounting to review this return")
	}
	legacyFullStockReturn := input.Lines == nil && hasUnlinkedLegacyStock
	if legacyFullStockReturn && (creditedMinor != 0 || refund != totalMinor) {
		return PosReturnSaleOutput{}, errors.New("this older sale can only be returned in full because its stock is not linked to individual sale lines")
	}
	postingLines := []JournalEntryLineInput{
		{AccountCode: cashAccount.code, CreditMinor: refund},
		{AccountCode: revenueAccount.code, DebitMinor: refundSubtotalMinor},
	}
	if refundTaxMinor > 0 {
		postingLines = append(postingLines, JournalEntryLineInput{AccountCode: taxAccount.code, DebitMinor: refundTaxMinor})
	}
	refundEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      orgID,
		Memo:       fmt.Sprintf("POS return on sale %d to %s: %s", invoiceNumber, input.RefundMethod, input.Reason),
		SourceType: "pos_return",
		SourceID:   &invoiceID,
		Currency:   invoiceCurrency,
		PostedAt:   now,
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines:      postingLines,
	})
	if err != nil {
		return PosReturnSaleOutput{}, err
	}
	var returnID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO pos_returns (org_id, invoice_id, entry_id, refund_method, refund_minor, reason)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
		RETURNING id::text`, orgID, invoiceID, refundEntryID, input.RefundMethod, refund, input.Reason).Scan(&returnID); err != nil {
		return PosReturnSaleOutput{}, err
	}
	for _, line := range selectedLines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO pos_return_lines (org_id, return_id, invoice_line_id, quantity, subtotal_minor, tax_minor)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
			orgID, returnID, line.id, line.quantity, line.subtotalMinor, line.returnTaxMinor); err != nil {
			return PosReturnSaleOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE invoices SET credited_minor = $2 WHERE id = $1::uuid`, invoiceID, creditedMinor+refund); err != nil {
		return PosReturnSaleOutput{}, err
	}
	// N12 (ADR 0051): a cash refund physically leaves the drawer, so the
	// session's expected cash drops with it. A closed session's count is
	// frozen history; its variance was recorded when it closed and is not
	// rewritten by later returns.
	if input.RefundMethod == "cash" && posSessionID != nil {
		var sessionID, sessionStatus string
		err := tx.QueryRow(ctx, `
			SELECT id::text, status FROM pos_sessions WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1 FOR UPDATE`,
			*posSessionID, orgID).Scan(&sessionID, &sessionStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return PosReturnSaleOutput{}, err
		}
		if err == nil && sessionStatus == "open" {
			if _, err := tx.Exec(ctx, `
				UPDATE pos_sessions SET expected_cash_minor = expected_cash_minor - $2 WHERE id = $1::uuid`,
				sessionID, refund); err != nil {
				return PosReturnSaleOutput{}, err
			}
		}
	}
	// Stock back: the sale took items out with negative legs referencing
	// the invoice; the return mirrors each one positively.
	var restockedLines int64
	lockIDs := make([]string, 0, len(stockSoldByItem))
	if legacyFullStockReturn {
		for itemID := range stockSoldByItem {
			lockIDs = append(lockIDs, itemID)
		}
	} else {
		seen := make(map[string]struct{}, len(selectedLines))
		for _, line := range selectedLines {
			if line.itemID == nil {
				continue
			}
			if _, ok := stockSoldByItem[*line.itemID]; !ok {
				continue
			}
			if _, dup := seen[*line.itemID]; dup {
				continue
			}
			seen[*line.itemID] = struct{}{}
			lockIDs = append(lockIDs, *line.itemID)
		}
	}
	sort.Strings(lockIDs)
	if err := posLockStockItems(ctx, tx, orgID, lockIDs); err != nil {
		return PosReturnSaleOutput{}, err
	}
	returnNote := fmt.Sprintf("POS return on sale %d: %s", invoiceNumber, input.Reason)
	if legacyFullStockReturn {
		for _, leg := range saleLegs {
			if leg.quantityDelta >= 0 {
				continue
			}
			if err := posApplyStockDelta(ctx, tx, orgID, leg.itemID, -leg.quantityDelta,
				"pos_return", invoiceID, returnNote, leg.unitCostMinor, claims.ActorType, claims.ActorID); err != nil {
				return PosReturnSaleOutput{}, err
			}
			restockedLines++
		}
	} else {
		for _, line := range selectedLines {
			if line.itemID == nil {
				continue
			}
			sold, ok := stockSoldByItem[*line.itemID]
			if !ok {
				continue
			}
			var alreadyReturnedForItem, returningForItem int64
			for _, saleLine := range invoiceLineRows {
				if saleLine.itemID != nil && *saleLine.itemID == *line.itemID {
					alreadyReturnedForItem += returnedByLine[saleLine.id]
				}
			}
			for _, selected := range selectedLines {
				if selected.itemID != nil && *selected.itemID == *line.itemID {
					returningForItem += selected.quantity
				}
			}
			if alreadyReturnedForItem+returningForItem > sold {
				return PosReturnSaleOutput{}, errors.New("returned quantity exceeds the stock originally taken for this item")
			}
			var originalLeg *posSaleLeg
			for index := range saleLegs {
				if saleLegs[index].itemID == *line.itemID && saleLegs[index].quantityDelta < 0 {
					originalLeg = &saleLegs[index]
					break
				}
			}
			var unitCostMinor *int64
			if originalLeg != nil {
				unitCostMinor = originalLeg.unitCostMinor
			}
			if err := posApplyStockDelta(ctx, tx, orgID, *line.itemID, line.quantity,
				"pos_return", invoiceID, returnNote, unitCostMinor, claims.ActorType, claims.ActorID); err != nil {
				return PosReturnSaleOutput{}, err
			}
			restockedLines++
		}
	}
	return PosReturnSaleOutput{
		RefundEntryID:  refundEntryID,
		RefundMinor:    refund,
		CreditedMinor:  creditedMinor + refund,
		RestockedLines: restockedLines,
		RefundMethod:   input.RefundMethod,
	}, nil
}

func posShiftSummary(ctx context.Context, tx pgx.Tx, orgID string, input PosShiftSummaryInput) (PosShiftSummaryOutput, error) {
	var register, status string
	var expectedCashMinor int64
	var countedCashMinor, varianceMinor *int64
	err := tx.QueryRow(ctx, `
		SELECT register, status, expected_cash_minor, counted_cash_minor, variance_minor
		FROM pos_sessions WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`,
		input.SessionID, orgID).Scan(&register, &status, &expectedCashMinor, &countedCashMinor, &varianceMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return PosShiftSummaryOutput{}, errors.New("session not found")
	}
	if err != nil {
		return PosShiftSummaryOutput{}, err
	}
	var salesCount, takingsMinor int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*), COALESCE(SUM(total_minor), 0) FROM invoices
		WHERE org_id = $1::uuid AND pos_session_id = $2::uuid`, orgID, input.SessionID).
		Scan(&salesCount, &takingsMinor); err != nil {
		return PosShiftSummaryOutput{}, err
	}
	tenderTotals := make([]PosMethodTotal, 0, 2)
	{
		rows, err := tx.Query(ctx, `
			SELECT p.method, COALESCE(SUM(p.amount_minor), 0)
			FROM payments p JOIN invoices i ON p.invoice_id = i.id
			WHERE p.org_id = $1::uuid AND i.pos_session_id = $2::uuid
			GROUP BY p.method ORDER BY p.method`, orgID, input.SessionID)
		if err != nil {
			return PosShiftSummaryOutput{}, err
		}
		for rows.Next() {
			var total PosMethodTotal
			if err := rows.Scan(&total.Method, &total.AmountMinor); err != nil {
				rows.Close()
				return PosShiftSummaryOutput{}, err
			}
			tenderTotals = append(tenderTotals, total)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosShiftSummaryOutput{}, err
		}
		rows.Close()
	}
	refundTotals := make([]PosMethodTotal, 0, 1)
	{
		rows, err := tx.Query(ctx, `
			SELECT r.refund_method, COALESCE(SUM(r.refund_minor), 0)
			FROM pos_returns r JOIN invoices i ON r.invoice_id = i.id
			WHERE r.org_id = $1::uuid AND i.pos_session_id = $2::uuid
			GROUP BY r.refund_method ORDER BY r.refund_method`, orgID, input.SessionID)
		if err != nil {
			return PosShiftSummaryOutput{}, err
		}
		for rows.Next() {
			var total PosMethodTotal
			if err := rows.Scan(&total.Method, &total.AmountMinor); err != nil {
				rows.Close()
				return PosShiftSummaryOutput{}, err
			}
			refundTotals = append(refundTotals, total)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PosShiftSummaryOutput{}, err
		}
		rows.Close()
	}
	return PosShiftSummaryOutput{
		Register:          register,
		Status:            status,
		SalesCount:        salesCount,
		TakingsMinor:      takingsMinor,
		TenderTotals:      tenderTotals,
		RefundTotals:      refundTotals,
		ExpectedCashMinor: expectedCashMinor,
		CountedCashMinor:  countedCashMinor,
		VarianceMinor:     varianceMinor,
	}, nil
}
