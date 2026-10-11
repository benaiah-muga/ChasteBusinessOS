package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type supportCustomerOption struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Email *string `json:"email"`
}

type supportCustomersData struct {
	Customers []supportCustomerOption `json:"customers"`
}

type supportCustomersReader interface {
	Read(context.Context, string, bool) (supportCustomersData, error)
}

type postgresSupportCustomersReader struct{ pool *pgxpool.Pool }

func (r postgresSupportCustomersReader) Read(ctx context.Context, orgID string, includeDeactivated bool) (supportCustomersData, error) {
	if r.pool == nil {
		return supportCustomersData{}, errors.New("support customer database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (supportCustomersData, error) {
		rows, err := tx.Query(ctx, `
			SELECT c.id::text, c.name, c.email
			FROM customers c
			WHERE c.org_id = $1::uuid
			  AND c.merged_into_customer_id IS NULL
			  AND ($2::boolean OR c.deactivated_at IS NULL)
			ORDER BY c.name
			LIMIT 500`, orgID, includeDeactivated)
		if err != nil {
			return supportCustomersData{}, err
		}
		defer rows.Close()
		data := supportCustomersData{Customers: make([]supportCustomerOption, 0)}
		for rows.Next() {
			var customer supportCustomerOption
			if err := rows.Scan(&customer.ID, &customer.Name, &customer.Email); err != nil {
				return supportCustomersData{}, err
			}
			data.Customers = append(data.Customers, customer)
		}
		if err := rows.Err(); err != nil {
			return supportCustomersData{}, err
		}
		return data, nil
	})
}

type supportCustomersSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type SupportCustomersSessionHandler struct {
	resolver supportCustomersSessionResolver
	reader   supportCustomersReader
	logger   *slog.Logger
}

func NewSupportCustomersSessionHandler(pool *pgxpool.Pool, resolver supportCustomersSessionResolver, logger *slog.Logger) http.Handler {
	return newSupportCustomersSessionHandler(resolver, postgresSupportCustomersReader{pool: pool}, logger)
}

func newSupportCustomersSessionHandler(resolver supportCustomersSessionResolver, reader supportCustomersReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &SupportCustomersSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *SupportCustomersSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "support customer service unavailable"})
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
	canReadCRM := resolved.HasPermission("crm.read") || resolved.HasPermission("*")
	canSellPOS := resolved.HasPermission("pos.sell") || resolved.HasPermission("*")
	if !canReadCRM && !canSellPOS {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing crm.read or pos.sell"})
		return
	}
	data, err := h.reader.Read(r.Context(), *resolved.OrgID, canReadCRM)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go Support customer read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if data.Customers == nil {
		data.Customers = []supportCustomerOption{}
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *SupportCustomersSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
