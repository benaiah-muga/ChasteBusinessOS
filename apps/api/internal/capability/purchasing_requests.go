package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createPurchaseRequestCapabilityID = "purchasing.createPurchaseRequest"
	decidePurchaseRequestCapabilityID = "purchasing.decidePurchaseRequest"
	createRfqCapabilityID             = "purchasing.createRfq"
	recordQuoteCapabilityID           = "purchasing.recordQuote"
	selectWinningQuoteCapabilityID    = "purchasing.selectWinningQuote"
	listPurchaseWorkflowCapabilityID  = "purchasing.listPurchaseWorkflow"
)

type CreatePurchaseRequestInput struct {
	Title                string `json:"title"`
	Justification        string `json:"justification"`
	EstimatedAmountMinor *int64 `json:"estimatedAmountMinor,omitempty"`
}

type CreatePurchaseRequestOutput struct {
	RequestID string `json:"requestId"`
}

type DecidePurchaseRequestInput struct {
	RequestID string  `json:"requestId"`
	Decision  string  `json:"decision"`
	Reason    *string `json:"reason,omitempty"`
}

type DecidePurchaseRequestOutput struct {
	Status string `json:"status"`
}

type CreateRfqInput struct {
	RequestID string   `json:"requestId"`
	VendorIDs []string `json:"vendorIds"`
}

type CreateRfqOutput struct {
	RFQIDs []string `json:"rfqIds"`
}

type RecordQuoteInput struct {
	RFQID        string  `json:"rfqId"`
	AmountMinor  int64   `json:"amountMinor"`
	LeadTimeDays *int64  `json:"leadTimeDays,omitempty"`
	Notes        *string `json:"notes,omitempty"`
}

type RecordQuoteOutput struct {
	Status string `json:"status"`
}

type SelectWinningQuoteInput struct {
	RFQID string `json:"rfqId"`
}

type SelectWinningQuoteOutput struct {
	PONumber         int64  `json:"poNumber"`
	VendorID         string `json:"vendorId"`
	QuoteAmountMinor int64  `json:"quoteAmountMinor"`
}

type ListPurchaseWorkflowInput struct{}

type PurchaseWorkflowRFQItem struct {
	ID                string  `json:"id"`
	VendorID          string  `json:"vendorId"`
	VendorName        string  `json:"vendorName"`
	Status            string  `json:"status"`
	QuoteAmountMinor  *int64  `json:"quoteAmountMinor"`
	QuoteLeadTimeDays *int64  `json:"quoteLeadTimeDays"`
	QuoteNotes        *string `json:"quoteNotes"`
}

type PurchaseWorkflowRequestItem struct {
	ID                   string                    `json:"id"`
	Title                string                    `json:"title"`
	Justification        string                    `json:"justification"`
	EstimatedAmountMinor *int64                    `json:"estimatedAmountMinor"`
	Status               string                    `json:"status"`
	DecisionReason       *string                   `json:"decisionReason"`
	CreatedAt            string                    `json:"createdAt"`
	RFQs                 []PurchaseWorkflowRFQItem `json:"rfqs"`
}

type ListPurchaseWorkflowOutput struct {
	Requests []PurchaseWorkflowRequestItem `json:"requests"`
}

func ParseCreatePurchaseRequestInput(raw json.RawMessage) (CreatePurchaseRequestInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatePurchaseRequestInput{}, err
	}
	var input CreatePurchaseRequestInput
	input.Title, err = requiredCRMDealString(fields, "title", 3, 200)
	if err != nil {
		return CreatePurchaseRequestInput{}, err
	}
	input.Justification, err = requiredCRMDealString(fields, "justification", 10, 4000)
	if err != nil {
		return CreatePurchaseRequestInput{}, err
	}
	if input.EstimatedAmountMinor, err = optionalSafeInteger(fields, "estimatedAmountMinor"); err != nil || input.EstimatedAmountMinor != nil && *input.EstimatedAmountMinor < 0 {
		return CreatePurchaseRequestInput{}, errors.New("estimatedAmountMinor must be a non-negative integer")
	}
	return input, nil
}

