package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type CreateAuthoredDocumentOutput struct {
	DocumentID string `json:"documentId"`
}

type DocumentVersionOutput struct {
	Version int64 `json:"version"`
}

type DeleteAuthoredDocumentOutput struct {
	Deleted bool `json:"deleted"`
}

type AuthoredDocumentMetadata struct {
	Title             string  `json:"title"`
	Folder            *string `json:"folder"`
	LinkedRecordType  *string `json:"linkedRecordType"`
	LinkedRecordID    *string `json:"linkedRecordId"`
	LinkedRecordLabel *string `json:"linkedRecordLabel"`
}

type UpdateAuthoredDocumentMetadataOutput struct {
	DocumentID string                   `json:"documentId"`
	Previous   AuthoredDocumentMetadata `json:"previous"`
}

func parseAuthoredDocumentIDInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredUUID(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{DocumentID: &documentID}, nil
}

func parseIngestedVersionsDocumentIDInput(raw json.RawMessage) (DocumentsInput, error) {
	return parseAuthoredDocumentIDInput(raw)
}

func parseCreateAuthoredDocumentInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	title, err := documentsRequiredString(fields, "title", 1, 200)
	if err != nil {
		return DocumentsInput{}, err
	}
	content, err := documentsRequiredContentObject(fields, "content")
	if err != nil {
		return DocumentsInput{}, err
	}
	html, err := documentsRequiredString(fields, "html", 0, documentsMaxHTMLLength)
	if err != nil {
		return DocumentsInput{}, err
	}
	templateID, err := documentsOptionalUUID(fields, "templateId")
	if err != nil {
		return DocumentsInput{}, err
	}
	folder, err := documentsNonNullableString(fields, "folder", 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentType, err := documentsOptionalString(fields, "documentType", 0, 60)
	if err != nil {
		return DocumentsInput{}, err
	}
	linkedRecordType, err := documentsOptionalString(fields, "linkedRecordType", 0, 60)
	if err != nil {
		return DocumentsInput{}, err
	}
	linkedRecordID, err := documentsOptionalUUID(fields, "linkedRecordId")
	if err != nil {
		return DocumentsInput{}, err
	}
	linkedRecordLabel, err := documentsOptionalString(fields, "linkedRecordLabel", 0, 240)
	if err != nil {
		return DocumentsInput{}, err
	}
	pageSettings, err := documentsPageSettingsInput(fields)
	if err != nil {
		return DocumentsInput{}, err
	}
	intentID, err := documentsPlainString(fields, "intentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{
		Title:             &title,
		Content:           content,
		HTML:              &html,
		TemplateID:        templateID,
		Folder:            folder,
		DocumentType:      documentType,
		LinkedRecordType:  documentsPresentValue(linkedRecordType),
		LinkedRecordID:    documentsPresentValue(linkedRecordID),
		LinkedRecordLabel: documentsPresentValue(linkedRecordLabel),
		PageSettings:      pageSettings,
		IntentID:          intentID,
	}, nil
}

func parseSaveDocVersionInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredUUID(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	title, err := documentsOptionalString(fields, "title", 1, 200)
	if err != nil {
		return DocumentsInput{}, err
	}
	content, err := documentsRequiredContentObject(fields, "content")
	if err != nil {
		return DocumentsInput{}, err
	}
	html, err := documentsRequiredString(fields, "html", 0, documentsMaxHTMLLength)
	if err != nil {
		return DocumentsInput{}, err
	}
	note, err := documentsOptionalString(fields, "note", 0, 500)
	if err != nil {
		return DocumentsInput{}, err
	}
	pageSettings, err := documentsPageSettingsInput(fields)
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{
		DocumentID:   &documentID,
		Title:        title,
		Content:      content,
		HTML:         &html,
		Note:         note,
		PageSettings: pageSettings,
	}, nil
}

func parseRestoreDocVersionInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredUUID(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	sourceVersion, err := documentsBoundedInteger(fields, "sourceVersion", 1, maxSafeInteger)
	if err != nil {
		return DocumentsInput{}, err
	}
	note, err := documentsOptionalString(fields, "note", 0, 500)
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{DocumentID: &documentID, SourceVersion: &sourceVersion, Note: note}, nil
}

func parseUpdateDocMetadataInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredUUID(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	title, err := documentsOptionalString(fields, "title", 1, 200)
	if err != nil {
		return DocumentsInput{}, err
	}
	folder, err := documentsReadNullableString(fields, "folder", 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	linkedRecordType, err := documentsReadNullableString(fields, "linkedRecordType", 60)
	if err != nil {
		return DocumentsInput{}, err
	}
	linkedRecordID, err := documentsReadNullableUUID(fields, "linkedRecordId")
	if err != nil {
		return DocumentsInput{}, err
	}
	linkedRecordLabel, err := documentsReadNullableString(fields, "linkedRecordLabel", 240)
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{
		DocumentID:        &documentID,
		Title:             title,
		Folder:            folder,
		LinkedRecordType:  linkedRecordType,
		LinkedRecordID:    linkedRecordID,
		LinkedRecordLabel: linkedRecordLabel,
	}, nil
}

// documentsPresentValue lifts a non-nullable optional string into the shared
// tri-state shape, where "present and set" is the only populated case.
func documentsPresentValue(value *string) *documentsNullableString {
	if value == nil {
		return nil
	}
	return &documentsNullableString{Present: true, Value: *value}
}

// documentsReadNullableUUID reads a `z.string().uuid().nullable().optional()`
// field, where an explicit null clears the stored link.
func documentsReadNullableUUID(fields map[string]json.RawMessage, key string) (*documentsNullableString, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	var value documentsNullableString
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, errors.New(key + " must be a UUID")
	}
	if value.Nulled {
		return &value, nil
	}
	if !isZodUUID(value.Value) {
		return nil, errors.New(key + " must be a UUID")
	}
	return &value, nil
}

func createAuthoredDocument(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (CreateAuthoredDocumentOutput, error) {
	if input.TemplateID != nil {
		var templateID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM doc_templates
			WHERE org_id = $1::uuid AND id = $2::uuid
			LIMIT 1`, claims.OrganizationID, *input.TemplateID).Scan(&templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateAuthoredDocumentOutput{}, rejectDocuments("template not found")
		}
		if err != nil {
			return CreateAuthoredDocumentOutput{}, err
		}
	}

	folder := documentsNullableTextValue(input.Folder)
	pageSettings := any(nil)
	if input.PageSettings != nil {
		encoded, err := json.Marshal(input.PageSettings)
		if err != nil {
			return CreateAuthoredDocumentOutput{}, err
		}
		pageSettings = encoded
	}

	var documentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO authored_docs (
			org_id, title, content_json, html, status, template_id, folder, document_type,
			linked_record_type, linked_record_id, linked_record_label, page_settings,
			created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, 'draft', $5::uuid, $6, $7, $8, $9::uuid, $10, $11, $12, $13::uuid)
		RETURNING id::text`,
		claims.OrganizationID, *input.Title, []byte(input.Content), *input.HTML, input.TemplateID,
		folder, input.DocumentType, documentsPlainNullableText(input.LinkedRecordType),
		documentsPlainNullableText(input.LinkedRecordID), documentsPlainNullableText(input.LinkedRecordLabel),
		pageSettings, claims.ActorType, claims.ActorID).Scan(&documentID); err != nil {
		return CreateAuthoredDocumentOutput{}, err
	}
	return CreateAuthoredDocumentOutput{DocumentID: documentID}, nil
}

func deleteAuthoredDocument(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (DeleteAuthoredDocumentOutput, error) {
	command, err := tx.Exec(ctx, `
		DELETE FROM authored_docs WHERE org_id = $1::uuid AND id = $2::uuid`, claims.OrganizationID, *input.DocumentID)
	if err != nil {
		return DeleteAuthoredDocumentOutput{}, err
	}
	return DeleteAuthoredDocumentOutput{Deleted: command.RowsAffected() > 0}, nil
}

// saveAuthoredDocumentVersion publishes the current draft: the content that
// was there is snapshotted into the append-only history, then the supplied
// content becomes current. The advisory lock serializes concurrent publishes
// so two callers cannot claim the same version number.
func saveAuthoredDocumentVersion(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput, now time.Time) (DocumentVersionOutput, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 71))`, *input.DocumentID); err != nil {
		return DocumentVersionOutput{}, err
	}
	var (
		content      []byte
		html         string
		pageSettings []byte
		title        string
	)
	if err := tx.QueryRow(ctx, `
		SELECT content_json, html, page_settings, title
		FROM authored_docs
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).Scan(&content, &html, &pageSettings, &title); errors.Is(err, pgx.ErrNoRows) {
		return DocumentVersionOutput{}, rejectDocuments("document not found")
	} else if err != nil {
		return DocumentVersionOutput{}, err
	}

	next, err := documentsNextAuthoredVersion(ctx, tx, claims.OrganizationID, *input.DocumentID)
	if err != nil {
		return DocumentVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO authored_doc_versions (
			org_id, document_id, version, content_json, html, page_settings, note,
			created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid)`,
		claims.OrganizationID, *input.DocumentID, next, content, html, pageSettings,
		input.Note, claims.ActorType, claims.ActorID); err != nil {
		return DocumentVersionOutput{}, err
	}

	nextTitle := title
	if input.Title != nil {
		nextTitle = *input.Title
	}
	nextPageSettings := pageSettings
	if input.PageSettings != nil {
		encoded, err := json.Marshal(input.PageSettings)
		if err != nil {
			return DocumentVersionOutput{}, err
		}
		nextPageSettings = encoded
	}
	if _, err := tx.Exec(ctx, `
		UPDATE authored_docs
		SET title = $3, content_json = $4, html = $5, status = 'published', page_settings = $6, updated_at = $7
		WHERE org_id = $1::uuid AND id = $2::uuid`,
		claims.OrganizationID, *input.DocumentID, nextTitle, []byte(input.Content),
		*input.HTML, nextPageSettings, now); err != nil {
		return DocumentVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM doc_drafts WHERE org_id = $1::uuid AND document_id = $2::uuid`,
		claims.OrganizationID, *input.DocumentID); err != nil {
		return DocumentVersionOutput{}, err
	}
	return DocumentVersionOutput{Version: next}, nil
}

