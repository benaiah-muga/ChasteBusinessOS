package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	documentsListDocVersionsCapabilityID = "documents.listDocVersions"
	documentsGetDocVersionCapabilityID   = "documents.getDocVersion"
)

var ErrDocumentVersionNotFound = errors.New("document version not found")

type DocumentVersionIDInput struct {
	DocumentID string `json:"documentId"`
	Version    int64  `json:"version"`
}

type ListDocumentVersionsInput struct {
	DocumentID string `json:"documentId"`
}

type DocumentVersionSummary struct {
	Version   int64   `json:"version"`
	Note      *string `json:"note"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt string  `json:"createdAt"`
}

type ListDocumentVersionsOutput struct {
	Versions []DocumentVersionSummary `json:"versions"`
}

type GetDocumentVersionOutput struct {
	Version   int64           `json:"version"`
	Content   json.RawMessage `json:"content"`
	HTML      string          `json:"html"`
	Note      *string         `json:"note"`
	CreatedAt string          `json:"createdAt"`
}

func ParseDocumentVersionIDInput(raw json.RawMessage) (DocumentVersionIDInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentVersionIDInput{}, err
	}
	var input DocumentVersionIDInput
	if input.DocumentID, err = projectRequiredUUID(fields, "documentId"); err != nil {
		return DocumentVersionIDInput{}, err
	}
	if input.Version, err = requiredSafeInteger(fields, "version"); err != nil {
		return DocumentVersionIDInput{}, err
	}
	if input.Version < 1 {
		return DocumentVersionIDInput{}, errors.New("version must be at least 1")
	}
	return input, nil
}

func ParseListDocumentVersionsInput(raw json.RawMessage) (ListDocumentVersionsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListDocumentVersionsInput{}, err
	}
	documentID, err := projectRequiredUUID(fields, "documentId")
	if err != nil {
		return ListDocumentVersionsInput{}, err
	}
	return ListDocumentVersionsInput{DocumentID: documentID}, nil
}

func parseDocumentVersionInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case documentsListDocVersionsCapabilityID:
		return ParseListDocumentVersionsInput(raw)
	case documentsGetDocVersionCapabilityID:
		return ParseDocumentVersionIDInput(raw)
	default:
		return nil, errors.New("unsupported document version capability")
	}
}

func listDocumentVersions(ctx context.Context, tx pgx.Tx, orgID string, input ListDocumentVersionsInput) (ListDocumentVersionsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT version, note, created_by_actor_type, created_by_actor_id, created_at
		FROM authored_doc_versions
		WHERE org_id = $1::uuid AND document_id = $2::uuid
		ORDER BY version ASC`, orgID, input.DocumentID)
	if err != nil {
		return ListDocumentVersionsOutput{}, err
	}
	defer rows.Close()
	versions := make([]DocumentVersionSummary, 0)
	for rows.Next() {
		var version DocumentVersionSummary
		var actorType string
		var actorID *string
		var createdAt time.Time
		if err := rows.Scan(&version.Version, &version.Note, &actorType, &actorID, &createdAt); err != nil {
			return ListDocumentVersionsOutput{}, err
		}
		if actorType == "agent" {
			version.CreatedBy = stringPointer("workmate")
		} else {
			version.CreatedBy = actorID
		}
		version.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return ListDocumentVersionsOutput{}, err
	}
	return ListDocumentVersionsOutput{Versions: versions}, nil
}

func getDocumentVersion(ctx context.Context, tx pgx.Tx, orgID string, input DocumentVersionIDInput) (GetDocumentVersionOutput, error) {
	var output GetDocumentVersionOutput
	var createdAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT version, content_json, html, note, created_at
		FROM authored_doc_versions
		WHERE org_id = $1::uuid AND document_id = $2::uuid AND version = $3
		LIMIT 1`, orgID, input.DocumentID, input.Version).
		Scan(&output.Version, &output.Content, &output.HTML, &output.Note, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return GetDocumentVersionOutput{}, fmt.Errorf("no version %d: %w", input.Version, ErrDocumentVersionNotFound)
	}
	if err != nil {
		return GetDocumentVersionOutput{}, err
	}
	output.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	return output, nil
}