func ParseDecidePurchaseRequestInput(raw json.RawMessage) (DecidePurchaseRequestInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DecidePurchaseRequestInput{}, err
	}
	var input DecidePurchaseRequestInput
	input.RequestID, err = requiredCRMDealString(fields, "requestId", 0, 0)
	if err != nil {
		return DecidePurchaseRequestInput{}, err
	}
	input.Decision, err = requiredCRMDealString(fields, "decision", 0, 0)
	if err != nil {
		return DecidePurchaseRequestInput{}, err
	}
	switch input.Decision {
	case "approve", "reject":
	default:
		return DecidePurchaseRequestInput{}, errors.New("decision must be approve or reject")
	}
	if input.Reason, err = optionalCRMDealString(fields, "reason", 1000, false); err != nil {
		return DecidePurchaseRequestInput{}, err
	}
	return input, nil
}

func ParseCreateRfqInput(raw json.RawMessage) (CreateRfqInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateRfqInput{}, err
	}
	requestID, err := requiredCRMDealString(fields, "requestId", 0, 0)
	if err != nil {
		return CreateRfqInput{}, err
	}
	rawVendorIDs, ok := fields["vendorIds"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawVendorIDs), []byte("null")) {
		return CreateRfqInput{}, errors.New("vendorIds is required")
	}
	var vendorValues []json.RawMessage
	if err := json.Unmarshal(rawVendorIDs, &vendorValues); err != nil {
		return CreateRfqInput{}, errors.New("vendorIds must be an array of strings")
	}
	if len(vendorValues) < 1 {
		return CreateRfqInput{}, errors.New("vendorIds must contain at least 1 vendor")
	}
	if len(vendorValues) > 10 {
		return CreateRfqInput{}, errors.New("vendorIds must contain at most 10 vendors")
	}
	vendorIDs := make([]string, 0, len(vendorValues))
	seenVendorIDs := make(map[string]struct{}, len(vendorValues))
	for _, value := range vendorValues {
		var vendorID string
		if err := json.Unmarshal(value, &vendorID); err != nil {
			return CreateRfqInput{}, errors.New("vendorIds must be an array of strings")
		}
		canonicalVendorID := strings.ToLower(vendorID)
		if _, duplicate := seenVendorIDs[canonicalVendorID]; duplicate {
			return CreateRfqInput{}, errors.New("vendorIds must not contain duplicates")
		}
		seenVendorIDs[canonicalVendorID] = struct{}{}
		vendorIDs = append(vendorIDs, vendorID)
	}
	return CreateRfqInput{RequestID: requestID, VendorIDs: vendorIDs}, nil
}

func ParseRecordQuoteInput(raw json.RawMessage) (RecordQuoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RecordQuoteInput{}, err
	}
	var input RecordQuoteInput
	input.RFQID, err = requiredCRMDealString(fields, "rfqId", 0, 0)
	if err != nil {
		return RecordQuoteInput{}, err
	}
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return RecordQuoteInput{}, errors.New("amountMinor must be a positive integer")
	}
	if input.LeadTimeDays, err = optionalSafeInteger(fields, "leadTimeDays"); err != nil || input.LeadTimeDays != nil && *input.LeadTimeDays < 0 {
		return RecordQuoteInput{}, errors.New("leadTimeDays must be a non-negative integer")
	}
	if input.Notes, err = optionalCRMDealString(fields, "notes", 2000, false); err != nil {
		return RecordQuoteInput{}, err
	}
	return input, nil
}

func ParseSelectWinningQuoteInput(raw json.RawMessage) (SelectWinningQuoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SelectWinningQuoteInput{}, err
	}
	rfqID, err := requiredCRMDealString(fields, "rfqId", 0, 0)
	if err != nil {
		return SelectWinningQuoteInput{}, err
	}
	return SelectWinningQuoteInput{RFQID: rfqID}, nil
}

func ParseListPurchaseWorkflowInput(raw json.RawMessage) (ListPurchaseWorkflowInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListPurchaseWorkflowInput{}, err
	}
	return ListPurchaseWorkflowInput{}, nil
}

