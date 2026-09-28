package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createVendorCapabilityID         = "purchasing.createVendor"
	createBillCapabilityID           = "purchasing.createBill"
	payBillCapabilityID              = "purchasing.payBill"
	reverseVendorPaymentCapabilityID = "purchasing.reverseVendorPayment"
)

const accountsPayableAccountCode = "2000"
const cashAccountCode = "1000"
const inputTaxAssetAccountCode = "1205"

type CreateVendorInput struct {
	Name            string  `json:"name"`
	Email           *string `json:"email,omitempty"`
	PaymentTermDays *int64  `json:"paymentTermDays,omitempty"`
}

type CreateVendorOutput struct {
	VendorID string `json:"vendorId"`
}

type CreateBillLineInput struct {
	Description        string  `json:"description"`
	Quantity           int64   `json:"quantity"`
	UnitPriceMinor     int64   `json:"unitPriceMinor"`
	ExpenseAccountCode string  `json:"expenseAccountCode"`
	TaxMinor           *int64  `json:"taxMinor,omitempty"`
	TaxCodeID          *string `json:"taxCodeId,omitempty"`
	POLineNumber       *int64  `json:"poLineNumber,omitempty"`
}

type CreateBillInput struct {
	VendorID  string                `json:"vendorId"`
	VendorRef *string               `json:"vendorRef,omitempty"`
	Memo      *string               `json:"memo,omitempty"`
	PONumber  *int64                `json:"poNumber,omitempty"`
	Lines     []CreateBillLineInput `json:"lines"`
}

type CreateBillOutput struct {
	BillNumber int64  `json:"billNumber"`
	TotalMinor int64  `json:"totalMinor"`
	EntryID    string `json:"entryId"`
}

type PayBillInput struct {
	BillNumber  int64  `json:"billNumber"`
	AmountMinor int64  `json:"amountMinor"`
	Method      string `json:"method"`
}

type PayBillOutput struct {
	PaymentID string `json:"paymentId"`
	EntryID   string `json:"entryId"`
	FullyPaid bool   `json:"fullyPaid"`
}

type ReverseVendorPaymentInput struct {
	VendorPaymentID string `json:"vendorPaymentId"`
	Reason          string `json:"reason"`
}

type ReverseVendorPaymentOutput struct {
	ReversalEntryID  string `json:"reversalEntryId"`
	RefundedMinor    int64  `json:"refundedMinor"`
	BillNumber       int64  `json:"billNumber"`
	OutstandingMinor int64  `json:"outstandingMinor"`
}

func ParseCreateVendorInput(raw json.RawMessage) (CreateVendorInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateVendorInput{}, err
	}
	name, err := requiredCRMDealString(fields, "name", 1, 0)
	if err != nil {
		return CreateVendorInput{}, err
	}
	input := CreateVendorInput{Name: name}
	if _, ok := fields["email"]; ok {
		email, emailErr := optionalString(fields, "email")
		if emailErr != nil || email == nil || !validCustomerEmail(*email) {
			return CreateVendorInput{}, errors.New("email must be a valid email address")
		}
		input.Email = email
	}
	if input.PaymentTermDays, err = optionalSafeInteger(fields, "paymentTermDays"); err != nil || input.PaymentTermDays != nil && (*input.PaymentTermDays <= 0 || *input.PaymentTermDays > 365) {
		return CreateVendorInput{}, errors.New("paymentTermDays must be a positive integer of at most 365 days")
	}
	return input, nil
}

func ParseCreateBillInput(raw json.RawMessage) (CreateBillInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateBillInput{}, err
	}
	vendorID, err := requiredCRMDealString(fields, "vendorId", 0, 0)
	if err != nil {
		return CreateBillInput{}, err
	}
	input := CreateBillInput{VendorID: vendorID}
	if input.VendorRef, err = optionalCRMDealString(fields, "vendorRef", 0, false); err != nil {
		return CreateBillInput{}, err
	}
	if input.Memo, err = optionalCRMDealString(fields, "memo", 0, false); err != nil {
		return CreateBillInput{}, err
	}
	if input.PONumber, err = optionalSafeInteger(fields, "poNumber"); err != nil || input.PONumber != nil && *input.PONumber <= 0 {
		return CreateBillInput{}, errors.New("poNumber must be a positive integer")
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return CreateBillInput{}, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return CreateBillInput{}, errors.New("lines must contain at least one line")
	}
	if input.Lines, err = parseCreateBillLines(lineValues); err != nil {
		return CreateBillInput{}, err
	}
	return input, nil
}

