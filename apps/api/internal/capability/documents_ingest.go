package capability

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type IngestDocumentOutput struct {
	DocumentID string `json:"documentId"`
}

type DeleteIngestedDocumentOutput struct {
	Deleted bool `json:"deleted"`
}

type IngestedDocumentSummary struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Status          string `json:"status"`
	SourceType      string `json:"sourceType"`
	OpenSuggestions int64  `json:"openSuggestions"`
	CreatedAt       string `json:"createdAt"`
}

type ListIngestedDocumentsOutput struct {
	Documents []IngestedDocumentSummary `json:"documents"`
}

type IngestedDocumentVersionSummary struct {
	Version   int64   `json:"version"`
	Note      *string `json:"note"`
	CreatedAt string  `json:"createdAt"`
}

type ListIngestedDocumentVersionsOutput struct {
	Versions []IngestedDocumentVersionSummary `json:"versions"`
}

type DeleteOrgMemoryOutput struct {
	Deleted bool   `json:"deleted"`
	Kind    string `json:"kind"`
}

func parseIngestedDocumentIDInput(raw json.RawMessage) (DocumentsInput, error) {
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

func parseIngestDocumentInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	title, err := documentsRequiredString(fields, "title", 1, 200)
	if err != nil {
		return DocumentsInput{}, err
	}
	folder, err := documentsNonNullableString(fields, "folder", 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	refType, err := documentsOptionalString(fields, "refType", 0, 40)
	if err != nil {
		return DocumentsInput{}, err
	}
	refID, err := documentsOptionalUUID(fields, "refId")
	if err != nil {
		return DocumentsInput{}, err
	}
	expiresAt, err := documentsDateTime(fields, "expiresAt")
	if err != nil {
		return DocumentsInput{}, err
	}
	text, err := documentsOptionalString(fields, "text", 1, 100_000)
	if err != nil {
		return DocumentsInput{}, err
	}
	fileBase64, err := documentsOptionalString(fields, "fileBase64", 0, documentsMaxUploadBase64)
	if err != nil {
		return DocumentsInput{}, err
	}
	mimeType, err := documentsOptionalString(fields, "mimeType", 0, documentsUnbounded)
	if err != nil {
		return DocumentsInput{}, err
	}
	if mimeType != nil && !documentsMIMETypePattern.MatchString(*mimeType) {
		return DocumentsInput{}, errors.New("mimeType is invalid")
	}
	// Zod's refine: exactly one of text or fileBase64, and an upload carries
	// its mime type. The string length cap is a character count there, while
	// the manifest converts the same rule to a byte-free maxLength; the
	// decoded-size check below is the one that actually bounds the upload.
	if (text == nil) == (fileBase64 == nil) {
		return DocumentsInput{}, errors.New("provide exactly one of text or fileBase64")
	}
	if fileBase64 != nil && mimeType == nil {
		return DocumentsInput{}, errors.New("uploads need a mime type")
	}
	return DocumentsInput{
		Title:      &title,
		Text:       text,
		FileBase64: fileBase64,
		MIMEType:   mimeType,
		RefType:    refType,
		RefID:      refID,
		ExpiresAt:  expiresAt,
		Folder:     folder,
	}, nil
}

func parseDeleteOrgMemoryInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	memoryID, err := documentsRequiredUUID(fields, "memoryId")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{MemoryID: &memoryID}, nil
}

func parseAddDocumentVersionInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredUUID(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	contentBase64, err := documentsPlainString(fields, "contentBase64")
	if err != nil {
		return DocumentsInput{}, err
	}
	rawText, err := documentsPlainString(fields, "rawText")
	if err != nil {
		return DocumentsInput{}, err
	}
	note, err := documentsOptionalString(fields, "note", 0, 500)
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{DocumentID: &documentID, ContentBase64: contentBase64, RawText: rawText, Note: note}, nil
}