// Attribution mirror of the TS port: an agent's actor id is the principal it
// works for, so requests always carry the human they belong to.
func createPurchaseRequest(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreatePurchaseRequestInput) (CreatePurchaseRequestOutput, error) {
	var requestID string
	err := tx.QueryRow(ctx, `
		INSERT INTO purchase_requests (org_id, title, justification, estimated_amount_minor, requested_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Title, input.Justification, input.EstimatedAmountMinor, claims.ActorID).Scan(&requestID)
	if err != nil {
		return CreatePurchaseRequestOutput{}, err
	}
	return CreatePurchaseRequestOutput{RequestID: requestID}, nil
}

func decidePurchaseRequest(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DecidePurchaseRequestInput, now time.Time) (DecidePurchaseRequestOutput, error) {
	var requestID, status string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status
		FROM purchase_requests
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.RequestID, claims.OrganizationID).Scan(&requestID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return DecidePurchaseRequestOutput{}, errors.New("purchase request not found")
	}
	if err != nil {
		return DecidePurchaseRequestOutput{}, err
	}
	if status != "pending_review" {
		return DecidePurchaseRequestOutput{}, fmt.Errorf("request is already %s", status)
	}
	nextStatus := "rejected"
	if input.Decision == "approve" {
		nextStatus = "approved"
	}
	var decidedByUserID *string
	if claims.ActorType == "human" {
		decidedByUserID = claims.ActorID
	}
	if _, err := tx.Exec(ctx, `
		UPDATE purchase_requests
		SET status = $2, decided_by_user_id = $3::uuid, decision_reason = $4, decided_at = $5
		WHERE id = $1::uuid`, requestID, nextStatus, decidedByUserID, input.Reason, now); err != nil {
		return DecidePurchaseRequestOutput{}, err
	}
	return DecidePurchaseRequestOutput{Status: nextStatus}, nil
}

func createRfq(ctx context.Context, tx pgx.Tx, orgID string, input CreateRfqInput) (CreateRfqOutput, error) {
	var requestID, status string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status
		FROM purchase_requests
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.RequestID, orgID).Scan(&requestID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateRfqOutput{}, errors.New("purchase request not found")
	}
	if err != nil {
		return CreateRfqOutput{}, err
	}
	if status != "approved" {
		return CreateRfqOutput{}, errors.New("only approved requests can go out as RFQs")
	}
	seenVendorIDs := make(map[string]struct{}, len(input.VendorIDs))
	for _, vendorID := range input.VendorIDs {
		canonicalVendorID := strings.ToLower(vendorID)
		if _, duplicate := seenVendorIDs[canonicalVendorID]; duplicate {
			return CreateRfqOutput{}, errors.New("vendorIds must not contain duplicates")
		}
		seenVendorIDs[canonicalVendorID] = struct{}{}
		if !isUUID(vendorID) {
			return CreateRfqOutput{}, errors.New("unknown vendor id(s)")
		}
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM vendors WHERE id = $1::uuid AND org_id = $2::uuid)`, vendorID, orgID).Scan(&exists); err != nil {
			return CreateRfqOutput{}, err
		}
		if !exists {
			return CreateRfqOutput{}, errors.New("unknown vendor id(s)")
		}
	}
	var existingRFQ bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM rfqs
			WHERE request_id = $1::uuid AND org_id = $2::uuid AND vendor_id = ANY($3::uuid[])
		)`, requestID, orgID, input.VendorIDs).Scan(&existingRFQ); err != nil {
		return CreateRfqOutput{}, err
	}
	if existingRFQ {
		return CreateRfqOutput{}, errors.New("RFQ already exists for one or more selected vendors")
	}
	rfqIDs := make([]string, 0, len(input.VendorIDs))
	rows, err := tx.Query(ctx, `
		INSERT INTO rfqs (org_id, request_id, vendor_id)
		SELECT $1::uuid, $2::uuid, vendor_id FROM unnest($3::uuid[]) AS vendor_id
		RETURNING id::text`, orgID, requestID, input.VendorIDs)
	if err != nil {
		return CreateRfqOutput{}, err
	}
	for rows.Next() {
		var rfqID string
		if err := rows.Scan(&rfqID); err != nil {
			rows.Close()
			return CreateRfqOutput{}, err
		}
		rfqIDs = append(rfqIDs, rfqID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return CreateRfqOutput{}, err
	}
	rows.Close()
	return CreateRfqOutput{RFQIDs: rfqIDs}, nil
}

func recordQuote(ctx context.Context, tx pgx.Tx, orgID string, input RecordQuoteInput, now time.Time) (RecordQuoteOutput, error) {
	var requestID string
	err := tx.QueryRow(ctx, `
		SELECT request_id::text
		FROM rfqs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.RFQID, orgID).Scan(&requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordQuoteOutput{}, errors.New("RFQ not found")
	}
	if err != nil {
		return RecordQuoteOutput{}, err
	}
	var lockedRequestID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM purchase_requests
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1 FOR UPDATE`, requestID, orgID).Scan(&lockedRequestID); errors.Is(err, pgx.ErrNoRows) {
		return RecordQuoteOutput{}, errors.New("purchase request not found")
	} else if err != nil {
		return RecordQuoteOutput{}, err
	}
	var rfqID, status string
	err = tx.QueryRow(ctx, `
		SELECT id::text, status
		FROM rfqs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1 FOR UPDATE`, input.RFQID, orgID).Scan(&rfqID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordQuoteOutput{}, errors.New("RFQ not found")
	}
	if err != nil {
		return RecordQuoteOutput{}, err
	}
	if status == "won" || status == "lost" {
		return RecordQuoteOutput{}, errors.New("this RFQ is already decided")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE rfqs
		SET status = 'quoted', quote_amount_minor = $2, quote_lead_time_days = $3, quote_notes = $4, quoted_at = $5
		WHERE id = $1::uuid`, rfqID, input.AmountMinor, input.LeadTimeDays, input.Notes, now); err != nil {
		return RecordQuoteOutput{}, err
	}
	return RecordQuoteOutput{Status: "quoted"}, nil
}