// restoreAuthoredDocumentVersion never destroys: it snapshots the current
// content as a new version and then makes the chosen older version current.
func restoreAuthoredDocumentVersion(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput, now time.Time) (DocumentVersionOutput, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 71))`, *input.DocumentID); err != nil {
		return DocumentVersionOutput{}, err
	}
	var (
		content      []byte
		html         string
		pageSettings []byte
	)
	if err := tx.QueryRow(ctx, `
		SELECT content_json, html, page_settings
		FROM authored_docs
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).Scan(&content, &html, &pageSettings); errors.Is(err, pgx.ErrNoRows) {
		return DocumentVersionOutput{}, rejectDocuments("document not found")
	} else if err != nil {
		return DocumentVersionOutput{}, err
	}

	var (
		sourceContent      []byte
		sourceHTML         string
		sourcePageSettings []byte
	)
	if err := tx.QueryRow(ctx, `
		SELECT content_json, html, page_settings
		FROM authored_doc_versions
		WHERE org_id = $1::uuid AND document_id = $2::uuid AND version = $3
		LIMIT 1`, claims.OrganizationID, *input.DocumentID, *input.SourceVersion).
		Scan(&sourceContent, &sourceHTML, &sourcePageSettings); errors.Is(err, pgx.ErrNoRows) {
		return DocumentVersionOutput{}, rejectDocuments("no version %d", *input.SourceVersion)
	} else if err != nil {
		return DocumentVersionOutput{}, err
	}

	next, err := documentsNextAuthoredVersion(ctx, tx, claims.OrganizationID, *input.DocumentID)
	if err != nil {
		return DocumentVersionOutput{}, err
	}
	note := input.Note
	if note == nil {
		fallback := "Restored from version " + strconv.FormatInt(*input.SourceVersion, 10)
		note = &fallback
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO authored_doc_versions (
			org_id, document_id, version, content_json, html, page_settings, note,
			created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid)`,
		claims.OrganizationID, *input.DocumentID, next, content, html, pageSettings,
		note, claims.ActorType, claims.ActorID); err != nil {
		return DocumentVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE authored_docs
		SET content_json = $3, html = $4, page_settings = $5, status = 'published', updated_at = $6
		WHERE org_id = $1::uuid AND id = $2::uuid`,
		claims.OrganizationID, *input.DocumentID, sourceContent, sourceHTML, sourcePageSettings, now); err != nil {
		return DocumentVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM doc_drafts WHERE org_id = $1::uuid AND document_id = $2::uuid`,
		claims.OrganizationID, *input.DocumentID); err != nil {
		return DocumentVersionOutput{}, err
	}
	return DocumentVersionOutput{Version: next}, nil
}

func documentsNextAuthoredVersion(ctx context.Context, tx pgx.Tx, orgID, documentID string) (int64, error) {
	var current int64
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(max(version), 0) FROM authored_doc_versions
		WHERE org_id = $1::uuid AND document_id = $2::uuid`, orgID, documentID).Scan(&current); err != nil {
		return 0, err
	}
	return current + 1, nil
}