var billExpenseAccountCodePattern = regexp.MustCompile(`^\d{4}$`)

func parseCreateBillLines(lineValues []json.RawMessage) ([]CreateBillLineInput, error) {
	lines := make([]CreateBillLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, errors.New("each bill line must be an object")
		}
		var line CreateBillLineInput
		line.Description, err = requiredCRMDealString(lineFields, "description", 1, 0)
		if err != nil {
			return nil, err
		}
		line.Quantity, err = requiredSafeInteger(lineFields, "quantity")
		if err != nil || line.Quantity <= 0 {
			return nil, errors.New("quantity must be a positive integer")
		}
		line.UnitPriceMinor, err = requiredSafeInteger(lineFields, "unitPriceMinor")
		if err != nil || line.UnitPriceMinor < 0 {
			return nil, errors.New("unitPriceMinor must be a non-negative integer")
		}
		line.ExpenseAccountCode = "6000"
		if rawCode, ok := lineFields["expenseAccountCode"]; ok {
			var code string
			if bytes.Equal(bytes.TrimSpace(rawCode), []byte("null")) || json.Unmarshal(rawCode, &code) != nil {
				return nil, errors.New("expenseAccountCode must be a four digit account code")
			}
			if !billExpenseAccountCodePattern.MatchString(code) {
				return nil, errors.New("expenseAccountCode must be a four digit account code")
			}
			line.ExpenseAccountCode = code
		}
		if line.TaxMinor, err = optionalSafeInteger(lineFields, "taxMinor"); err != nil || line.TaxMinor != nil && *line.TaxMinor < 0 {
			return nil, errors.New("taxMinor must be a non-negative integer")
		}
		if line.TaxCodeID, err = optionalString(lineFields, "taxCodeId"); err != nil {
			return nil, errors.New("taxCodeId must be a UUID")
		} else if line.TaxCodeID != nil && !isZodUUID(*line.TaxCodeID) {
			return nil, errors.New("taxCodeId must be a UUID")
		}
		if line.TaxCodeID != nil && line.TaxMinor != nil {
			return nil, errors.New("use a configured tax code or a manual tax amount, not both")
		}
		if line.POLineNumber, err = optionalSafeInteger(lineFields, "poLineNumber"); err != nil || line.POLineNumber != nil && *line.POLineNumber <= 0 {
			return nil, errors.New("poLineNumber must be a positive integer")
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func ParsePayBillInput(raw json.RawMessage) (PayBillInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PayBillInput{}, err
	}
	var input PayBillInput
	input.BillNumber, err = requiredSafeInteger(fields, "billNumber")
	if err != nil || input.BillNumber <= 0 {
		return PayBillInput{}, errors.New("billNumber must be a positive integer")
	}
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return PayBillInput{}, errors.New("amountMinor must be a positive integer")
	}
	input.Method = "bank_transfer"
	if rawMethod, ok := fields["method"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawMethod), []byte("null")) || json.Unmarshal(rawMethod, &input.Method) != nil {
			return PayBillInput{}, errors.New("method is invalid")
		}
	}
	switch input.Method {
	case "cash", "bank_transfer", "card":
	default:
		return PayBillInput{}, errors.New("method is invalid")
	}
	return input, nil
}

func ParseReverseVendorPaymentInput(raw json.RawMessage) (ReverseVendorPaymentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReverseVendorPaymentInput{}, err
	}
	var input ReverseVendorPaymentInput
	input.VendorPaymentID, err = requiredCRMDealString(fields, "vendorPaymentId", 0, 0)
	if err != nil || !isZodUUID(input.VendorPaymentID) {
		return ReverseVendorPaymentInput{}, errors.New("vendorPaymentId must be a UUID")
	}
	input.Reason, err = requiredCRMDealString(fields, "reason", 0, 0)
	if err != nil {
		return ReverseVendorPaymentInput{}, errors.New("reason must be a string")
	}
	length := len(utf16.Encode([]rune(input.Reason)))
	if length < 3 || length > 500 {
		return ReverseVendorPaymentInput{}, errors.New("reason must be between 3 and 500 characters")
	}
	return input, nil
}