func selectWinningQuote(ctx context.Context, tx pgx.Tx, orgID string, input SelectWinningQuoteInput, now time.Time) (SelectWinningQuoteOutput, error) {
	var requestID string
	err := tx.QueryRow(ctx, `
		SELECT request_id::text
		FROM rfqs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.RFQID, orgID).Scan(&requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SelectWinningQuoteOutput{}, errors.New("RFQ not found")
	}
	if err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	var requestStatus, requestTitle string
	err = tx.QueryRow(ctx, `
		SELECT status, title
		FROM purchase_requests
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1 FOR UPDATE`, requestID, orgID).Scan(&requestStatus, &requestTitle)
	if errors.Is(err, pgx.ErrNoRows) {
		return SelectWinningQuoteOutput{}, errors.New("purchase request not found")
	}
	if err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	if requestStatus != "approved" {
		return SelectWinningQuoteOutput{}, errors.New("request is no longer approvable into an order")
	}
	var rfqID, vendorID, status string
	var quoteAmountMinor *int64
	err = tx.QueryRow(ctx, `
		SELECT id::text, request_id::text, vendor_id::text, status, quote_amount_minor
		FROM rfqs
		WHERE id = $1::uuid AND request_id = $2::uuid AND org_id = $3::uuid
		LIMIT 1 FOR UPDATE`, input.RFQID, requestID, orgID).Scan(&rfqID, &requestID, &vendorID, &status, &quoteAmountMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return SelectWinningQuoteOutput{}, errors.New("RFQ not found")
	}
	if err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	if status != "quoted" {
		return SelectWinningQuoteOutput{}, errors.New("record this vendor's quote before awarding")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE rfqs SET status = 'lost'
		WHERE request_id = $1::uuid AND org_id = $2::uuid`, requestID, orgID); err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE rfqs SET status = 'won' WHERE id = $1::uuid`, rfqID); err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	poNumber, err := nextPurchaseOrderNumber(ctx, tx, orgID)
	if err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	if poNumber <= 0 || poNumber > maxDatabaseInteger {
		return SelectWinningQuoteOutput{}, errors.New("purchase order number exceeds the database integer range")
	}
	quoteAmount := int64(0)
	if quoteAmountMinor != nil {
		quoteAmount = *quoteAmountMinor
	}
	var poID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo, ordered_at)
		VALUES ($1::uuid, $2::uuid, $3, 'ordered', $4, $5)
		RETURNING id::text`, orgID, vendorID, poNumber, fmt.Sprintf("From RFQ award \u00b7 %s", requestTitle), now).Scan(&poID); err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position)
		VALUES ($1::uuid, $2, 1000, $3, 1)`, poID, requestTitle, quoteAmount); err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE purchase_requests SET status = 'converted', decided_at = $2
		WHERE id = $1::uuid`, requestID, now); err != nil {
		return SelectWinningQuoteOutput{}, err
	}
	return SelectWinningQuoteOutput{PONumber: poNumber, VendorID: vendorID, QuoteAmountMinor: quoteAmount}, nil
}

