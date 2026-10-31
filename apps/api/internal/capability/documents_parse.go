package capability

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const documentsParseDocumentCapabilityID = "documents.parseDocument"

type ParseDocumentOutput struct {
	Status string `json:"status"`
	Chars  int    `json:"chars"`
}

type documentsCommittedParseFailure struct {
	message string
	data    json.RawMessage
}

type documentsParseSource struct {
	title         string
	mimeType      *string
	contentBase64 *string
	rawText       *string
	updatedAt     time.Time
}

type documentsOCRRequest struct {
	source   documentsParseSource
	mimeType string
	image    []byte
}

func (request *documentsOCRRequest) Error() string {
	return "document OCR must run outside the database transaction"
}

type documentsOCRPrepared struct {
	source   documentsParseSource
	markdown string
	err      error
}

type documentsOCRPreparedContextKey struct{}

func withDocumentsOCRPrepared(ctx context.Context, prepared documentsOCRPrepared) context.Context {
	return context.WithValue(ctx, documentsOCRPreparedContextKey{}, prepared)
}

func documentsOCRPreparedFromContext(ctx context.Context) (documentsOCRPrepared, bool) {
	prepared, ok := ctx.Value(documentsOCRPreparedContextKey{}).(documentsOCRPrepared)
	return prepared, ok
}

func (failure *documentsCommittedParseFailure) Error() string {
	return failure.message
}

// parseDocumentInput mirrors the TypeScript capability's documentId-only
// schema. The TypeScript schema accepts any string here; UUID validation is
// intentionally deferred to the database lookup, as in that implementation.
func parseDocumentInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredPlainString(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{DocumentID: &documentID}, nil
}

func parseIngestedDocument(
	ctx context.Context,
	tx pgx.Tx,
	claims authbridge.CapabilityClaims,
	input DocumentsInput,
) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if tx == nil || input.DocumentID == nil || claims.OrganizationID == "" {
		return nil, errors.New("document parsing requires a transaction, organization, and document ID")
	}
	var document documentsParseSource
	err := tx.QueryRow(ctx, `
		SELECT title, mime_type, content_base64, raw_text, updated_at
		FROM documents
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).
		Scan(&document.title, &document.mimeType, &document.contentBase64, &document.rawText, &document.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, rejectDocuments("no document %s", *input.DocumentID)
	}
	if err != nil {
		return nil, err
	}

	var markdown string
	switch {
	case document.contentBase64 != nil && document.mimeType != nil:
		parser := documentsImageParserFromContext(ctx)
		if parser == nil {
			return failIngestedDocument(ctx, tx, claims.OrganizationID, *input.DocumentID,
				"OCR provider is not configured for this Go runtime", document)
		}
		image, err := base64.StdEncoding.DecodeString(*document.contentBase64)
		if err != nil || len(image) == 0 || len(image) > documentsMaxUploadBytes {
			return failIngestedDocument(ctx, tx, claims.OrganizationID, *input.DocumentID,
				"uploaded document file is invalid or exceeds the 5MB limit", document)
		}
		prepared, hasPrepared := documentsOCRPreparedFromContext(ctx)
		if !hasPrepared {
			return nil, &documentsOCRRequest{source: document, mimeType: *document.mimeType, image: image}
		}
		if !sameDocumentsParseSource(document, prepared.source) {
			return nil, rejectDocuments("document changed while it was being parsed; retry")
		}
		if prepared.err != nil {
			return failIngestedDocument(ctx, tx, claims.OrganizationID, *input.DocumentID, prepared.err.Error(), document)
		}
		markdown = prepared.markdown
		if strings.TrimSpace(markdown) == "" {
			return failIngestedDocument(ctx, tx, claims.OrganizationID, *input.DocumentID, "OCR returned no text", document)
		}
	case document.rawText != nil && *document.rawText != "":
		markdown = *document.rawText
	default:
		return failIngestedDocument(ctx, tx, claims.OrganizationID, *input.DocumentID,
			"document has neither a file nor pasted text", document)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE documents
		SET parsed_markdown=$3, status='parsed', parse_error=NULL,
		    updated_at=GREATEST(clock_timestamp(), $4::timestamptz + interval '1 microsecond')
		WHERE org_id=$1::uuid AND id=$2::uuid AND title=$5
		  AND content_base64 IS NOT DISTINCT FROM $6 AND mime_type IS NOT DISTINCT FROM $7
		  AND raw_text IS NOT DISTINCT FROM $8 AND updated_at=$9`, claims.OrganizationID, *input.DocumentID, markdown, document.updatedAt,
		document.title, document.contentBase64, document.mimeType, document.rawText, document.updatedAt)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, rejectDocuments("document changed while it was being parsed; retry")
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM memories
		WHERE org_id=$1::uuid AND source=$2`, claims.OrganizationID, "document:"+*input.DocumentID); err != nil {
		return nil, err
	}
	content := documentsParseMemoryContent(markdown)
	dimension, dimensionErr := documentsMemoryEmbeddingDimension(ctx, tx)
	if dimensionErr != nil {
		dimension = 0
	}
	embedding := documentsParseEmbedding(ctx, content, dimension)
	metadata, err := json.Marshal(map[string]string{"documentId": *input.DocumentID, "title": document.title})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO memories (org_id, kind, source, content, embedding, metadata)
		VALUES ($1::uuid, 'doc_chunk', $2, $3, $4::vector, $5::jsonb)`,
		claims.OrganizationID, "document:"+*input.DocumentID, content, embedding, metadata); err != nil {
		return nil, err
	}
	return ParseDocumentOutput{Status: "parsed", Chars: documentsParseJSLength(markdown)}, nil
}

