package httpapi

import (
	"context"
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

type posReadSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type posReadSession struct {
	ID                string  `json:"id"`
	OrgID             string  `json:"orgId"`
	Register          string  `json:"register"`
	Status            string  `json:"status"`
	OpeningFloatMinor int64   `json:"openingFloatMinor"`
	CountedCashMinor  *int64  `json:"countedCashMinor"`
	ExpectedCashMinor int64   `json:"expectedCashMinor"`
	VarianceMinor     *int64  `json:"varianceMinor"`
	OpenedByUserID    *string `json:"openedByUserId"`
	ClosedByUserID    *string `json:"closedByUserId"`
	OpenedAt          string  `json:"openedAt"`
	ClosedAt          *string `json:"closedAt"`
	VarianceReason    *string `json:"varianceReason"`
}

type posReadSaleLine struct {
	ID               string  `json:"id"`
	ItemID           *string `json:"itemId"`
	Description      string  `json:"description"`
	Quantity         int64   `json:"quantity"`
	UnitPriceMinor   int64   `json:"unitPriceMinor"`
	TaxMinor         int64   `json:"taxMinor"`
	ReturnedQuantity int64   `json:"returnedQuantity"`
	StockTracked     bool    `json:"stockTracked"`
}

type posReadSale struct {
	ID                     string            `json:"id"`
	Number                 int64             `json:"number"`
	Status                 string            `json:"status"`
	TotalMinor             int64             `json:"totalMinor"`
	CreditedMinor          int64             `json:"creditedMinor"`
	Memo                   *string           `json:"memo"`
	CustomerID             *string           `json:"customerId"`
	CustomerName           *string           `json:"customerName"`
	Method                 string            `json:"method"`
	ReturnMode             string            `json:"returnMode"`
	UnallocatedCreditMinor int64             `json:"unallocatedCreditMinor"`
	Lines                  []posReadSaleLine `json:"lines"`
	CreatedAt              string            `json:"createdAt"`
}

type posReadData struct {
	Sessions []posReadSession `json:"sessions"`
	Sales    []posReadSale    `json:"sales"`
}

type posReadReader interface {
	Read(context.Context, string) (posReadData, error)
}

type postgresPosReadReader struct{ pool *pgxpool.Pool }

type posSaleBase struct {
	id, status                   string
	number, totalMinor, credited int64
	memo                         *string
	createdAt                    time.Time
	customerID, customerName     *string
}

type posSaleLineBase struct {
	id, invoiceID, description string
	itemID                     *string
	quantity, unitPrice, tax   int64
}

func (r postgresPosReadReader) Read(ctx context.Context, orgID string) (posReadData, error) {
	if r.pool == nil {
		return posReadData{}, errors.New("POS database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (posReadData, error) {
		data := posReadData{Sessions: []posReadSession{}, Sales: []posReadSale{}}
		sessionRows, err := tx.Query(ctx, `
			SELECT id::text, org_id::text, register, status, opening_float_minor,
			       counted_cash_minor, expected_cash_minor, variance_minor,
			       opened_by_user_id::text, closed_by_user_id::text, opened_at, closed_at, variance_reason
			FROM pos_sessions WHERE org_id = $1::uuid
			ORDER BY opened_at DESC LIMIT 20`, orgID)
		if err != nil {
			return posReadData{}, err
		}
		for sessionRows.Next() {
			var row posReadSession
			var openedAt time.Time
			var closedAt *time.Time
			if err := sessionRows.Scan(&row.ID, &row.OrgID, &row.Register, &row.Status, &row.OpeningFloatMinor,
				&row.CountedCashMinor, &row.ExpectedCashMinor, &row.VarianceMinor, &row.OpenedByUserID,
				&row.ClosedByUserID, &openedAt, &closedAt, &row.VarianceReason); err != nil {
				sessionRows.Close()
				return posReadData{}, err
			}
			row.OpenedAt = legacySessionTime(openedAt)
			if closedAt != nil {
				formatted := legacySessionTime(*closedAt)
				row.ClosedAt = &formatted
			}
			data.Sessions = append(data.Sessions, row)
		}
		if err := sessionRows.Err(); err != nil {
			sessionRows.Close()
			return posReadData{}, err
		}
		sessionRows.Close()

		saleRows, err := tx.Query(ctx, `
			SELECT i.id::text, i.number, i.status, i.total_minor, i.credited_minor, i.memo,
			       i.created_at, i.customer_id::text, c.name
			FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
			WHERE i.org_id = $1::uuid AND i.pos_session_id IS NOT NULL
			ORDER BY i.number DESC LIMIT 20`, orgID)
		if err != nil {
			return posReadData{}, err
		}
		sales := make([]posSaleBase, 0, 20)
		saleIDs := make([]string, 0, 20)
		for saleRows.Next() {
			var row posSaleBase
			if err := saleRows.Scan(&row.id, &row.number, &row.status, &row.totalMinor, &row.credited, &row.memo,
				&row.createdAt, &row.customerID, &row.customerName); err != nil {
				saleRows.Close()
				return posReadData{}, err
			}
			row.createdAt = row.createdAt.UTC()
			sales = append(sales, row)
			saleIDs = append(saleIDs, row.id)
		}
		if err := saleRows.Err(); err != nil {
			saleRows.Close()
			return posReadData{}, err
		}
		saleRows.Close()
		if len(saleIDs) == 0 {
			return data, nil
		}

		lineRows, err := tx.Query(ctx, `
			SELECT id::text, invoice_id::text, item_id::text, description, quantity, unit_price_minor, tax_minor
			FROM invoice_lines WHERE invoice_id = ANY($1::uuid[])`, saleIDs)
		if err != nil {
			return posReadData{}, err
		}
		lines := make([]posSaleLineBase, 0)
		lineIDs := make([]string, 0)
		for lineRows.Next() {
			var row posSaleLineBase
			if err := lineRows.Scan(&row.id, &row.invoiceID, &row.itemID, &row.description, &row.quantity, &row.unitPrice, &row.tax); err != nil {
				lineRows.Close()
				return posReadData{}, err
			}
			lines = append(lines, row)
			lineIDs = append(lineIDs, row.id)
		}
		if err := lineRows.Err(); err != nil {
			lineRows.Close()
			return posReadData{}, err
		}
		lineRows.Close()

		methods := make(map[string][]string)
		paymentRows, err := tx.Query(ctx, `SELECT invoice_id::text, method FROM payments WHERE invoice_id = ANY($1::uuid[])`, saleIDs)
		if err != nil {
			return posReadData{}, err
		}
		for paymentRows.Next() {
			var invoiceID, method string
			if err := paymentRows.Scan(&invoiceID, &method); err != nil {
				paymentRows.Close()
				return posReadData{}, err
			}
			found := false
			for _, current := range methods[invoiceID] {
				if current == method {
					found = true
					break
				}
			}
			if !found {
				methods[invoiceID] = append(methods[invoiceID], method)
			}
		}
		if err := paymentRows.Err(); err != nil {
			paymentRows.Close()
			return posReadData{}, err
		}
		paymentRows.Close()

		returned := make(map[string]int64)
		if len(lineIDs) > 0 {
			returnRows, err := tx.Query(ctx, `
				SELECT invoice_line_id::text, quantity FROM pos_return_lines
				WHERE org_id = $1::uuid AND invoice_line_id = ANY($2::uuid[])`, orgID, lineIDs)
			if err != nil {
				return posReadData{}, err
			}
			for returnRows.Next() {
				var lineID string
				var quantity int64
				if err := returnRows.Scan(&lineID, &quantity); err != nil {
					returnRows.Close()
					return posReadData{}, err
				}
				returned[lineID] += quantity
			}
			if err := returnRows.Err(); err != nil {
				returnRows.Close()
				return posReadData{}, err
			}
			returnRows.Close()
		}
		structuredCredit := make(map[string]int64)
		creditRows, err := tx.Query(ctx, `
			SELECT invoice_id::text, refund_minor FROM pos_returns
			WHERE org_id = $1::uuid AND invoice_id = ANY($2::uuid[])`, orgID, saleIDs)
		if err != nil {
			return posReadData{}, err
		}
		for creditRows.Next() {
			var invoiceID string
			var refund int64
			if err := creditRows.Scan(&invoiceID, &refund); err != nil {
				creditRows.Close()
				return posReadData{}, err
			}
			structuredCredit[invoiceID] += refund
		}
		if err := creditRows.Err(); err != nil {
			creditRows.Close()
			return posReadData{}, err
		}
		creditRows.Close()

		stockItems := make(map[string]map[string]bool)
		stockRows, err := tx.Query(ctx, `
			SELECT ref_id::text, item_id::text FROM stock_movements
			WHERE org_id = $1::uuid AND ref_type = 'invoice' AND ref_id = ANY($2::uuid[]) AND quantity_delta < 0`, orgID, saleIDs)
		if err != nil {
			return posReadData{}, err
		}
		for stockRows.Next() {
			var invoiceID, itemID string
			if err := stockRows.Scan(&invoiceID, &itemID); err != nil {
				stockRows.Close()
				return posReadData{}, err
			}
			if stockItems[invoiceID] == nil {
				stockItems[invoiceID] = make(map[string]bool)
			}
			stockItems[invoiceID][itemID] = true
		}
		if err := stockRows.Err(); err != nil {
			stockRows.Close()
			return posReadData{}, err
		}
		stockRows.Close()

		linesBySale := make(map[string][]posReadSaleLine)
		for _, line := range lines {
			stockTracked := false
			if line.itemID != nil {
				stockTracked = stockItems[line.invoiceID][*line.itemID]
			}
			linesBySale[line.invoiceID] = append(linesBySale[line.invoiceID], posReadSaleLine{
				ID: line.id, ItemID: line.itemID, Description: line.description, Quantity: line.quantity,
				UnitPriceMinor: line.unitPrice, TaxMinor: line.tax, ReturnedQuantity: returned[line.id], StockTracked: stockTracked,
			})
		}
		for _, sale := range sales {
			method := strings.Join(methods[sale.id], " + ")
			if method == "" {
				method = posSaleMemoMethod(sale.memo)
			}
			structured := structuredCredit[sale.id]
			mode := "itemized"
			if sale.credited > structured {
				mode = "credit-review"
			} else {
				for itemID := range stockItems[sale.id] {
					found := false
					for _, line := range linesBySale[sale.id] {
						if line.ItemID != nil && *line.ItemID == itemID {
							found = true
							break
						}
					}
					if !found {
						mode = "legacy-full"
						break
					}
				}
			}
			unallocated := sale.credited - structured
			if unallocated < 0 {
				unallocated = 0
			}
			saleLines := linesBySale[sale.id]
			if saleLines == nil {
				saleLines = []posReadSaleLine{}
			}
			data.Sales = append(data.Sales, posReadSale{
				ID: sale.id, Number: sale.number, Status: sale.status, TotalMinor: sale.totalMinor,
				CreditedMinor: sale.credited, Memo: sale.memo, CustomerID: sale.customerID,
				CustomerName: sale.customerName, Method: method, ReturnMode: mode,
				UnallocatedCreditMinor: unallocated, Lines: saleLines, CreatedAt: legacySessionTime(sale.createdAt),
			})
		}
		return data, nil
	})
}

var posSaleMemoMethodPattern = regexp.MustCompile(`POS \((cash|card|mobile_money)\)`)

func posSaleMemoMethod(memo *string) string {
	if memo != nil {
		if match := posSaleMemoMethodPattern.FindStringSubmatch(*memo); len(match) == 2 {
			return match[1]
		}
	}
	return "cash"
}

type PosReadSessionHandler struct {
	resolver posReadSessionResolver
	reader   posReadReader
	logger   *slog.Logger
}

func NewPosReadSessionHandler(pool *pgxpool.Pool, resolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}, logger *slog.Logger) http.Handler {
	return newPosReadSessionHandler(resolver, postgresPosReadReader{pool: pool}, logger)
}

func newPosReadSessionHandler(resolver posReadSessionResolver, reader posReadReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &PosReadSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *PosReadSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "POS service unavailable"})
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
	if !resolved.HasPermission("pos.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing pos.read"})
		return
	}
	data, err := h.reader.Read(r.Context(), *resolved.OrgID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go POS read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if data.Sessions == nil {
		data.Sessions = []posReadSession{}
	}
	if data.Sales == nil {
		data.Sales = []posReadSale{}
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *PosReadSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
