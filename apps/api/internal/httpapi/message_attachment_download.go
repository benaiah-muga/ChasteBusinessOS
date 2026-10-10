package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type messageAttachmentDownloadResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type messageAttachmentDownload struct {
	Filename string
	MimeType string
	Content  []byte
}

type messageAttachmentDownloadReader interface {
	Read(context.Context, string, string, string) (*messageAttachmentDownload, error)
}

type postgresMessageAttachmentDownloadReader struct{ pool *pgxpool.Pool }

func (reader postgresMessageAttachmentDownloadReader) Read(ctx context.Context, orgID, userID, attachmentID string) (*messageAttachmentDownload, error) {
	if reader.pool == nil {
		return nil, errors.New("message attachment database unavailable")
	}
	return dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (*messageAttachmentDownload, error) {
		var file messageAttachmentDownload
		err := tx.QueryRow(ctx, `
			SELECT a.filename, a.mime_type, a.content
			FROM message_attachments a
			JOIN conversations c
			  ON c.id = a.conversation_id AND c.org_id = a.org_id AND c.deleted_at IS NULL
			JOIN conversation_members cm
			  ON cm.conversation_id = a.conversation_id AND cm.user_id = $2::uuid
			LEFT JOIN messages m
			  ON m.id = a.message_id
			 AND m.org_id = a.org_id
			 AND m.conversation_id = a.conversation_id
			 AND m.deleted_at IS NULL
			WHERE a.id = $3::uuid
			  AND a.org_id = $1::uuid
			  AND ((a.message_id IS NULL AND a.uploaded_by_user_id = $2::uuid)
			       OR (a.message_id IS NOT NULL AND m.id IS NOT NULL))
			LIMIT 1`, orgID, userID, attachmentID).Scan(&file.Filename, &file.MimeType, &file.Content)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &file, nil
	})
}

type MessageAttachmentDownloadHandler struct {
	resolver messageAttachmentDownloadResolver
	reader   messageAttachmentDownloadReader
	logger   *slog.Logger
}

func NewMessageAttachmentDownloadHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, logger *slog.Logger) http.Handler {
	return newMessageAttachmentDownloadHandler(resolver, postgresMessageAttachmentDownloadReader{pool: pool}, logger)
}

func newMessageAttachmentDownloadHandler(resolver messageAttachmentDownloadResolver, reader messageAttachmentDownloadReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &MessageAttachmentDownloadHandler{resolver: resolver, reader: reader, logger: logger}
}

func (handler *MessageAttachmentDownloadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "message attachment service unavailable"})
		return
	}
	attachmentID := r.PathValue("id")
	if attachmentID == "" {
		attachmentID = strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/message-attachments/"), "/")
	}
	if !isUUID(attachmentID) {
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
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !resolved.HasPermission("messaging.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing messaging.read"})
		return
	}

	file, err := handler.reader.Read(r.Context(), *resolved.OrgID, resolved.UserID, attachmentID)
	if err != nil {
		handler.logger.Error("Go message attachment download failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if file == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	w.Header().Set("Content-Type", file.MimeType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s", url.PathEscape(file.Filename)))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(file.Content)))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := io.Copy(w, bytes.NewReader(file.Content)); err != nil {
		handler.logger.Error("Go message attachment response stream failed", "error", err)
	}
}

func (handler *MessageAttachmentDownloadHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, session.ErrNoSession
		}
		return handler.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return handler.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