func sameDocumentsParseSource(left, right documentsParseSource) bool {
	return left.title == right.title && sameOptionalString(left.mimeType, right.mimeType) &&
		sameOptionalString(left.contentBase64, right.contentBase64) && sameOptionalString(left.rawText, right.rawText) &&
		left.updatedAt.Equal(right.updatedAt)
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func failIngestedDocument(ctx context.Context, tx pgx.Tx, orgID, documentID, message string, document documentsParseSource) (any, error) {
	query := `
		UPDATE documents
		SET status='failed', parse_error=$3,
		    updated_at=GREATEST(clock_timestamp(), $4::timestamptz + interval '1 microsecond')
		WHERE org_id=$1::uuid AND id=$2::uuid`
	args := []any{orgID, documentID, message, document.updatedAt}
	query += ` AND title=$5 AND content_base64 IS NOT DISTINCT FROM $6 AND mime_type IS NOT DISTINCT FROM $7 AND raw_text IS NOT DISTINCT FROM $8 AND updated_at=$9`
	args = append(args, document.title, document.contentBase64, document.mimeType, document.rawText, document.updatedAt)
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, rejectDocuments("document changed while it was being parsed; retry")
	}
	output, err := json.Marshal(ParseDocumentOutput{Status: "failed", Chars: 0})
	if err != nil {
		return nil, err
	}
	// The executor commits this typed result and returns it as a failed capability
	// outcome after recording the audit event and idempotency receipt.
	return nil, &documentsCommittedParseFailure{
		message: "parse failed: " + message,
		data:    output,
	}
}

func documentsParseMemoryContent(markdown string) string {
	var builder strings.Builder
	units := 0
	for len(markdown) > 0 {
		r, size := utf8.DecodeRuneInString(markdown)
		unitCount := utf16.RuneLen(r)
		if unitCount < 0 || units+unitCount > 8000 {
			break
		}
		builder.WriteString(markdown[:size])
		units += unitCount
		markdown = markdown[size:]
	}
	return builder.String()
}

func documentsMemoryEmbeddingDimension(ctx context.Context, tx pgx.Tx) (int, error) {
	var typeName string
	if err := tx.QueryRow(ctx, `
		SELECT format_type(attribute.atttypid, attribute.atttypmod)
		FROM pg_catalog.pg_attribute AS attribute
	WHERE attribute.attrelid='public.memories'::regclass
		  AND attribute.attname='embedding' AND NOT attribute.attisdropped`).Scan(&typeName); err != nil {
		return 0, err
	}
	if !strings.HasPrefix(typeName, "vector(") || !strings.HasSuffix(typeName, ")") {
		return 0, errors.New("memory embedding column has no fixed vector dimension")
	}
	dimension, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(typeName, "vector("), ")"))
	if err != nil || dimension < 1 || dimension > 16000 {
		return 0, fmt.Errorf("memory embedding dimension %q is invalid", typeName)
	}
	return dimension, nil
}

func documentsParseEmbedding(ctx context.Context, content string, dimension int) any {
	model, modelErr := SupportEmbeddingModelFromEnv()
	embedder, clientErr := SupportEmbeddingClientFromEnv()
	if modelErr == nil && clientErr == nil {
		return documentsParseEmbeddingWith(ctx, content, dimension, model, embedder)
	}
	return documentsParseEmbeddingWith(ctx, content, dimension, "", nil)
}

func documentsParseEmbeddingWith(ctx context.Context, content string, dimension int, model string, embedder SupportKnowledgeEmbedder) any {
	if dimension < 1 || dimension > 16000 {
		return nil
	}
	if embedder != nil && model != "" && content != "" {
		vectors, err := embedder.Embed(ctx, model, "passage", []string{content})
		if err == nil && len(vectors) == 1 && len(vectors[0]) == dimension {
			if literal, err := documentsVectorLiteral(vectors[0], dimension); err == nil {
				return literal
			}
		}
	}
	var builder strings.Builder
	builder.WriteByte('[')
	for index := 0; index < dimension; index++ {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteByte('0')
	}
	builder.WriteByte(']')
	return builder.String()
}

func documentsVectorLiteral(vector []float32, dimension int) (string, error) {
	if dimension < 1 || len(vector) != dimension {
		return "", errors.New("document embedding has an invalid dimension")
	}
	var builder strings.Builder
	builder.WriteByte('[')
	for index, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return "", errors.New("document embedding has an invalid value")
		}
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(strconv.FormatFloat(float64(value), 'f', -1, 32))
	}
	builder.WriteByte(']')
	return builder.String(), nil
}

func documentsParseJSLength(value string) int {
	length := 0
	for len(value) > 0 {
		r, size := utf8.DecodeRuneInString(value)
		length += utf16.RuneLen(r)
		value = value[size:]
	}
	return length
}
