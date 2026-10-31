package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var authoredDocumentNumberKinds = map[string]string{
	"invoice":              "INV",
	"quote":                "QTN",
	"receipt":              "RCT",
	"delivery_note":        "DN",
	"purchase_order":       "PO",
	"voucher":              "VCH",
	"employment_contract":  "EMP",
	"employment_agreement": "AGR",
}

type DocumentNumberOutput struct {
	Number string `json:"number"`
}

func parseDocumentNumberInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	kind, err := documentsRequiredString(fields, "kind", 1, 40)
	if err != nil {
		return DocumentsInput{}, err
	}
	if _, ok := authoredDocumentNumberKinds[kind]; !ok {
		return DocumentsInput{}, errors.New("kind is invalid")
	}
	return DocumentsInput{Kind: &kind}, nil
}

func allocateDocumentNumber(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	input DocumentsInput,
	now time.Time,
) (DocumentNumberOutput, error) {
	if input.Kind == nil {
		return DocumentNumberOutput{}, errors.New("document number kind is missing")
	}
	kind := *input.Kind
	prefix, ok := authoredDocumentNumberKinds[kind]
	if !ok {
		return DocumentNumberOutput{}, errors.New("document number kind is invalid")
	}
	var number int64
	var err error
	switch kind {
	case "invoice":
		number, err = nextInvoiceNumber(ctx, tx, orgID)
	case "quote":
		number, err = nextQuoteNumber(ctx, tx, orgID)
	default:
		number, err = nextAuthoredDocumentNumber(ctx, tx, orgID, kind)
	}
	if err != nil {
		return DocumentNumberOutput{}, err
	}
	if number <= 0 || number > maxDatabaseInteger {
		return DocumentNumberOutput{}, fmt.Errorf("%s number exceeds the database integer range", kind)
	}
	return DocumentNumberOutput{Number: fmt.Sprintf("%s-%d-%04d", prefix, now.UTC().Year(), number)}, nil
}

// This allocator intentionally uses a distinct authored_<kind> counter for
// each non-accounting document kind. In particular, purchase orders created
// as authored templates do not consume operational purchasing PO numbers.
func nextAuthoredDocumentNumber(ctx context.Context, tx pgx.Tx, orgID, kind string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next") VALUES ($1::uuid, $2, 1)
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID, "authored_"+kind).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate authored %s number: %w", kind, err)
	}
	return number, nil
}