func listPurchaseWorkflow(ctx context.Context, tx pgx.Tx, orgID string, input ListPurchaseWorkflowInput) (ListPurchaseWorkflowOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, title, justification, estimated_amount_minor, status, decision_reason, created_at
		FROM purchase_requests
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return ListPurchaseWorkflowOutput{}, err
	}
	requests := make([]PurchaseWorkflowRequestItem, 0, 8)
	requestIDs := make([]string, 0, 8)
	for rows.Next() {
		var item PurchaseWorkflowRequestItem
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.Title, &item.Justification, &item.EstimatedAmountMinor, &item.Status, &item.DecisionReason, &createdAt); err != nil {
			rows.Close()
			return ListPurchaseWorkflowOutput{}, err
		}
		item.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		item.RFQs = []PurchaseWorkflowRFQItem{}
		requestIDs = append(requestIDs, item.ID)
		requests = append(requests, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ListPurchaseWorkflowOutput{}, err
	}
	rows.Close()
	if len(requests) == 0 {
		return ListPurchaseWorkflowOutput{Requests: requests}, nil
	}
	rfqRows, err := tx.Query(ctx, `
		SELECT rfqs.id::text, rfqs.request_id::text, rfqs.vendor_id::text,
		       COALESCE(vendors.name, ''), rfqs.status, rfqs.quote_amount_minor,
		       rfqs.quote_lead_time_days, rfqs.quote_notes
		FROM rfqs
		LEFT JOIN vendors ON vendors.id = rfqs.vendor_id AND vendors.org_id = rfqs.org_id
		WHERE rfqs.org_id = $1::uuid`, orgID)
	if err != nil {
		return ListPurchaseWorkflowOutput{}, err
	}
	rfqsByRequest := make(map[string][]PurchaseWorkflowRFQItem, len(requestIDs))
	for rfqRows.Next() {
		var rfq PurchaseWorkflowRFQItem
		var requestID string
		if err := rfqRows.Scan(&rfq.ID, &requestID, &rfq.VendorID, &rfq.VendorName, &rfq.Status, &rfq.QuoteAmountMinor, &rfq.QuoteLeadTimeDays, &rfq.QuoteNotes); err != nil {
			rfqRows.Close()
			return ListPurchaseWorkflowOutput{}, err
		}
		rfqsByRequest[requestID] = append(rfqsByRequest[requestID], rfq)
	}
	if err := rfqRows.Err(); err != nil {
		rfqRows.Close()
		return ListPurchaseWorkflowOutput{}, err
	}
	rfqRows.Close()
	for index := range requests {
		if items, ok := rfqsByRequest[requests[index].ID]; ok {
			requests[index].RFQs = items
		}
	}
	return ListPurchaseWorkflowOutput{Requests: requests}, nil
}

func parsePurchasingRequestInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createPurchaseRequestCapabilityID:
		return ParseCreatePurchaseRequestInput(raw)
	case decidePurchaseRequestCapabilityID:
		return ParseDecidePurchaseRequestInput(raw)
	case createRfqCapabilityID:
		return ParseCreateRfqInput(raw)
	case recordQuoteCapabilityID:
		return ParseRecordQuoteInput(raw)
	case selectWinningQuoteCapabilityID:
		return ParseSelectWinningQuoteInput(raw)
	case listPurchaseWorkflowCapabilityID:
		return ParseListPurchaseWorkflowInput(raw)
	default:
		return nil, errors.New("unsupported purchasing request capability")
	}
}
