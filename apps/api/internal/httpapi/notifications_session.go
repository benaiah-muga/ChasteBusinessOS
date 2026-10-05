package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type notificationsSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type notificationSessionRow struct {
	ID        string
	Kind      string
	Title     string
	Href      *string
	ReadAt    *time.Time
	CreatedAt time.Time
}

type notificationSessionReader interface {
	ForUser(context.Context, string, string, int) ([]notificationSessionRow, int, error)
}

type notificationSessionFeed struct {
	rows        []notificationSessionRow
	unreadCount int
}

type pgNotificationsSessionReader struct{ pool *pgxpool.Pool }

func (reader pgNotificationsSessionReader) ForUser(ctx context.Context, orgID, userID string, limit int) ([]notificationSessionRow, int, error) {
	if reader.pool == nil {
		return nil, 0, errors.New("notifications database unavailable")
	}
	feed, err := dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (notificationSessionFeed, error) {
		var unreadCount int
		err := tx.QueryRow(ctx, `
			SELECT count(*)::integer
			FROM notifications n
			LEFT JOIN notification_reads nr
			  ON nr.notification_id = n.id AND nr.org_id = $1::uuid AND nr.user_id = $2::uuid
			WHERE n.org_id = $1::uuid
			  AND (n.user_id IS NULL OR n.user_id = $2::uuid)
			  AND COALESCE(nr.read_at, CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE NULL END) IS NULL`,
			orgID, userID).Scan(&unreadCount)
		if err != nil {
			return notificationSessionFeed{}, err
		}

		rows, err := tx.Query(ctx, `
			SELECT n.id::text, n.kind, n.title, n.href,
			       COALESCE(nr.read_at, CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE NULL END),
			       n.created_at
			FROM notifications n
			LEFT JOIN notification_reads nr
			  ON nr.notification_id = n.id AND nr.org_id = $1::uuid AND nr.user_id = $2::uuid
			WHERE n.org_id = $1::uuid
			  AND (n.user_id IS NULL OR n.user_id = $2::uuid)
			ORDER BY n.created_at DESC
			LIMIT $3`, orgID, userID, limit)
		if err != nil {
			return notificationSessionFeed{}, err
		}
		defer rows.Close()
		result := make([]notificationSessionRow, 0)
		for rows.Next() {
			var row notificationSessionRow
			if err := rows.Scan(&row.ID, &row.Kind, &row.Title, &row.Href, &row.ReadAt, &row.CreatedAt); err != nil {
				return notificationSessionFeed{}, err
			}
			result = append(result, row)
		}
		if err := rows.Err(); err != nil {
			return notificationSessionFeed{}, err
		}
		return notificationSessionFeed{rows: result, unreadCount: unreadCount}, nil
	})
	if err != nil {
		return nil, 0, err
	}
	return feed.rows, feed.unreadCount, nil
}

type NotificationsSessionHandler struct {
	resolver notificationsSessionResolver
	reader   notificationSessionReader
	logger   *slog.Logger
}

func NewNotificationsSessionHandler(pool *pgxpool.Pool, resolver notificationsSessionResolver, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &NotificationsSessionHandler{resolver: resolver, reader: pgNotificationsSessionReader{pool: pool}, logger: logger}
}

func newNotificationsSessionHandler(resolver notificationsSessionResolver, reader notificationSessionReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &NotificationsSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (handler *NotificationsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notifications service unavailable"})
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

	limit := notificationLimit(r.URL.Query().Get("limit"), r.URL.Query().Has("limit"))
	notifications, unreadCount, err := handler.reader.ForUser(r.Context(), *resolved.OrgID, resolved.UserID, limit)
	if err != nil {
		if handler.logger != nil {
			handler.logger.Error("Go notification feed read failed", "organizationId", *resolved.OrgID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if notifications == nil {
		notifications = []notificationSessionRow{}
	}
	responseRows := make([]map[string]any, len(notifications))
	for i, row := range notifications {
		var readAt *string
		if row.ReadAt != nil {
			formatted := legacySessionTime(*row.ReadAt)
			readAt = &formatted
		}
		responseRows[i] = map[string]any{
			"id": row.ID, "kind": row.Kind, "title": row.Title, "href": row.Href,
			"readAt": readAt, "createdAt": legacySessionTime(row.CreatedAt),
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"notifications": responseRows, "unreadCount": unreadCount})
}

func (handler *NotificationsSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return handler.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return handler.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func notificationLimit(raw string, present bool) int {
	if !present {
		return 30
	}
	if strings.TrimSpace(raw) == "" {
		return 1
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 30
	}
	if value < 1 {
		return 1
	}
	if value > 100 {
		return 100
	}
	return int(math.Floor(value))
}
