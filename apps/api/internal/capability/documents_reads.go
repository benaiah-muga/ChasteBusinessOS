package capability

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

const documentsListDocsCapabilityID = "documents.listDocs"

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
