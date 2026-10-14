package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type salesCustomerOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type salesCustomersData struct {
	Customers []salesCustomerOption `json:"customers"`
}

type salesCustomersReader interface {
	Read(context.Context, string) (salesCustomersData, error)
}

type postgresSalesCustomersReader struct{ pool *pgxpool.Pool }

func (r postgresSalesCustomersReader) Read(ctx context.Context, orgID string) (salesCustomersData, error) {
	if r.pool == nil {
		return salesCustomersData{}, errors.New("sales customer database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (salesCustomersData, error) {
		rows, err := tx.Query(ctx, `
			SELECT c.id::text, c.name
			FROM customers c
			WHERE c.org_id = $1::uuid AND c.deactivated_at IS NULL AND c.merged_into_customer_id IS NULL
			ORDER BY c.name
			LIMIT 500`, orgID)
		if err != nil {
			return salesCustomersData{}, err
		}
		defer rows.Close()
		data := salesCustomersData{Customers: make([]salesCustomerOption, 0)}
		for rows.Next() {
			var customer salesCustomerOption
			if err := rows.Scan(&customer.ID, &customer.Name); err != nil {
				return salesCustomersData{}, err
			}
			data.Customers = append(data.Customers, customer)
		}
		if err := rows.Err(); err != nil {
			return salesCustomersData{}, err
		}
		return data, nil
	})
}

type SalesCustomersSessionHandler struct {
	resolver DirectCapabilitySessionResolver
	reader   salesCustomersReader
	logger   *slog.Logger
}

func NewSalesCustomersSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &SalesCustomersSessionHandler{resolver: resolver, reader: postgresSalesCustomersReader{pool: pool}, logger: logger}
}

func newSalesCustomersSessionHandler(resolver DirectCapabilitySessionResolver, reader salesCustomersReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &SalesCustomersSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *SalesCustomersSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sales customer service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !resolved.HasPermission("sales.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing sales.read"})
		return
	}
	data, err := h.reader.Read(r.Context(), *resolved.OrgID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go sales customer read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if data.Customers == nil {
		data.Customers = []salesCustomerOption{}
	}
	writeJSON(w, http.StatusOK, data)
}
