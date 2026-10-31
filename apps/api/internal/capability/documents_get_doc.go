package capability

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type GetAuthoredDocumentOutput struct {
	Document AuthoredDocumentDetail `json:"document"`
}

type AuthoredDocumentDetail struct {
	ID                string                `json:"id"`
	Title             string                `json:"title"`
	Status            string                `json:"status"`
	Content           json.RawMessage       `json:"content"`
	HTML              string                `json:"html"`
	TemplateID        *string               `json:"templateId"`
	Folder            *string               `json:"folder"`
	DocumentType      *string               `json:"documentType"`
	LinkedRecordType  *string               `json:"linkedRecordType"`
	LinkedRecordID    *string               `json:"linkedRecordId"`
	LinkedRecordLabel *string               `json:"linkedRecordLabel"`
	PageSettings      DocumentsPageSettings `json:"pageSettings"`
	Versions          int                   `json:"versions"`
	UpdatedAt         string                `json:"updatedAt"`
}

func parseGetAuthoredDocumentInput(raw json.RawMessage) (DocumentsInput, error) {
	return parseAuthoredDocumentIDInput(raw)
}

func getAuthoredDocument(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (GetAuthoredDocumentOutput, error) {
	if input.DocumentID == nil {
		return GetAuthoredDocumentOutput{}, rejectDocuments("documentId is required")
	}

	var (
		document  AuthoredDocumentDetail
		content   []byte
		settings  []byte
		updatedAt time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT d.id::text, d.title, d.status, d.content_json, d.html,
		       d.template_id::text, d.folder, d.document_type, d.linked_record_type,
		       d.linked_record_id::text, d.linked_record_label, d.page_settings,
		       (SELECT count(*)::int FROM authored_doc_versions v
		        WHERE v.org_id = d.org_id AND v.document_id = d.id),
		       d.updated_at
		FROM authored_docs d
		WHERE d.org_id = $1::uuid AND d.id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).Scan(
		&document.ID, &document.Title, &document.Status, &content, &document.HTML,
		&document.TemplateID, &document.Folder, &document.DocumentType, &document.LinkedRecordType,
		&document.LinkedRecordID, &document.LinkedRecordLabel, &settings, &document.Versions,
		&updatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return GetAuthoredDocumentOutput{}, rejectDocuments("document not found")
	}
	if err != nil {
		return GetAuthoredDocumentOutput{}, err
	}

	if _, err := decodeJSONObject(json.RawMessage(content)); err != nil {
		return GetAuthoredDocumentOutput{}, rejectDocuments("document content is invalid")
	}
	document.Content = json.RawMessage(content)
	pageSettings, err := parseAuthoredDocumentPageSettings(settings)
	if err != nil {
		return GetAuthoredDocumentOutput{}, rejectDocuments("document page settings are invalid")
	}
	document.PageSettings = pageSettings
	document.UpdatedAt = updatedAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	return GetAuthoredDocumentOutput{Document: document}, nil
}

func parseAuthoredDocumentPageSettings(raw []byte) (DocumentsPageSettings, error) {
	parsed, err := documentsPageSettingsInput(map[string]json.RawMessage{"pageSettings": json.RawMessage(raw)})
	if err != nil || parsed == nil {
		return DocumentsPageSettings{}, errors.New("invalid page settings")
	}
	return *parsed, nil
}
