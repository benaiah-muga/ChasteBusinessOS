package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var salesInvoiceUUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const salesInvoiceNoStore = "no-store"

type salesInvoiceSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
}

type salesInvoicePayload struct {
	Order    salesInvoiceOrder     `json:"order"`
	Lines    []salesInvoiceLine    `json:"lines"`
	Branding *salesInvoiceBranding `json:"branding"`
}

type salesInvoiceOrder struct {
	Number          int64     `json:"number"`
	Status          string    `json:"status"`
	Note            *string   `json:"note"`
	CreatedAt       time.Time `json:"createdAt"`
	CustomerName    string    `json:"customerName"`
	CustomerEmail   *string   `json:"customerEmail"`
	PaymentTermDays *int64    `json:"paymentTermDays"`
	OrgName         string    `json:"orgName"`
}

type salesInvoiceLine struct {
	Description    string `json:"description"`
	Quantity       int64  `json:"quantity"`
	UnitPriceMinor int64  `json:"unitPriceMinor"`
	TaxMinor       int64  `json:"taxMinor"`
}

type salesInvoiceBranding struct {
	LogoDataURL   *string `json:"logoDataUrl"`
	AccentColor   *string `json:"accentColor"`
	InvoiceFooter *string `json:"invoiceFooter"`
	Layout        *string `json:"layout"`
}

type salesInvoiceLoadFunc func(context.Context, string, string) (*salesInvoicePayload, error)

// SalesInvoiceHandler serves the authenticated invoice-print API contract.
// It deliberately resolves Better Auth sessions inside Go so clients do not
// need a server-minted assertion.
type SalesInvoiceHandler struct {
	resolver salesInvoiceSessionResolver
	load     salesInvoiceLoadFunc
	logger   *slog.Logger
}

// NewSalesInvoiceHandler creates a handler backed by PostgreSQL and the
// Better Auth session resolver. The caller must mount GET /api/sales/{orderId}.
func NewSalesInvoiceHandler(pool *pgxpool.Pool, resolver salesInvoiceSessionResolver, logger *slog.Logger) http.Handler {
	h := &SalesInvoiceHandler{resolver: resolver, logger: logger}
	if pool != nil {
		h.load = func(ctx context.Context, orgID, orderID string) (*salesInvoicePayload, error) {
			return loadSalesInvoice(ctx, pool, orgID, orderID)
		}
	}
	return h
}

func (h *SalesInvoiceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", salesInvoiceNoStore)
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeSalesInvoiceJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.load == nil {
		writeSalesInvoiceJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "invoice service unavailable"})
		return
	}

	activeOrg, validOrgSelector := activeOrganizationSelector(r)
	if !validOrgSelector {
		writeSalesInvoiceUnauthorized(w)
		return
	}
	var resolved *session.ResolvedUser
	var err error
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		bearerResolver, ok := h.resolver.(interface {
			ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
		})
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || !ok {
			writeSalesInvoiceUnauthorized(w)
			return
		}
		resolved, err = bearerResolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
	} else {
		resolved, err = h.resolver.Resolve(
			r.Context(),
			session.CookieFromRequest(r, session.SessionCookieName),
			activeOrg,
		)
	}
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || *resolved.OrgID == "" || !matchesRequestedOrganization(r, resolved) {
		writeSalesInvoiceUnauthorized(w)
		return
	}

	orderID := r.PathValue("orderId")
	if orderID == "" {
		orderID = finalPathSegment(r.URL.Path)
	}
	if !salesInvoiceUUIDPattern.MatchString(orderID) {
		writeSalesInvoiceJSON(w, http.StatusOK, map[string]string{"error": "Invoice not found."})
		return
	}

	data, err := h.load(r.Context(), *resolved.OrgID, orderID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("sales invoice read failed", "error", err)
		}
		writeSalesInvoiceJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if data == nil {
		writeSalesInvoiceJSON(w, http.StatusOK, map[string]string{"error": "Invoice not found."})
		return
	}
	if !salesInvoiceNumbersSafe(data) {
		writeSalesInvoiceJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeSalesInvoiceJSON(w, http.StatusOK, data)
}

func writeSalesInvoiceUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeSalesInvoiceJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func loadSalesInvoice(ctx context.Context, pool *pgxpool.Pool, orgID, orderID string) (*salesInvoicePayload, error) {
	return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (*salesInvoicePayload, error) {
		data := &salesInvoicePayload{Lines: []salesInvoiceLine{}}
		var order salesInvoiceOrder
		err := tx.QueryRow(ctx, `
			SELECT so.number, so.status, so.note, so.created_at,
				c.name, c.email, c.payment_term_days, o.name
			FROM sales_orders so
		INNER JOIN customers c ON c.id = so.customer_id AND c.org_id = so.org_id
		INNER JOIN organizations o ON o.id = so.org_id
		WHERE so.id = $1::uuid AND so.org_id = $2::uuid
		LIMIT 1`, orderID, orgID).Scan(
			&order.Number, &order.Status, &order.Note, &order.CreatedAt,
			&order.CustomerName, &order.CustomerEmail, &order.PaymentTermDays, &order.OrgName,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		data.Order = order

		rows, err := tx.Query(ctx, `
			SELECT description, quantity, unit_price_minor, tax_minor
			FROM sales_order_lines
			WHERE order_id = $1::uuid AND org_id = $2::uuid
			ORDER BY id`, orderID, orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var line salesInvoiceLine
			if err := rows.Scan(&line.Description, &line.Quantity, &line.UnitPriceMinor, &line.TaxMinor); err != nil {
				return nil, err
			}
			data.Lines = append(data.Lines, line)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}

		var branding salesInvoiceBranding
		err = tx.QueryRow(ctx, `
			SELECT logo_data_url, accent_color, invoice_footer, layout
			FROM org_branding
			WHERE org_id = $1::uuid
		LIMIT 1`, orgID).Scan(
			&branding.LogoDataURL, &branding.AccentColor, &branding.InvoiceFooter, &branding.Layout,
		)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			data.Branding = &branding
		}
		return data, nil
	})
}

func salesInvoiceNumbersSafe(data *salesInvoicePayload) bool {
	if data == nil || !safeSalesInvoiceInteger(data.Order.Number) {
		return false
	}
	if data.Order.PaymentTermDays != nil && !safeSalesInvoiceInteger(*data.Order.PaymentTermDays) {
		return false
	}
	for _, line := range data.Lines {
		if !safeSalesInvoiceInteger(line.Quantity) || !safeSalesInvoiceInteger(line.UnitPriceMinor) || !safeSalesInvoiceInteger(line.TaxMinor) {
			return false
		}
	}
	return true
}

func safeSalesInvoiceInteger(value int64) bool {
	return value >= -maxSafeSalesInvoiceInteger && value <= maxSafeSalesInvoiceInteger
}

const maxSafeSalesInvoiceInteger int64 = 9007199254740991

func writeSalesInvoiceJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func finalPathSegment(path string) string {
	for len(path) > 0 && path[len(path)-1] == '/' {
		path = path[:len(path)-1]
	}
	for index := len(path) - 1; index >= 0; index-- {
		if path[index] == '/' {
			return path[index+1:]
		}
	}
	return path
}
