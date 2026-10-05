package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	portalInvoiceRatePrefix = "go-portal-invoice-rate-v1:"
	portalInvoiceRateLimit  = 30
	portalInvoiceRateWindow = time.Minute
	portalInvoiceMaxSafeInt = int64(9_007_199_254_740_991)
)

var portalInvoiceTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{20,64}$`)

type portalInvoiceLine struct {
	Description    string `json:"description"`
	Quantity       int64  `json:"quantity"`
	UnitPriceMinor int64  `json:"unitPriceMinor"`
	TaxMinor       int64  `json:"taxMinor"`
}

type portalInvoice struct {
	Number           int64               `json:"number"`
	Status           string              `json:"status"`
	Currency         string              `json:"currency"`
	TotalMinor       int64               `json:"totalMinor"`
	CreditedMinor    int64               `json:"creditedMinor"`
	PaidMinor        int64               `json:"paidMinor"`
	OutstandingMinor int64               `json:"outstandingMinor"`
	IssuedAt         *string             `json:"issuedAt"`
	CustomerName     string              `json:"customerName"`
	Lines            []portalInvoiceLine `json:"lines"`
}

type portalInvoiceHandler struct {
	pool              *pgxpool.Pool
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	resolveOrg        func(context.Context, *pgxpool.Pool, string) (string, bool, error)
	loadInvoice       func(context.Context, *pgxpool.Pool, string, string) (*portalInvoice, bool, error)
	allowAttempt      func(context.Context, *pgxpool.Pool, string) (bool, time.Duration, error)
}

// NewPortalInvoiceHandler builds the unauthenticated read-only invoice portal.
// The share token is the sole credential and is never echoed in a response.
func NewPortalInvoiceHandler(pool *pgxpool.Pool, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("portal invoice handler requires a database pool")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &portalInvoiceHandler{
		pool: pool, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs,
		resolveOrg: resolvePortalInvoiceOrg, loadInvoice: loadPortalInvoice,
		allowAttempt: allowPortalInvoiceAttempt,
	}, nil
}

func (h *portalInvoiceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writePortalInvoiceJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	clientIP := requestClientIP(r, h.trustedProxyCIDRs)
	if clientIP == "" {
		writePortalInvoiceJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "temporarily unavailable"})
		return
	}
	allowed, retry, err := h.allowAttempt(r.Context(), h.pool, clientIP)
	if err != nil {
		h.unavailable(w, err)
		return
	}
	if !allowed {
		retrySeconds := int(retry.Seconds())
		if retrySeconds < 1 {
			retrySeconds = 1
		}
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retrySeconds))
		writePortalInvoiceJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}

	token := r.PathValue("token")
	if !portalInvoiceTokenPattern.MatchString(token) {
		writePortalInvoiceJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	orgID, found, err := h.resolveOrg(r.Context(), h.pool, token)
	if err != nil {
		h.unavailable(w, err)
		return
	}
	if !found {
		writePortalInvoiceJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	invoice, found, err := h.loadInvoice(r.Context(), h.pool, orgID, token)
	if err != nil {
		h.unavailable(w, err)
		return
	}
	if !found {
		writePortalInvoiceJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !portalInvoiceNumbersSafe(invoice) {
		h.unavailable(w, errors.New("portal invoice contains an unsupported integer"))
		return
	}
	writePortalInvoiceJSON(w, http.StatusOK, map[string]any{"invoice": invoice})
}

func (h *portalInvoiceHandler) unavailable(w http.ResponseWriter, err error) {
	h.logger.Error("public invoice portal request failed", "error", err)
	writePortalInvoiceJSON(w, http.StatusInternalServerError, map[string]string{"error": "unavailable"})
}

func resolvePortalInvoiceOrg(ctx context.Context, pool *pgxpool.Pool, token string) (string, bool, error) {
	var orgID string
	err := pool.QueryRow(ctx, `SELECT org_id::text FROM public.chaste_resolve_invoice_share_token($1)`, token).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return orgID, err == nil, err
}

func loadPortalInvoice(ctx context.Context, pool *pgxpool.Pool, orgID, token string) (*portalInvoice, bool, error) {
	type loadResult struct {
		invoice *portalInvoice
		found   bool
	}
	result, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (loadResult, error) {
		var invoiceID string
		var invoice portalInvoice
		var issuedAt *time.Time
		err := tx.QueryRow(ctx, `
			SELECT i.id::text, i.number, i.status, i.currency, i.total_minor,
			       i.credited_minor, i.paid_minor, i.issued_at, c.name
			FROM invoice_shares s
			JOIN invoices i ON i.id = s.invoice_id AND i.org_id = s.org_id
			JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
			WHERE s.token = $1 AND s.org_id = $2::uuid AND s.revoked_at IS NULL AND i.status <> 'void'
			LIMIT 1`, token, orgID).Scan(
			&invoiceID, &invoice.Number, &invoice.Status, &invoice.Currency, &invoice.TotalMinor,
			&invoice.CreditedMinor, &invoice.PaidMinor, &issuedAt, &invoice.CustomerName,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return loadResult{}, nil
		}
		if err != nil {
			return loadResult{}, err
		}
		if issuedAt != nil {
			issued := issuedAt.UTC().Format("2006-01-02T15:04:05.000Z")
			invoice.IssuedAt = &issued
		}
		invoice.OutstandingMinor, err = portalOutstanding(invoice.TotalMinor, invoice.PaidMinor, invoice.CreditedMinor)
		if err != nil {
			return loadResult{}, err
		}
		rows, err := tx.Query(ctx, `
			SELECT il.description, il.quantity, il.unit_price_minor, il.tax_minor
			FROM invoice_lines il
			JOIN invoices i ON i.id = il.invoice_id
			WHERE il.invoice_id = $1::uuid AND i.org_id = $2::uuid
			ORDER BY il.id
			LIMIT 50`, invoiceID, orgID)
		if err != nil {
			return loadResult{}, err
		}
		invoice.Lines = make([]portalInvoiceLine, 0, 50)
		for rows.Next() {
			var line portalInvoiceLine
			if err := rows.Scan(&line.Description, &line.Quantity, &line.UnitPriceMinor, &line.TaxMinor); err != nil {
				rows.Close()
				return loadResult{}, err
			}
			invoice.Lines = append(invoice.Lines, line)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return loadResult{}, err
		}
		rows.Close()
		return loadResult{invoice: &invoice, found: true}, nil
	})
	return result.invoice, result.found, err
}

const maxPortalInvoiceSafeInteger int64 = 1<<53 - 1

func portalInvoiceNumbersSafe(invoice *portalInvoice) bool {
	if invoice == nil || invoice.Number < 1 || invoice.Number > maxPortalInvoiceSafeInteger {
		return false
	}
	for _, value := range []int64{invoice.TotalMinor, invoice.CreditedMinor, invoice.PaidMinor, invoice.OutstandingMinor} {
		if value < 0 || value > maxPortalInvoiceSafeInteger {
			return false
		}
	}
	for _, line := range invoice.Lines {
		if line.Quantity < 1 || line.Quantity > maxPortalInvoiceSafeInteger ||
			line.UnitPriceMinor < 0 || line.UnitPriceMinor > maxPortalInvoiceSafeInteger ||
			line.TaxMinor < 0 || line.TaxMinor > maxPortalInvoiceSafeInteger {
			return false
		}
	}
	return true
}

func portalOutstanding(totalMinor, paidMinor, creditedMinor int64) (int64, error) {
	for _, amount := range []int64{totalMinor, paidMinor, creditedMinor} {
		if amount < 0 || amount > portalInvoiceMaxSafeInt {
			return 0, errors.New("invoice balance contains an unsafe minor amount")
		}
	}
	if paidMinor >= totalMinor {
		return 0, nil
	}
	remaining := totalMinor - paidMinor
	if creditedMinor >= remaining {
		return 0, nil
	}
	return remaining - creditedMinor, nil
}

func allowPortalInvoiceAttempt(ctx context.Context, pool *pgxpool.Pool, clientIP string) (bool, time.Duration, error) {
	digest := sha256.Sum256([]byte(clientIP))
	identifier := portalInvoiceRatePrefix + hex.EncodeToString(digest[:])
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, 0, err
	}
	defer tx.Rollback(context.Background())
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT true FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS lock`, identifier).Scan(&locked); err != nil {
		return false, 0, err
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM auth_verification
			WHERE left(identifier, length($2)) = $2 AND expires_at <= $1
			ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id = e.id`, now, portalInvoiceRatePrefix); err != nil {
		return false, 0, err
	}
	var count int
	var first time.Time
	if err := tx.QueryRow(ctx, `
		SELECT count(*), COALESCE(min(created_at), $2)
		FROM auth_verification WHERE identifier = $1 AND expires_at > $2`, identifier, now).Scan(&count, &first); err != nil {
		return false, 0, err
	}
	if count >= portalInvoiceRateLimit {
		if err := tx.Commit(ctx); err != nil {
			return false, 0, err
		}
		retry := portalInvoiceRateWindow - now.Sub(first)
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry, nil
	}
	idBytes := make([]byte, 18)
	if _, err := rand.Read(idBytes); err != nil {
		return false, 0, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
		VALUES ($1, $2, '', $3, $4, $4)`, hex.EncodeToString(idBytes), identifier, now.Add(portalInvoiceRateWindow), now)
	if err != nil {
		return false, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

func writePortalInvoiceJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
