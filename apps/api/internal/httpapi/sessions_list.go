package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type sessionsListResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type sessionsListRow struct {
	ID        string
	UserID    *string
	Title     *string
	Mode      string
	Status    string
	ModelRef  *string
	CreatedAt time.Time
}

type sessionsListResponseRow struct {
	ID        string  `json:"id"`
	UserID    *string `json:"userId"`
	Title     *string `json:"title"`
	Mode      string  `json:"mode"`
	Status    string  `json:"status"`
	ModelRef  *string `json:"modelRef"`
	CreatedAt string  `json:"createdAt"`
}

type sessionsListReader interface {
	ForUser(context.Context, string, string, bool) ([]sessionsListRow, error)
}

type pgSessionsListReader struct{ pool *pgxpool.Pool }

func (r pgSessionsListReader) ForUser(ctx context.Context, orgID, userID string, admin bool) ([]sessionsListRow, error) {
	if r.pool == nil {
		return nil, errors.New("sessions database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) ([]sessionsListRow, error) {
		query := `
			SELECT id::text, user_id::text, title, mode, status, model_ref, created_at
			FROM agent_sessions
			WHERE org_id = $1::uuid`
		args := []any{orgID}
		if !admin {
			query += ` AND user_id = $2::uuid`
			args = append(args, userID)
		}
		query += ` ORDER BY created_at DESC LIMIT 50`
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		result := make([]sessionsListRow, 0)
		for rows.Next() {
			var row sessionsListRow
			if err := rows.Scan(&row.ID, &row.UserID, &row.Title, &row.Mode, &row.Status, &row.ModelRef, &row.CreatedAt); err != nil {
				return nil, err
			}
			row.CreatedAt = row.CreatedAt.UTC()
			result = append(result, row)
		}
		return result, rows.Err()
	})
}

type SessionsListHandler struct {
	resolver sessionsListResolver
	reader   sessionsListReader
	logger   *slog.Logger
}

func NewSessionsListHandler(pool *pgxpool.Pool, resolver sessionsListResolver, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &SessionsListHandler{resolver: resolver, reader: pgSessionsListReader{pool: pool}, logger: logger}
}

func newSessionsListHandler(resolver sessionsListResolver, reader sessionsListReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &SessionsListHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *SessionsListHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sessions service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
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

	sessions, err := h.reader.ForUser(r.Context(), *resolved.OrgID, resolved.UserID,
		resolved.HasPermission("iam.admin") || resolved.HasPermission("*"))
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go sessions list failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if sessions == nil {
		sessions = []sessionsListRow{}
	}
	responseRows := make([]sessionsListResponseRow, len(sessions))
	for i, row := range sessions {
		responseRows[i] = sessionsListResponseRow{
			ID: row.ID, UserID: row.UserID, Title: row.Title, Mode: row.Mode,
			Status: row.Status, ModelRef: row.ModelRef, CreatedAt: legacySessionTime(row.CreatedAt),
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": responseRows})
}

func (h *SessionsListHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
