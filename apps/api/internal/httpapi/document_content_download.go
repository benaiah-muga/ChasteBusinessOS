package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const documentContentMaxBytes = 5 << 20

var documentContentSafeInlineTypes = map[string]struct{}{
	"image/gif":  {},
	"image/jpeg": {},
	"image/png":  {},
	"image/webp": {},
	"text/plain": {},
}

var documentContentFilenameUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

type documentContentDownload struct {
	Title         string
	MIMEType      *string
	SizeBytes     *int64
	ContentBase64 *string
}

type documentContentDownloadReader interface {
	Read(context.Context, string, string) (*documentContentDownload, error)
}

type postgresDocumentContentDownloadReader struct{ pool *pgxpool.Pool }

func (reader postgresDocumentContentDownloadReader) Read(ctx context.Context, orgID, documentID string) (*documentContentDownload, error) {
	if reader.pool == nil {
		return nil, errors.New("document database unavailable")
	}
	return dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (*documentContentDownload, error) {
		var document documentContentDownload
		err := tx.QueryRow(ctx, `
			SELECT title, mime_type, size_bytes, content_base64
			FROM documents
			WHERE org_id = $1::uuid AND id = $2::uuid
			LIMIT 1`, orgID, documentID).Scan(
			&document.Title, &document.MIMEType, &document.SizeBytes, &document.ContentBase64,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &document, nil
	})
}

type DocumentContentDownloadHandler struct {
	resolver DirectCapabilitySessionResolver
	reader   documentContentDownloadReader
	logger   *slog.Logger
}

func NewDocumentContentDownloadHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, logger *slog.Logger) http.Handler {
	return newDocumentContentDownloadHandler(resolver, postgresDocumentContentDownloadReader{pool: pool}, logger)
}

func newDocumentContentDownloadHandler(resolver DirectCapabilitySessionResolver, reader documentContentDownloadReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &DocumentContentDownloadHandler{resolver: resolver, reader: reader, logger: logger}
}

func (handler *DocumentContentDownloadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "document content service unavailable"})
		return
	}
	documentID := r.PathValue("id")
	if documentID == "" {
		documentID = strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/go/documents/"), "/")
		if strings.HasSuffix(documentID, "/content") {
			documentID = strings.TrimSuffix(documentID, "/content")
		}
	}
	if !isUUID(documentID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := handler.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || strings.TrimSpace(resolved.AuthSessionID) == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !resolved.HasPermission("documents.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing documents.read"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "documents") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "documents module is disabled"})
		return
	}

	document, err := handler.reader.Read(r.Context(), *resolved.OrgID, documentID)
	if err != nil {
		handler.logger.Error("Go document content download failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if document == nil || document.ContentBase64 == nil || *document.ContentBase64 == "" || document.MIMEType == nil || *document.MIMEType == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if len(*document.ContentBase64) > base64.StdEncoding.EncodedLen(documentContentMaxBytes) {
		handler.logger.Error("Go document content exceeds the upload limit", "documentId", documentID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	content, err := base64.StdEncoding.DecodeString(*document.ContentBase64)
	if err != nil || len(content) == 0 || len(content) > documentContentMaxBytes || base64.StdEncoding.EncodeToString(content) != *document.ContentBase64 || !documentContentSizeValid(document.SizeBytes, len(content)) {
		handler.logger.Error("Go document content metadata is invalid", "documentId", documentID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	mediaType, _, err := mime.ParseMediaType(*document.MIMEType)
	if err != nil || mediaType == "" {
		handler.logger.Error("Go document content MIME metadata is invalid", "documentId", documentID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	mediaType = strings.ToLower(mediaType)
	inline := false
	if _, safe := documentContentSafeInlineTypes[mediaType]; safe {
		inline = true
	} else {
		mediaType = "application/octet-stream"
	}
	filename := documentContentFilenameUnsafe.ReplaceAllString(document.Title, "-")
	if filename == "" {
		filename = "document"
	}
	mode := "attachment"
	if inline {
		mode = "inline"
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", mode, url.PathEscape(filename)))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, bytes.NewReader(content)); err != nil {
		handler.logger.Error("Go document content response stream failed", "error", err)
	}
}

func documentContentSizeValid(declared *int64, actual int) bool {
	if declared == nil {
		return true
	}
	if *declared < 0 || *declared > documentContentMaxBytes {
		return false
	}
	// Existing ingest rows store floor(base64 length * 3 / 4), which can
	// overstate decoded bytes by at most two for padded payloads.
	return *declared >= int64(actual) && *declared <= int64(actual)+2
}

func (handler *DocumentContentDownloadHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, session.ErrNoSession
		}
		return handler.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return handler.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