// purchasingBalance is the vendor-bill side of the shared document-balance
// contract (N11): outstanding and settlement are derived here and nowhere
// else, so credit-adjusted gating and status flips stay consistent.
type purchasingBalanceView struct {
	outstandingMinor int64
	fullySettled     bool
}

func purchasingBalance(totalMinor, paidMinor, creditedMinor int64) (purchasingBalanceView, error) {
	if totalMinor < 0 || paidMinor < 0 || creditedMinor < 0 {
		return purchasingBalanceView{}, errors.New("vendor bill balance contains an invalid negative amount")
	}
	allocated := paidMinor + creditedMinor
	if allocated < paidMinor {
		return purchasingBalanceView{}, errors.New("vendor bill balance exceeds the supported amount range")
	}
	outstanding := totalMinor - allocated
	if outstanding < 0 {
		outstanding = 0
	}
	return purchasingBalanceView{outstandingMinor: outstanding, fullySettled: allocated >= totalMinor}, nil
}

const purchasingPriceTolerancePct = 2

type purchasingMatchViolation struct {
	kind   string
	detail string
}

// purchasingMatchThreeWay mirrors erp-core matchThreeWay: one line may not be
// billed beyond what was received, beyond what remains ordered, or at a price
// drifting past the tolerance around the ordered price.
func purchasingMatchThreeWay(orderedQty, receivedQty, billedQty, poUnitPriceMinor, billUnitPriceMinor int64) []purchasingMatchViolation {
	violations := make([]purchasingMatchViolation, 0, 3)
	if billedQty > receivedQty {
		violations = append(violations, purchasingMatchViolation{kind: "unreceived_bill", detail: fmt.Sprintf("billed %d exceeds received %d", billedQty, receivedQty)})
	}
	if billedQty > orderedQty {
		violations = append(violations, purchasingMatchViolation{kind: "overbilled_qty", detail: fmt.Sprintf("billed %d exceeds ordered %d", billedQty, orderedQty)})
	}
	expected := (poUnitPriceMinor*(100-purchasingPriceTolerancePct) + 50) / 100
	maxAllowed := (poUnitPriceMinor*(100+purchasingPriceTolerancePct) + 50) / 100
	if billUnitPriceMinor > 0 && (billUnitPriceMinor < expected || billUnitPriceMinor > maxAllowed) {
		violations = append(violations, purchasingMatchViolation{kind: "price_mismatch", detail: fmt.Sprintf("bill price %d outside %d%% of ordered %d", billUnitPriceMinor, purchasingPriceTolerancePct, poUnitPriceMinor)})
	}
	return violations
}

// Delivered-basis helpers (N16): acceptance and returns live on the receipt
// lines; the stock ledger only nets legacy rows in, posted before receipts
// existed.
func purchasingAcceptedForLine(ctx context.Context, tx pgx.Tx, poLineID string) (int64, error) {
	var accepted int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(accepted_thousandths), 0) FROM goods_receipt_lines WHERE po_line_id = $1::uuid`, poLineID).Scan(&accepted); err != nil {
		return 0, err
	}
	var legacy int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements WHERE ref_type = 'po_line' AND ref_id = $1::uuid`, poLineID).Scan(&legacy); err != nil {
		return 0, err
	}
	if legacy < 0 {
		legacy = 0
	}
	return accepted + legacy, nil
}

func purchasingReturnedForLine(ctx context.Context, tx pgx.Tx, poLineID string) (int64, error) {
	var returned int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(returned_thousandths), 0) FROM goods_receipt_lines WHERE po_line_id = $1::uuid`, poLineID).Scan(&returned); err != nil {
		return 0, err
	}
	var legacy int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements WHERE ref_type = 'po_line' AND ref_id = $1::uuid`, poLineID).Scan(&legacy); err != nil {
		return 0, err
	}
	if legacy > 0 {
		legacy = 0
	}
	return returned - legacy, nil
}

func nextBillNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'vendor_bill', COALESCE(MAX(number), 0) + 1 FROM vendor_bills WHERE org_id = $1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate vendor bill number: %w", err)
	}
	if number <= 0 || number > maxDatabaseInteger {
		return 0, errors.New("vendor bill number exceeds the database integer range")
	}
	return number, nil
}

func createVendor(ctx context.Context, tx pgx.Tx, orgID string, input CreateVendorInput) (CreateVendorOutput, error) {
	var vendorID string
	err := tx.QueryRow(ctx, `
		INSERT INTO vendors (org_id, name, email, payment_term_days)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, input.Name, input.Email, input.PaymentTermDays).Scan(&vendorID)
	if err != nil {
		return CreateVendorOutput{}, err
	}
	return CreateVendorOutput{VendorID: vendorID}, nil
}

type poLineRow struct {
	id             string
	quantity       int64
	unitPriceMinor int64
	position       int64
}

type resolvedBillLine struct {
	input                  CreateBillLineInput
	taxMinor               int64
	netMinor               int64
	grossMinor             int64
	taxCodeID              *string
	rateBasisPoints        *int64
	priceIncludesTax       bool
	recoverable            bool
	assetAccountCode       string
	matchingUnitPriceMinor int64
}

// Posting rule for bills: DR each line's expense account, CR Accounts
// Payable. The AP credit is what makes the vendor a creditor until paid.
func createBill(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateBillInput, now time.Time) (CreateBillOutput, error) {
	orgID := claims.OrganizationID
	var jurisdiction string
	hasTaxProfile := false
	if err := tx.QueryRow(ctx, `SELECT jurisdiction_code FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&jurisdiction); err == nil {
		hasTaxProfile = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return CreateBillOutput{}, err
	}
	resolved := make([]resolvedBillLine, 0, len(input.Lines))
	for _, line := range input.Lines {
		// Zod applies this default before execute. Keep direct domain callers on
		// the same posting path when they provide an otherwise valid bill line.
		if line.ExpenseAccountCode == "" {
			line.ExpenseAccountCode = "6000"
		}
		if line.TaxCodeID != nil {
			if !hasTaxProfile {
				return CreateBillOutput{}, errors.New("set the organization tax jurisdiction before using tax codes")
			}
			var codeID, jurisdictionCode, direction, code, assetAccountCode string
			var rateBasisPoints int64
			var priceIncludesTax, recoverable bool
			err := tx.QueryRow(ctx, `
				SELECT id::text, jurisdiction_code, direction, code, rate_basis_points, price_includes_tax, recoverable, asset_account_code
				FROM tax_codes
				WHERE id = $1::uuid AND org_id = $2::uuid AND active = true`,
				*line.TaxCodeID, orgID).Scan(&codeID, &jurisdictionCode, &direction, &code, &rateBasisPoints, &priceIncludesTax, &recoverable, &assetAccountCode)
			if errors.Is(err, pgx.ErrNoRows) {
				return CreateBillOutput{}, errors.New("tax code not found or inactive")
			}
			if err != nil {
				return CreateBillOutput{}, err
			}
			if jurisdictionCode != jurisdiction {
				return CreateBillOutput{}, errors.New("tax code jurisdiction does not match the organization tax profile")
			}
			if direction != "input" {
				return CreateBillOutput{}, fmt.Errorf("tax code %s is configured for output tax", code)
			}
			rate := rateBasisPoints
			net, tax, gross, err := calculateInvoiceLine(line.Quantity, line.UnitPriceMinor, &rate, priceIncludesTax, nil)
			if err != nil {
				return CreateBillOutput{}, err
			}
			matchingUnitPrice := line.UnitPriceMinor
			if priceIncludesTax {
				matchingNet, _, _, err := calculateInvoiceLine(1_000, line.UnitPriceMinor, &rate, true, nil)
				if err != nil {
					return CreateBillOutput{}, err
				}
				matchingUnitPrice = matchingNet
			}
			taxCodeID := codeID
			resolved = append(resolved, resolvedBillLine{
				input: line, taxMinor: tax, netMinor: net, grossMinor: gross,
				taxCodeID: &taxCodeID, rateBasisPoints: &rate, priceIncludesTax: priceIncludesTax,
				recoverable: recoverable, assetAccountCode: assetAccountCode, matchingUnitPriceMinor: matchingUnitPrice,
			})
		} else {
			taxMinor := int64(0)
			if line.TaxMinor != nil {
				taxMinor = *line.TaxMinor
			}
			net, _, _, err := calculateInvoiceLine(line.Quantity, line.UnitPriceMinor, nil, false, nil)
			if err != nil {
				return CreateBillOutput{}, err
			}
			gross := net + taxMinor
			if gross > maxSafeInteger {
				return CreateBillOutput{}, errors.New("bill line exceeds the supported amount range")
			}
			resolved = append(resolved, resolvedBillLine{
				input: line, taxMinor: taxMinor, netMinor: net, grossMinor: gross,
				recoverable: true, assetAccountCode: inputTaxAssetAccountCode, matchingUnitPriceMinor: line.UnitPriceMinor,
			})
		}
	}

	// Three-way match when the bill references an order: order, receipts, and
	// bill. Repeated references to one order line inside this bill consume
	// each other's allowance, so the aggregate is what validates.
	poLineByPosition := make(map[int64]poLineRow)
	if input.PONumber != nil {
		var poID, poVendorID string
		err := tx.QueryRow(ctx, `
			SELECT id::text, vendor_id::text
			FROM purchase_orders
			WHERE org_id = $1::uuid AND number = $2
			LIMIT 1
			FOR UPDATE`, orgID, *input.PONumber).Scan(&poID, &poVendorID)
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateBillOutput{}, fmt.Errorf("purchase order %d not found", *input.PONumber)
		}
		if err != nil {
			return CreateBillOutput{}, err
		}
		if poVendorID != input.VendorID {
			return CreateBillOutput{}, fmt.Errorf("vendor mismatch: order %d belongs to a different vendor", *input.PONumber)
		}
		rows, err := tx.Query(ctx, `
			SELECT id::text, quantity, unit_price_minor, position
			FROM po_lines WHERE po_id = $1::uuid`, poID)
		if err != nil {
			return CreateBillOutput{}, err
		}
		for rows.Next() {
			var line poLineRow
			if err := rows.Scan(&line.id, &line.quantity, &line.unitPriceMinor, &line.position); err != nil {
				rows.Close()
				return CreateBillOutput{}, err
			}
			poLineByPosition[line.position] = line
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return CreateBillOutput{}, err
		}
		rows.Close()
		consumed := make(map[string]int64, len(input.Lines))
		for index := range input.Lines {
			line := input.Lines[index]
			if line.POLineNumber == nil {
				return CreateBillOutput{}, fmt.Errorf("line %q must reference a purchase-order line number", line.Description)
			}
			poLine, ok := poLineByPosition[*line.POLineNumber]
			if !ok {
				return CreateBillOutput{}, fmt.Errorf("no line %d on order %d", *line.POLineNumber, *input.PONumber)
			}
			alreadyInThisBill := consumed[poLine.id]
			accepted, err := purchasingAcceptedForLine(ctx, tx, poLine.id)
			if err != nil {
				return CreateBillOutput{}, err
			}
			returned, err := purchasingReturnedForLine(ctx, tx, poLine.id)
			if err != nil {
				return CreateBillOutput{}, err
			}
			var priorBilled int64
			if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(quantity), 0) FROM vendor_bill_lines WHERE po_line_id = $1::uuid`, poLine.id).Scan(&priorBilled); err != nil {
				return CreateBillOutput{}, err
			}
			priorBilled += alreadyInThisBill
			violations := purchasingMatchThreeWay(poLine.quantity-priorBilled, accepted-returned-priorBilled, line.Quantity, poLine.unitPriceMinor, resolved[index].matchingUnitPriceMinor)
			if len(violations) > 0 {
				parts := make([]string, 0, len(violations))
				for _, violation := range violations {
					parts = append(parts, fmt.Sprintf("%s (%s)", violation.kind, violation.detail))
				}
				return CreateBillOutput{}, fmt.Errorf("three-way match failed on line %d (%s): %s", *line.POLineNumber, line.Description, strings.Join(parts, "; "))
			}
			consumed[poLine.id] = alreadyInThisBill + line.Quantity
		}
	}

	var paymentTermDays *int64
	err := tx.QueryRow(ctx, `
		SELECT payment_term_days FROM vendors
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.VendorID, orgID).Scan(&paymentTermDays)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateBillOutput{}, errors.New("vendor not found")
	}
	if err != nil {
		return CreateBillOutput{}, err
	}
	var baseCurrency string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&baseCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			baseCurrency = "USD"
		} else {
			return CreateBillOutput{}, err
		}
	}

	var subtotal, taxes, total big.Int
	for _, line := range resolved {
		subtotal.Add(&subtotal, big.NewInt(line.netMinor))
		taxes.Add(&taxes, big.NewInt(line.taxMinor))
		total.Add(&total, big.NewInt(line.grossMinor))
	}
	safeMax := big.NewInt(maxSafeInteger)
	if subtotal.Cmp(safeMax) > 0 || taxes.Cmp(safeMax) > 0 || total.Cmp(safeMax) > 0 {
		return CreateBillOutput{}, errors.New("bill total exceeds the supported amount range")
	}
	if total.Int64() > maxDatabaseInteger {
		return CreateBillOutput{}, errors.New("bill total exceeds the database integer range")
	}

	billNumber, err := nextBillNumber(ctx, tx, orgID)
	if err != nil {
		return CreateBillOutput{}, err
	}

	postingLines := make([]JournalEntryLineInput, 0, len(resolved)+2)
	for _, line := range resolved {
		debit := line.netMinor
		if !line.recoverable {
			debit = line.grossMinor
		}
		postingLines = append(postingLines, JournalEntryLineInput{AccountCode: line.input.ExpenseAccountCode, DebitMinor: debit})
	}
	taxByAccount := make(map[string]int64)
	taxAccountOrder := make([]string, 0, 2)
	for _, line := range resolved {
		if line.recoverable && line.taxMinor > 0 {
			if _, seen := taxByAccount[line.assetAccountCode]; !seen {
				taxAccountOrder = append(taxAccountOrder, line.assetAccountCode)
			}
			taxByAccount[line.assetAccountCode] += line.taxMinor
		}
	}
	for _, code := range taxAccountOrder {
		postingLines = append(postingLines, JournalEntryLineInput{AccountCode: code, DebitMinor: taxByAccount[code]})
	}
	postingLines = append(postingLines, JournalEntryLineInput{AccountCode: accountsPayableAccountCode, CreditMinor: total.Int64()})
	filteredPostingLines := make([]JournalEntryLineInput, 0, len(postingLines))
	for _, line := range postingLines {
		if line.DebitMinor != 0 || line.CreditMinor != 0 {
			filteredPostingLines = append(filteredPostingLines, line)
		}
	}
	memo := fmt.Sprintf("Vendor bill %d", billNumber)
	if input.VendorRef != nil {
		memo += fmt.Sprintf(" (%s)", *input.VendorRef)
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID, Memo: memo, SourceType: "vendor_bill", Currency: baseCurrency,
		PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID,
		Lines: filteredPostingLines,
	})
	if err != nil {
		return CreateBillOutput{}, err
	}

	dueAt := now
	if paymentTermDays != nil && *paymentTermDays > 0 {
		dueAt = now.Add(time.Duration(*paymentTermDays) * 24 * time.Hour)
	}
	var billID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, vendor_ref, due_at, status, currency, total_minor, memo, entry_id, bill_date)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'open', $6, $7, $8, $9::uuid, $10)
		RETURNING id::text`,
		orgID, input.VendorID, billNumber, input.VendorRef, dueAt, baseCurrency, total.Int64(), input.Memo, entryID, now).Scan(&billID); err != nil {
		return CreateBillOutput{}, err
	}
	for _, line := range resolved {
		var poLineID *string
		if input.PONumber != nil && line.input.POLineNumber != nil {
			if poLine, ok := poLineByPosition[*line.input.POLineNumber]; ok {
				poLineID = &poLine.id
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO vendor_bill_lines (bill_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax, expense_account_code, po_line_id)
			VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10::uuid)`,
			billID, line.input.Description, line.input.Quantity, line.input.UnitPriceMinor, line.taxMinor,
			line.taxCodeID, line.rateBasisPoints, line.priceIncludesTax, line.input.ExpenseAccountCode, poLineID); err != nil {
			return CreateBillOutput{}, err
		}
	}
	return CreateBillOutput{BillNumber: billNumber, TotalMinor: total.Int64(), EntryID: entryID}, nil
}

