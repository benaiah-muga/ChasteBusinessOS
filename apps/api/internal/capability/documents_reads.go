package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const documentsListDocsCapabilityID = "documents.listDocs"
const documentsListIngestedCapabilityID = "documents.listIngestedDocuments"

var ErrIngestedDocumentNotFound = errors.New("ingested document not found")

type IngestedDocumentsInput struct {
	ID      *string `json:"id,omitempty"`
	Preview bool    `json:"preview"`
}

type IngestedDocumentRow struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Status     string  `json:"status"`
	SourceType string  `json:"sourceType"`
	CreatedAt  string  `json:"createdAt"`
	Folder     *string `json:"folder"`
}

type IngestedVendorRow struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type IngestedSuggestion struct {
	ID                   string          `json:"id"`
	OrgID                string          `json:"orgId"`
	DocumentID           string          `json:"documentId"`
	Description          string          `json:"description"`
	QuantityThousandths  int64           `json:"quantityThousandths"`
	UnitPriceMinor       int64           `json:"unitPriceMinor"`
	SuggestedAccountCode string          `json:"suggestedAccountCode"`
	MatchScore           int64           `json:"matchScore"`
	MatchedOn            json.RawMessage `json:"matchedOn"`
	Status               string          `json:"status"`
	CreatedAt            string          `json:"createdAt"`
}

type IngestedDocumentDetail struct {
	ID             string               `json:"id"`
	Title          string               `json:"title"`
	Status         string               `json:"status"`
	SourceType     string               `json:"sourceType"`
	MIMEType       *string              `json:"mimeType"`
	SizeBytes      *int64               `json:"sizeBytes"`
	ParseError     *string              `json:"parseError"`
	ParsedMarkdown *string              `json:"parsedMarkdown"`
	CreatedAt      string               `json:"createdAt"`
	Folder         *string              `json:"folder"`
	Suggestions    []IngestedSuggestion `json:"suggestions,omitempty"`
}

type IngestedDocumentsOutput struct {
	Documents []IngestedDocumentRow   `json:"documents,omitempty"`
	Vendors   []IngestedVendorRow     `json:"vendors,omitempty"`
	Document  *IngestedDocumentDetail `json:"document,omitempty"`
}

func ParseIngestedDocumentsInput(raw json.RawMessage) (IngestedDocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IngestedDocumentsInput{}, err
	}
	var input IngestedDocumentsInput
	if rawID, ok := fields["id"]; ok {
		var id string
		if err := json.Unmarshal(rawID, &id); err != nil || !isUUID(id) {
			return IngestedDocumentsInput{}, errors.New("id must be a UUID")
		}
		input.ID = &id
	}
	if rawPreview, ok := fields["preview"]; ok {
		if err := json.Unmarshal(rawPreview, &input.Preview); err != nil {
			return IngestedDocumentsInput{}, errors.New("preview must be a boolean")
		}
	}
	for key := range fields {
		if key != "id" && key != "preview" {
			return IngestedDocumentsInput{}, fmt.Errorf("unknown field %q", key)
		}
	}
	if input.ID == nil && input.Preview {
		return IngestedDocumentsInput{}, errors.New("preview requires id")
	}
	return input, nil
}

type ListAuthoredDocsInput struct{}

type AuthoredDocumentRow struct {
	ID                string  `json:"id"`
	Title             string  `json:"title"`
	Status            string  `json:"status"`
	Versions          int     `json:"versions"`
	TemplateID        *string `json:"templateId"`
	Folder            *string `json:"folder"`
	DocumentType      *string `json:"documentType"`
	LinkedRecordType  *string `json:"linkedRecordType"`
	LinkedRecordID    *string `json:"linkedRecordId"`
	LinkedRecordLabel *string `json:"linkedRecordLabel"`
	UpdatedAt         string  `json:"updatedAt"`
}

type ListAuthoredDocsOutput struct {
	Documents []AuthoredDocumentRow `json:"documents"`
}

func ParseListAuthoredDocsInput(raw json.RawMessage) (ListAuthoredDocsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListAuthoredDocsInput{}, err
	}
	return ListAuthoredDocsInput{}, nil
}

