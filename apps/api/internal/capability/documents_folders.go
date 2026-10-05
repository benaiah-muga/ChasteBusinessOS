package capability

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

// NormalizeDocumentFolderPath mirrors the module's normalizeFolderPath: split
// on runs of slashes or backslashes, trim each segment, drop empties, join
// with "/", then truncate to 300 UTF-16 code units like JavaScript's slice.
func NormalizeDocumentFolderPath(value string) string {
	parts := strings.FieldsFunc(value, func(char rune) bool { return char == '/' || char == '\\' })
	segments := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimFunc(part, isJSWhitespace)
		if trimmed != "" {
			segments = append(segments, trimmed)
		}
	}
	joined := strings.Join(segments, "/")
	units := utf16.Encode([]rune(joined))
	if len(units) <= 300 {
		return joined
	}
	return string(utf16.Decode(units[:300]))
}

type DocumentFolderRow struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type ListDocumentFoldersOutput struct {
	Folders []DocumentFolderRow `json:"folders"`
}

type CreateDocumentFolderOutput struct {
	FolderID string `json:"folderId"`
	Path     string `json:"path"`
}

type DeleteDocumentFolderOutput struct {
	Deleted bool   `json:"deleted"`
	Path    string `json:"path"`
}

type RenameDocumentFolderOutput struct {
	Path    string `json:"path"`
	MovedTo string `json:"movedTo"`
}

func parseFolderPathInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	path, err := documentsRequiredString(fields, "path", 1, 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{Path: &path}, nil
}

func parseRenameFolderInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	path, err := documentsRequiredString(fields, "path", 1, 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	newPath, err := documentsRequiredString(fields, "newPath", 1, 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{Path: &path, NewPath: &newPath}, nil
}

func listDocumentFolders(ctx context.Context, tx pgx.Tx, orgID string) (ListDocumentFoldersOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, path FROM doc_folders
		WHERE org_id = $1::uuid
		ORDER BY path`, orgID)
	if err != nil {
		return ListDocumentFoldersOutput{}, err
	}
	defer rows.Close()
	folders := make([]DocumentFolderRow, 0)
	for rows.Next() {
		var folder DocumentFolderRow
		if err := rows.Scan(&folder.ID, &folder.Path); err != nil {
			return ListDocumentFoldersOutput{}, err
		}
		folders = append(folders, folder)
	}
	if err := rows.Err(); err != nil {
		return ListDocumentFoldersOutput{}, err
	}
	return ListDocumentFoldersOutput{Folders: folders}, nil
}

// createDocumentFolder materializes every ancestor segment so a deep path
// always has a navigable parent, matching the TypeScript upsert of all paths.
func createDocumentFolder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (CreateDocumentFolderOutput, error) {
	path := NormalizeDocumentFolderPath(*input.Path)
	if path == "" {
		return CreateDocumentFolderOutput{}, rejectDocuments("folder name is required")
	}
	var existing string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM doc_folders
		WHERE org_id = $1::uuid AND path = $2
		LIMIT 1`, claims.OrganizationID, path).Scan(&existing)
	if err == nil {
		return CreateDocumentFolderOutput{}, rejectDocuments("a folder with that path already exists")
	}
	if err != pgx.ErrNoRows {
		return CreateDocumentFolderOutput{}, err
	}

	segments := strings.Split(path, "/")
	paths := make([]string, 0, len(segments))
	for index := range segments {
		paths = append(paths, strings.Join(segments[:index+1], "/"))
	}
	for _, ancestor := range paths {
		if _, err := tx.Exec(ctx, `
			INSERT INTO doc_folders (org_id, path, created_by_actor_type, created_by_actor_id)
			VALUES ($1::uuid, $2, $3, $4::uuid)
			ON CONFLICT (org_id, path) DO NOTHING`,
			claims.OrganizationID, ancestor, claims.ActorType, claims.ActorID); err != nil {
			return CreateDocumentFolderOutput{}, err
		}
	}

	var folderID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM doc_folders
		WHERE org_id = $1::uuid AND path = $2
		LIMIT 1`, claims.OrganizationID, path).Scan(&folderID); err != nil {
		return CreateDocumentFolderOutput{}, err
	}
	return CreateDocumentFolderOutput{FolderID: folderID, Path: path}, nil
}

// deleteDocumentFolder refuses to orphan anything: a folder that still holds
// documents or parent folders must be emptied first.
func deleteDocumentFolder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (DeleteDocumentFolderOutput, error) {
	path := NormalizeDocumentFolderPath(*input.Path)
	nested := path + "/%"

	var used bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM authored_docs
			WHERE org_id = $1::uuid AND (folder = $2 OR folder ILIKE $3)
			LIMIT 1)`, claims.OrganizationID, path, nested).Scan(&used); err != nil {
		return DeleteDocumentFolderOutput{}, err
	}
	var hasNested bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM doc_folders
			WHERE org_id = $1::uuid AND path ILIKE $2
			LIMIT 1)`, claims.OrganizationID, nested).Scan(&hasNested); err != nil {
		return DeleteDocumentFolderOutput{}, err
	}
	if used || hasNested {
		return DeleteDocumentFolderOutput{}, rejectDocuments("move the documents and nested folders before deleting this folder")
	}

	command, err := tx.Exec(ctx, `
		DELETE FROM doc_folders WHERE org_id = $1::uuid AND path = $2`, claims.OrganizationID, path)
	if err != nil {
		return DeleteDocumentFolderOutput{}, err
	}
	return DeleteDocumentFolderOutput{Deleted: command.RowsAffected() > 0, Path: path}, nil
}

// renameDocumentFolder moves the folder, every nested folder, and every
// document underneath it in one statement each, so no row keeps a stale path.
func renameDocumentFolder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput, now time.Time) (RenameDocumentFolderOutput, error) {
	path := NormalizeDocumentFolderPath(*input.Path)
	newPath := NormalizeDocumentFolderPath(*input.NewPath)
	if path == "" || newPath == "" || path == newPath {
		return RenameDocumentFolderOutput{}, rejectDocuments("choose a different folder path")
	}
	if strings.HasPrefix(newPath, path+"/") {
		return RenameDocumentFolderOutput{}, rejectDocuments("a folder cannot be moved inside itself")
	}

	var sourceID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM doc_folders
		WHERE org_id = $1::uuid AND path = $2
		LIMIT 1`, claims.OrganizationID, path).Scan(&sourceID); err != nil {
		if err == pgx.ErrNoRows {
			return RenameDocumentFolderOutput{}, rejectDocuments("folder not found")
		}
		return RenameDocumentFolderOutput{}, err
	}
	var collision string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM doc_folders
		WHERE org_id = $1::uuid AND path = $2
		LIMIT 1`, claims.OrganizationID, newPath).Scan(&collision); err == nil {
		return RenameDocumentFolderOutput{}, rejectDocuments("a folder with that path already exists")
	} else if err != pgx.ErrNoRows {
		return RenameDocumentFolderOutput{}, err
	}

	offset := len([]rune(path)) + 1
	nested := path + "/%"
	if _, err := tx.Exec(ctx, `
		UPDATE doc_folders
		SET path = $3 || substring(path from $4::integer)
		WHERE org_id = $1::uuid AND (path = $2 OR path ILIKE $5)`,
		claims.OrganizationID, path, newPath, offset, nested); err != nil {
		return RenameDocumentFolderOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE authored_docs
		SET folder = $3 || substring(folder from $4::integer), updated_at = $5
		WHERE org_id = $1::uuid AND (folder = $2 OR folder ILIKE $6)`,
		claims.OrganizationID, path, newPath, offset, now, nested); err != nil {
		return RenameDocumentFolderOutput{}, err
	}
	return RenameDocumentFolderOutput{Path: path, MovedTo: newPath}, nil
}
