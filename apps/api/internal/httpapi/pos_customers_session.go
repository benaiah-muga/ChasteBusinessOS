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

type posCustomersSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type posCustomerOption struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Email              *string `json:"email"`
	PurchaseCount      int64   `json:"purchaseCount"`
	LifetimeSpendMinor int64   `json:"lifetimeSpendMinor"`
}

type posCustomersData struct {
	Customers []posCustomerOption `json:"customers"`
}

type posCustomersReader interface {
	Read(context.Context, string) (posCustomersData, error)
}

type postgresPosCustomersReader struct{ pool *pgxpool.Pool }

func (r postgresPosCustomersReader) Read(ctx context.Context, orgID string) (posCustomersData, error) {
	if r.pool == nil {
		return posCustomersData{}, errors.New("POS customer database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (posCustomersData, error) {
		rows, err := tx.Query(ctx, `
			SELECT c.id::text, c.name, c.email,
			       count(i.id)::bigint,
			       coalesce(sum(i.total_minor - i.credited_minor), 0)::bigint
			FROM customers c
			LEFT JOIN invoices i ON i.org_id = c.org_id AND i.customer_id = c.id AND i.pos_session_id IS NOT NULL
			WHERE c.org_id = $1::uuid AND c.deactivated_at IS NULL AND c.merged_into_customer_id IS NULL
			GROUP BY c.id, c.name, c.email
			ORDER BY c.name
			LIMIT 500`, orgID)
		if err != nil {
			return posCustomersData{}, err
		}
		defer rows.Close()
		data := posCustomersData{Customers: make([]posCustomerOption, 0)}
		for rows.Next() {
			var customer posCustomerOption
			if err := rows.Scan(&customer.ID, &customer.Name, &customer.Email, &customer.PurchaseCount, &customer.LifetimeSpendMinor); err != nil {
				return posCustomersData{}, err
			}
			data.Customers = append(data.Customers, customer)
		}
		if err := rows.Err(); err != nil {
			return posCustomersData{}, err
		}
		return data, nil
	})
}

type PosCustomersSessionHandler struct {
	resolver posCustomersSessionResolver
	reader   posCustomersReader
	logger   *slog.Logger
}

func NewPosCustomersSessionHandler(pool *pgxpool.Pool, resolver posCustomersSessionResolver, logger *slog.Logger) http.Handler {
	return newPosCustomersSessionHandler(resolver, postgresPosCustomersReader{pool: pool}, logger)
}

func newPosCustomersSessionHandler(resolver posCustomersSessionResolver, reader posCustomersReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &PosCustomersSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *PosCustomersSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "POS customer service unavailable"})
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
	if !resolved.HasPermission("crm.read") && !resolved.HasPermission("pos.sell") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing crm.read or pos.sell"})
		return
	}
	data, err := h.reader.Read(r.Context(), *resolved.OrgID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go POS customer read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if data.Customers == nil {
		data.Customers = []posCustomerOption{}
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *PosCustomersSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