// Posting rule: DR Accounts Payable, CR Cash. Money class, threshold-gated.
func payBill(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PayBillInput, now time.Time) (PayBillOutput, error) {
	orgID := claims.OrganizationID
	if input.AmountMinor > maxDatabaseInteger {
		return PayBillOutput{}, errors.New("payment amount exceeds the database integer range")
	}
	var billID, status, currency string
	var totalMinor, paidMinor, creditedMinor int64
	// N11: serialize money application per document, so the outstanding
	// verdict sees every committed payment instead of a stale snapshot.
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, currency, total_minor, paid_minor, credited_minor
		FROM vendor_bills
		WHERE org_id = $1::uuid AND number = $2
		FOR UPDATE`, orgID, input.BillNumber).Scan(&billID, &status, &currency, &totalMinor, &paidMinor, &creditedMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return PayBillOutput{}, errors.New("bill not found")
	}
	if err != nil {
		return PayBillOutput{}, err
	}
	if status == "draft" || status == "void" {
		return PayBillOutput{}, fmt.Errorf("document is %s and cannot receive money", status)
	}
	outstanding, err := purchasingBalance(totalMinor, paidMinor, creditedMinor)
	if err != nil {
		return PayBillOutput{}, err
	}
	if input.AmountMinor > outstanding.outstandingMinor {
		return PayBillOutput{}, fmt.Errorf("overpayment: outstanding is %d minor (total %d, credited %d, paid %d)", outstanding.outstandingMinor, totalMinor, creditedMinor, paidMinor)
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID, Memo: fmt.Sprintf("Vendor payment for bill %d (%s)", input.BillNumber, input.Method),
		SourceType: "vendor_payment", Currency: currency, PostedAt: now,
		ActorType: claims.ActorType, ActorID: claims.ActorID,
		Lines: []JournalEntryLineInput{
			{AccountCode: accountsPayableAccountCode, DebitMinor: input.AmountMinor},
			{AccountCode: cashAccountCode, CreditMinor: input.AmountMinor},
		},
	})
	if err != nil {
		return PayBillOutput{}, err
	}
	var paymentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO vendor_payments (org_id, bill_id, amount_minor, method, entry_id, paid_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
		RETURNING id::text`, orgID, billID, input.AmountMinor, input.Method, entryID, now).Scan(&paymentID); err != nil {
		return PayBillOutput{}, err
	}
	// N11/N12: settle and flag status through the one balance contract, so a
	// bill fully covered by credits is settled without further payments.
	settled, err := purchasingBalance(totalMinor, paidMinor+input.AmountMinor, creditedMinor)
	if err != nil {
		return PayBillOutput{}, err
	}
	newStatus := status
	if settled.fullySettled {
		newStatus = "paid"
	}
	if _, err := tx.Exec(ctx, `UPDATE vendor_bills SET paid_minor = $2, status = $3 WHERE id = $1::uuid`, billID, paidMinor+input.AmountMinor, newStatus); err != nil {
		return PayBillOutput{}, err
	}
	return PayBillOutput{PaymentID: paymentID, EntryID: entryID, FullyPaid: settled.fullySettled}, nil
}