func ingestDocument(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (IngestDocumentOutput, error) {
	var (
		sizeBytes  *int64
		sourceType = "text"
		contentB64 *string
		rawText    *string
		folder     *string
		expiresAt  *time.Time
	)
	if input.FileBase64 != nil {
		sourceType = "upload"
		contentB64 = input.FileBase64
		// Math.floor(length * 3 / 4) is the decoded size estimate the module
		// uses, so the 5MB ceiling is enforced before anything is stored.
		decoded := int64(float64(len(*input.FileBase64)) * 3 / 4)
		if decoded > documentsMaxUploadBytes {
			return IngestDocumentOutput{}, rejectDocuments("file exceeds the 5MB limit")
		}
		sizeBytes = &decoded
	}
	if input.Text != nil {
		rawText = input.Text
	}
	if input.Folder != nil && input.Folder.Present && !input.Folder.Nulled {
		folder = stringPointer(input.Folder.Value)
	}
	if input.ExpiresAt != nil {
		parsed, err := parseProjectDateTime(*input.ExpiresAt)
		if err != nil {
			return IngestDocumentOutput{}, rejectDocuments("expiresAt must be an ISO datetime")
		}
		expiresAt = &parsed
	}

	var documentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO documents (
			org_id, title, source_type, mime_type, size_bytes, content_base64, raw_text,
			created_by_actor_type, created_by_actor_id, folder, ref_type, ref_id, expires_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12::uuid, $13)
		RETURNING id::text`,
		claims.OrganizationID, *input.Title, sourceType, input.MIMEType, sizeBytes,
		contentB64, rawText, claims.ActorType, claims.ActorID, folder,
		input.RefType, input.RefID, expiresAt).Scan(&documentID); err != nil {
		return IngestDocumentOutput{}, err
	}
	return IngestDocumentOutput{DocumentID: documentID}, nil
}

func deleteIngestedDocument(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (DeleteIngestedDocumentOutput, error) {
	command, err := tx.Exec(ctx, `
		DELETE FROM documents WHERE org_id = $1::uuid AND id = $2::uuid`, claims.OrganizationID, *input.DocumentID)
	if err != nil {
		return DeleteIngestedDocumentOutput{}, err
	}
	return DeleteIngestedDocumentOutput{Deleted: command.RowsAffected() > 0}, nil
}

func listIngestedDocuments(ctx context.Context, tx pgx.Tx, orgID string) (ListIngestedDocumentsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT d.id::text, d.title, d.status, d.source_type, d.created_at,
		       (SELECT count(*)::int FROM document_suggestions s
		        WHERE s.org_id = d.org_id AND s.document_id = d.id AND s.status = 'open')
		FROM documents d
		WHERE d.org_id = $1::uuid
		ORDER BY d.created_at DESC
		LIMIT 100`, orgID)
	if err != nil {
		return ListIngestedDocumentsOutput{}, err
	}
	defer rows.Close()
	documents := make([]IngestedDocumentSummary, 0)
	for rows.Next() {
		var document IngestedDocumentSummary
		var createdAt time.Time
		if err := rows.Scan(&document.ID, &document.Title, &document.Status, &document.SourceType,
			&createdAt, &document.OpenSuggestions); err != nil {
			return ListIngestedDocumentsOutput{}, err
		}
		document.CreatedAt = formatDocumentTimestamp(createdAt)
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		return ListIngestedDocumentsOutput{}, err
	}
	return ListIngestedDocumentsOutput{Documents: documents}, nil
}

// addDocumentVersion archives the content the document holds now and installs
// the supplied content as the new current state.
func addDocumentVersion(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput, now time.Time) (DocumentVersionOutput, error) {
	var (
		currentBase64 *string
		currentText   *string
	)
	err := tx.QueryRow(ctx, `
		SELECT content_base64, raw_text FROM documents
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).Scan(&currentBase64, &currentText)
	if errors.Is(err, pgx.ErrNoRows) {
		return DocumentVersionOutput{}, rejectDocuments("document not found")
	}
	if err != nil {
		return DocumentVersionOutput{}, err
	}
	if (input.ContentBase64 == nil || *input.ContentBase64 == "") && (input.RawText == nil || *input.RawText == "") {
		return DocumentVersionOutput{}, rejectDocuments("a version needs contentBase64 or rawText")
	}

	var current int64
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(max(version), 0) FROM document_versions
		WHERE org_id = $1::uuid AND document_id = $2::uuid`, claims.OrganizationID, *input.DocumentID).Scan(&current); err != nil {
		return DocumentVersionOutput{}, err
	}
	next := current + 1
	if _, err := tx.Exec(ctx, `
		INSERT INTO document_versions (
			org_id, document_id, version, content_base64, raw_text, note,
			created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)`,
		claims.OrganizationID, *input.DocumentID, next, currentBase64, currentText,
		input.Note, claims.ActorType, claims.ActorID); err != nil {
		return DocumentVersionOutput{}, err
	}

	nextBase64 := currentBase64
	if input.ContentBase64 != nil {
		nextBase64 = input.ContentBase64
	}
	nextText := currentText
	if input.RawText != nil {
		nextText = input.RawText
	}
	if _, err := tx.Exec(ctx, `
		UPDATE documents
		SET content_base64 = $3, raw_text = $4, updated_at = $5
		WHERE org_id = $1::uuid AND id = $2::uuid`,
		claims.OrganizationID, *input.DocumentID, nextBase64, nextText, now); err != nil {
		return DocumentVersionOutput{}, err
	}
	return DocumentVersionOutput{Version: next}, nil
}

func listIngestedDocumentVersions(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (ListIngestedDocumentVersionsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT version, note, created_at FROM document_versions
		WHERE org_id = $1::uuid AND document_id = $2::uuid
		ORDER BY version`, claims.OrganizationID, *input.DocumentID)
	if err != nil {
		return ListIngestedDocumentVersionsOutput{}, err
	}
	defer rows.Close()
	versions := make([]IngestedDocumentVersionSummary, 0)
	for rows.Next() {
		var version IngestedDocumentVersionSummary
		var createdAt time.Time
		if err := rows.Scan(&version.Version, &version.Note, &createdAt); err != nil {
			return ListIngestedDocumentVersionsOutput{}, err
		}
		version.CreatedAt = formatDocumentTimestamp(createdAt)
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return ListIngestedDocumentVersionsOutput{}, err
	}
	return ListIngestedDocumentVersionsOutput{Versions: versions}, nil
}

func deleteOrgMemory(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (DeleteOrgMemoryOutput, error) {
	var kind string
	if err := tx.QueryRow(ctx, `
		SELECT kind FROM memories
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.MemoryID).Scan(&kind); errors.Is(err, pgx.ErrNoRows) {
		return DeleteOrgMemoryOutput{}, rejectDocuments("memory entry not found")
	} else if err != nil {
		return DeleteOrgMemoryOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM memories WHERE org_id = $1::uuid AND id = $2::uuid`, claims.OrganizationID, *input.MemoryID); err != nil {
		return DeleteOrgMemoryOutput{}, err
	}
	return DeleteOrgMemoryOutput{Deleted: true, Kind: kind}, nil
}