func listAuthoredDocs(ctx context.Context, tx pgx.Tx, orgID string) (ListAuthoredDocsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT d.id::text, d.title, d.status,
		       (SELECT count(*)::int FROM authored_doc_versions v
		        WHERE v.org_id = d.org_id AND v.document_id = d.id) AS versions,
		       d.template_id::text, d.folder, d.document_type, d.linked_record_type,
		       d.linked_record_id::text, d.linked_record_label, d.updated_at
		FROM authored_docs d
		WHERE d.org_id = $1::uuid
		ORDER BY d.updated_at DESC
		LIMIT 200`, orgID)
	if err != nil {
		return ListAuthoredDocsOutput{}, err
	}
	defer rows.Close()

	documents := make([]AuthoredDocumentRow, 0)
	for rows.Next() {
		var document AuthoredDocumentRow
		var updatedAt time.Time
		if err := rows.Scan(&document.ID, &document.Title, &document.Status, &document.Versions,
			&document.TemplateID, &document.Folder, &document.DocumentType, &document.LinkedRecordType,
			&document.LinkedRecordID, &document.LinkedRecordLabel, &updatedAt); err != nil {
			return ListAuthoredDocsOutput{}, err
		}
		document.UpdatedAt = updatedAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		return ListAuthoredDocsOutput{}, err
	}
	return ListAuthoredDocsOutput{Documents: documents}, nil
}

func readIngestedDocuments(ctx context.Context, tx pgx.Tx, orgID string, input IngestedDocumentsInput) (IngestedDocumentsOutput, error) {
	if input.ID != nil {
		var document IngestedDocumentDetail
		var createdAt time.Time
		err := tx.QueryRow(ctx, `
			SELECT id::text, title, status, source_type, mime_type, size_bytes, parse_error,
			       parsed_markdown, created_at, folder
			FROM documents
			WHERE org_id = $1::uuid AND id = $2::uuid
			LIMIT 1`, orgID, *input.ID).Scan(
			&document.ID, &document.Title, &document.Status, &document.SourceType, &document.MIMEType,
			&document.SizeBytes, &document.ParseError, &document.ParsedMarkdown, &createdAt, &document.Folder,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return IngestedDocumentsOutput{}, ErrIngestedDocumentNotFound
		}
		if err != nil {
			return IngestedDocumentsOutput{}, err
		}
		document.CreatedAt = formatDocumentTimestamp(createdAt)
		if !input.Preview {
			rows, err := tx.Query(ctx, `
				SELECT id::text, org_id::text, document_id::text, description,
				       quantity_thousandths, unit_price_minor, suggested_account_code,
				       match_score, matched_on, status, created_at
				FROM document_suggestions
				WHERE org_id = $1::uuid AND document_id = $2::uuid
				ORDER BY created_at DESC`, orgID, *input.ID)
			if err != nil {
				return IngestedDocumentsOutput{}, err
			}
			document.Suggestions = make([]IngestedSuggestion, 0)
			for rows.Next() {
				var suggestion IngestedSuggestion
				var suggestedAt time.Time
				if err := rows.Scan(&suggestion.ID, &suggestion.OrgID, &suggestion.DocumentID, &suggestion.Description,
					&suggestion.QuantityThousandths, &suggestion.UnitPriceMinor, &suggestion.SuggestedAccountCode,
					&suggestion.MatchScore, &suggestion.MatchedOn, &suggestion.Status, &suggestedAt); err != nil {
					rows.Close()
					return IngestedDocumentsOutput{}, err
				}
				suggestion.CreatedAt = formatDocumentTimestamp(suggestedAt)
				document.Suggestions = append(document.Suggestions, suggestion)
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return IngestedDocumentsOutput{}, err
			}
			rows.Close()
		}
		return IngestedDocumentsOutput{Document: &document}, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT id::text, title, status, source_type, created_at, folder
		FROM documents
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 100`, orgID)
	if err != nil {
		return IngestedDocumentsOutput{}, err
	}
	documents := make([]IngestedDocumentRow, 0)
	for rows.Next() {
		var document IngestedDocumentRow
		var createdAt time.Time
		if err := rows.Scan(&document.ID, &document.Title, &document.Status, &document.SourceType, &createdAt, &document.Folder); err != nil {
			rows.Close()
			return IngestedDocumentsOutput{}, err
		}
		document.CreatedAt = formatDocumentTimestamp(createdAt)
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return IngestedDocumentsOutput{}, err
	}
	rows.Close()

	vendorRows, err := tx.Query(ctx, `SELECT id::text, name FROM vendors WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return IngestedDocumentsOutput{}, err
	}
	vendors := make([]IngestedVendorRow, 0)
	for vendorRows.Next() {
		var vendor IngestedVendorRow
		if err := vendorRows.Scan(&vendor.ID, &vendor.Name); err != nil {
			vendorRows.Close()
			return IngestedDocumentsOutput{}, err
		}
		vendors = append(vendors, vendor)
	}
	if err := vendorRows.Err(); err != nil {
		vendorRows.Close()
		return IngestedDocumentsOutput{}, err
	}
	vendorRows.Close()
	return IngestedDocumentsOutput{Documents: documents, Vendors: vendors}, nil
}

func formatDocumentTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