func updateAuthoredDocumentMetadata(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput, now time.Time) (UpdateAuthoredDocumentMetadataOutput, error) {
	var previous AuthoredDocumentMetadata
	if err := tx.QueryRow(ctx, `
		SELECT title, folder, linked_record_type, linked_record_id::text, linked_record_label
		FROM authored_docs
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).
		Scan(&previous.Title, &previous.Folder, &previous.LinkedRecordType,
			&previous.LinkedRecordID, &previous.LinkedRecordLabel); errors.Is(err, pgx.ErrNoRows) {
		return UpdateAuthoredDocumentMetadataOutput{}, rejectDocuments("document not found")
	} else if err != nil {
		return UpdateAuthoredDocumentMetadataOutput{}, err
	}

	title := previous.Title
	if input.Title != nil {
		title = strings.TrimFunc(*input.Title, isJSWhitespace)
	}
	folder := previous.Folder
	if input.Folder != nil && input.Folder.Present {
		folder = documentsNullableTextValue(input.Folder)
	}
	linkedRecordType := previous.LinkedRecordType
	if input.LinkedRecordType != nil && input.LinkedRecordType.Present {
		linkedRecordType = documentsNullableTextValue(input.LinkedRecordType)
	}
	linkedRecordID := previous.LinkedRecordID
	if input.LinkedRecordID != nil && input.LinkedRecordID.Present {
		linkedRecordID = documentsNullableTextValue(input.LinkedRecordID)
	}
	linkedRecordLabel := previous.LinkedRecordLabel
	if input.LinkedRecordLabel != nil && input.LinkedRecordLabel.Present {
		linkedRecordLabel = documentsNullableTextValue(input.LinkedRecordLabel)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE authored_docs
		SET title = $3, folder = $4, linked_record_type = $5, linked_record_id = $6::uuid,
		    linked_record_label = $7, updated_at = $8
		WHERE org_id = $1::uuid AND id = $2::uuid`,
		claims.OrganizationID, *input.DocumentID, title, folder, linkedRecordType,
		linkedRecordID, linkedRecordLabel, now); err != nil {
		return UpdateAuthoredDocumentMetadataOutput{}, err
	}
	return UpdateAuthoredDocumentMetadataOutput{DocumentID: *input.DocumentID, Previous: previous}, nil
}

// documentsNullableTextValue resolves a folder field: an empty or
// whitespace-only path normalizes to no folder at all, matching the
// TypeScript `normalizeFolderPath(input.folder) || null` rule.
// documentsPlainNullableText lifts a link field to a text column without the
// folder normalization, which only applies to the folder path.
func documentsPlainNullableText(value *documentsNullableString) *string {
	if value == nil || value.Nulled {
		return nil
	}
	return stringPointer(value.Value)
}

func documentsNullableTextValue(value *documentsNullableString) *string {
	if value == nil || value.Nulled {
		return nil
	}
	normalized := NormalizeDocumentFolderPath(value.Value)
	if normalized == "" {
		return nil
	}
	return stringPointer(normalized)
}