func reverseVendorPayment(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReverseVendorPaymentInput, now time.Time) (ReverseVendorPaymentOutput, error) {
	orgID := claims.OrganizationID
	var billID string
	var entryID, paymentRunID *string
	var amountMinor int64
	var status string
	err := tx.QueryRow(ctx, `
		SELECT bill_id::text, amount_minor, entry_id::text, payment_run_id::text, status
		FROM vendor_payments
		WHERE id = $1::uuid AND org_id = $2::uuid`, input.VendorPaymentID, orgID).
		Scan(&billID, &amountMinor, &entryID, &paymentRunID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReverseVendorPaymentOutput{}, errors.New("vendor payment not found")
	}
	if err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	if paymentRunID != nil {
		return ReverseVendorPaymentOutput{}, errors.New("this payment belongs to a supplier payment run; reverse the complete run instead")
	}
	if status == "reversed" {
		return ReverseVendorPaymentOutput{}, errors.New("vendor payment has already been reversed")
	}
	if entryID == nil || *entryID == "" {
		return ReverseVendorPaymentOutput{}, errors.New("vendor payment has no journal entry to reverse")
	}
	entryIDValue := *entryID
	var billNumber int64
	var totalMinor, paidMinor, creditedMinor int64
	// N11: releasing paidMinor mutates the bill under the same document lock
	// the payment path holds, so two concurrent reversals serialize here and
	// the loser sees the winner's committed reversal.
	err = tx.QueryRow(ctx, `
		SELECT number, total_minor, paid_minor, credited_minor
		FROM vendor_bills
		WHERE id = $1::uuid AND org_id = $2::uuid
		FOR UPDATE`, billID, orgID).Scan(&billNumber, &totalMinor, &paidMinor, &creditedMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReverseVendorPaymentOutput{}, errors.New("vendor payment's bill not found")
	}
	if err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	var alreadyReversed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid)`, orgID, entryIDValue).Scan(&alreadyReversed); err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	if alreadyReversed {
		return ReverseVendorPaymentOutput{}, errors.New("vendor payment has already been reversed")
	}
	var originalCurrency string
	if err := tx.QueryRow(ctx, `SELECT currency FROM journal_entries WHERE id = $1::uuid`, entryIDValue).Scan(&originalCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ReverseVendorPaymentOutput{}, errors.New("vendor payment's journal entry not found")
		}
		return ReverseVendorPaymentOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl
		JOIN accounts a ON a.id = jl.account_id AND a.org_id = $2::uuid
		WHERE jl.entry_id = $1::uuid
		ORDER BY jl.id`, entryIDValue, orgID)
	if err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	lines := make([]JournalEntryLineInput, 0, 4)
	for rows.Next() {
		var code string
		var debit, credit int64
		if err := rows.Scan(&code, &debit, &credit); err != nil {
			rows.Close()
			return ReverseVendorPaymentOutput{}, err
		}
		lines = append(lines, JournalEntryLineInput{AccountCode: code, DebitMinor: credit, CreditMinor: debit})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReverseVendorPaymentOutput{}, err
	}
	rows.Close()
	// The mirror keeps the original's currency (ADR 0021): a vendor payment
	// settles in the currency it was posted in. Posted rows stay immutable;
	// the reversal is a new entry linked by reversal_of_id.
	reversalEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID, Memo: fmt.Sprintf("Vendor payment reversal for bill %d: %s", billNumber, input.Reason),
		SourceType: "vendor-payment-reversal", SourceID: &billID, ReversalOfID: &entryIDValue,
		Currency: originalCurrency, PostedAt: now,
		ActorType: claims.ActorType, ActorID: claims.ActorID, Lines: lines,
	})
	if err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	// Bill-state repair (N12): releasing the payment demotes a paid bill back
	// to open through the one balance contract.
	released, err := purchasingBalance(totalMinor, paidMinor-amountMinor, creditedMinor)
	if err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	newStatus := "open"
	if released.fullySettled {
		newStatus = "paid"
	}
	if _, err := tx.Exec(ctx, `UPDATE vendor_bills SET paid_minor = $2, status = $3 WHERE id = $1::uuid`, billID, paidMinor-amountMinor, newStatus); err != nil {
		return ReverseVendorPaymentOutput{}, err
	}
	return ReverseVendorPaymentOutput{
		ReversalEntryID: reversalEntryID, RefundedMinor: amountMinor,
		BillNumber: billNumber, OutstandingMinor: released.outstandingMinor,
	}, nil
}

func parsePurchasingBillInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createVendorCapabilityID:
		return ParseCreateVendorInput(raw)
	case createBillCapabilityID:
		return ParseCreateBillInput(raw)
	case payBillCapabilityID:
		return ParsePayBillInput(raw)
	case reverseVendorPaymentCapabilityID:
		return ParseReverseVendorPaymentInput(raw)
	default:
		return nil, errors.New("unsupported purchasing bill capability")
	}
}
