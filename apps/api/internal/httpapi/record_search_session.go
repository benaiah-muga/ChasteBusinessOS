package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type recordSearchReader interface {
	Search(context.Context, string, string, map[string]bool, string, int) ([]recordSearchGroup, error)
}

type recordSearchItem struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle,omitempty"`
	Href     string `json:"href"`
}

type recordSearchGroup struct {
	Type  string             `json:"type"`
	Label string             `json:"label"`
	Items []recordSearchItem `json:"items"`
}

type recordSearchResponse struct {
	Query  string              `json:"query"`
	Groups []recordSearchGroup `json:"groups"`
}

type RecordSearchHandler struct {
	resolver recordSearchResolver
	reader   recordSearchReader
	logger   *slog.Logger
}

type recordSearchResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

func NewRecordSearchHandler(pool *pgxpool.Pool, resolver recordSearchResolver, logger *slog.Logger) http.Handler {
	return &RecordSearchHandler{resolver: resolver, reader: pgRecordSearchReader{pool: pool}, logger: logger}
}

func newRecordSearchHandler(resolver recordSearchResolver, reader recordSearchReader, logger *slog.Logger) http.Handler {
	return &RecordSearchHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *RecordSearchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "search service unavailable"})
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
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 2 || len(query) > 80 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query must be between 2 and 80 characters"})
		return
	}
	groups, err := h.reader.Search(r.Context(), *resolved.OrgID, resolved.UserID, resolved.Permissions, query, 5)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go record search failed", "organizationId", *resolved.OrgID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if groups == nil {
		groups = []recordSearchGroup{}
	}
	writeJSON(w, http.StatusOK, recordSearchResponse{Query: query, Groups: groups})
}

func (h *RecordSearchHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

type pgRecordSearchReader struct{ pool *pgxpool.Pool }

func (reader pgRecordSearchReader) Search(ctx context.Context, orgID, userID string, permissions map[string]bool, query string, limit int) ([]recordSearchGroup, error) {
	if reader.pool == nil {
		return nil, nil
	}
	allowed := func(permission string) bool {
		return permissions["*"] || permissions[permission]
	}
	groups := make([]recordSearchGroup, 0, 8)
	_, err := dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		add := func(kind, label, permission, statement string, args ...any) error {
			if !allowed(permission) {
				return nil
			}
			rows, err := tx.Query(ctx, statement, args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			items := make([]recordSearchItem, 0, limit)
			for rows.Next() {
				var item recordSearchItem
				if err := rows.Scan(&item.ID, &item.Title, &item.Subtitle); err != nil {
					return err
				}
				items = append(items, item)
			}
			if err := rows.Err(); err != nil {
				return err
			}
			if len(items) > 0 {
				for index := range items {
					items[index].Href = recordSearchHref(kind, items[index].ID)
				}
				groups = append(groups, recordSearchGroup{Type: kind, Label: label, Items: items})
			}
			return nil
		}
		if err := add("customer", "Customers", "crm.read",
			`SELECT id::text, name, COALESCE(email,'') FROM customers WHERE org_id=$1::uuid AND (name ILIKE $2 OR email ILIKE $2) ORDER BY name LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		if err := add("vendor", "Suppliers", "purchasing.read",
			`SELECT id::text, name, COALESCE(email,'') FROM vendors WHERE org_id=$1::uuid AND (name ILIKE $2 OR email ILIKE $2) ORDER BY name LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		if err := add("item", "Items", "inventory.read",
			`SELECT id::text, name, sku FROM items WHERE org_id=$1::uuid AND (name ILIKE $2 OR sku ILIKE $2) ORDER BY name LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		if err := add("invoice", "Invoices", "accounting.read",
			`SELECT i.id::text, 'Invoice #' || i.number, COALESCE(c.name,'') FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id AND c.org_id=i.org_id WHERE i.org_id=$1::uuid AND (i.number::text ILIKE $2 OR c.name ILIKE $2) ORDER BY i.number DESC LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		if err := add("bill", "Supplier bills", "purchasing.read",
			`SELECT b.id::text, 'Bill #' || b.number, COALESCE(v.name,'') FROM vendor_bills b LEFT JOIN vendors v ON v.id=b.vendor_id AND v.org_id=b.org_id WHERE b.org_id=$1::uuid AND (b.number::text ILIKE $2 OR v.name ILIKE $2) ORDER BY b.number DESC LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		if err := add("document", "Documents", "documents.read",
			`SELECT id::text, title, status FROM documents WHERE org_id=$1::uuid AND title ILIKE $2 ORDER BY updated_at DESC LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		if err := add("project", "Projects", "projects.read",
			`SELECT id::text, name, status FROM projects WHERE org_id=$1::uuid AND name ILIKE $2 ORDER BY name LIMIT $3`,
			orgID, "%"+query+"%", limit); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return groups, err
}

func recordSearchHref(kind, id string) string {
	switch kind {
	case "customer":
		return "/crm"
	case "vendor", "bill":
		return "/purchasing?tab=workspace"
	case "item":
		return "/inventory"
	case "invoice":
		return "/accounting/invoices"
	case "document":
		return "/documents?documentId=" + id
	case "project":
		return "/projects"
	default:
		return "/"
	}
}
