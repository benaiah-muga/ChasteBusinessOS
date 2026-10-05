package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const portalTestToken = "share_token_123456789012345678"

func newPortalInvoiceTestHandler(invoice *portalInvoice, resolveFound, loadFound bool, resolveErr, loadErr error) *portalInvoiceHandler {
	return &portalInvoiceHandler{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		allowAttempt: func(context.Context, *pgxpool.Pool, string) (bool, time.Duration, error) {
			return true, 0, nil
		},
		resolveOrg: func(context.Context, *pgxpool.Pool, string) (string, bool, error) {
			return "00000000-0000-4000-8000-000000000001", resolveFound, resolveErr
		},
		loadInvoice: func(context.Context, *pgxpool.Pool, string, string) (*portalInvoice, bool, error) {
			return invoice, loadFound, loadErr
		},
	}
}

func portalInvoiceRequest(method, token string) *http.Request {
	request := httptest.NewRequest(method, "/api/portal/invoice/"+token, nil)
	request.SetPathValue("token", token)
	return request
}

func assertPortalPrivacyHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	for name, want := range map[string]string{
		"Cache-Control":   "no-store",
		"Pragma":          "no-cache",
		"Referrer-Policy": "no-referrer",
		"Content-Type":    "application/json",
	} {
		if got := response.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestPortalInvoiceHandlerReturnsOnlyPublicInvoiceContract(t *testing.T) {
	issued := "2026-10-04T12:30:00.000Z"
	invoice := &portalInvoice{
		Number: 42, Status: "sent", Currency: "UGX", TotalMinor: 12500,
		CreditedMinor: 1000, PaidMinor: 2500, OutstandingMinor: 9000,
		IssuedAt: &issued, CustomerName: "Ada Customer",
		Lines: []portalInvoiceLine{{Description: "Consulting", Quantity: 1000, UnitPriceMinor: 12500, TaxMinor: 0}},
	}
	handler := newPortalInvoiceTestHandler(invoice, true, true, nil, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, portalInvoiceRequest(http.MethodGet, portalTestToken))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	assertPortalPrivacyHeaders(t, response)
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 1 || body["invoice"] == nil {
		t.Fatalf("top-level response fields = %v, want only invoice", body)
	}
	var actual map[string]json.RawMessage
	if err := json.Unmarshal(body["invoice"], &actual); err != nil {
		t.Fatal(err)
	}
	wantFields := []string{"number", "status", "currency", "totalMinor", "creditedMinor", "paidMinor", "outstandingMinor", "issuedAt", "customerName", "lines"}
	if len(actual) != len(wantFields) {
		t.Fatalf("invoice response has unexpected fields: %v", actual)
	}
	for _, field := range wantFields {
		if actual[field] == nil {
			t.Errorf("response omitted %q", field)
		}
	}
	for _, private := range []string{"orgId", "organizationId", "invoiceId", "customerId", "token", "ledger", "memo"} {
		if actual[private] != nil || strings.Contains(response.Body.String(), private) {
			t.Errorf("response exposed private field %q: %s", private, response.Body.String())
		}
	}
	if !strings.Contains(response.Body.String(), `"outstandingMinor":9000`) {
		t.Fatalf("response omitted credit-adjusted balance: %s", response.Body.String())
	}
}

func TestPortalInvoiceHandlerRejectsIntegersOutsideClientContract(t *testing.T) {
	for name, invoice := range map[string]*portalInvoice{
		"unsafe invoice number":       {Number: maxPortalInvoiceSafeInteger + 1},
		"non-positive invoice number": {Number: 0},
		"unsafe amount":               {Number: 1, TotalMinor: maxPortalInvoiceSafeInteger + 1},
		"unsafe line quantity":        {Number: 1, Lines: []portalInvoiceLine{{Quantity: maxPortalInvoiceSafeInteger + 1}}},
	} {
		t.Run(name, func(t *testing.T) {
			handler := newPortalInvoiceTestHandler(invoice, true, true, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, portalInvoiceRequest(http.MethodGet, "public-token-1234567890"))
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("status=%d body=%s, want internal error for invalid public data", response.Code, response.Body.String())
			}
		})
	}
}

func TestPortalInvoiceHandlerHidesUnknownAndRevokedShares(t *testing.T) {
	for _, test := range []struct {
		name         string
		resolveFound bool
		loadFound    bool
	}{
		{name: "unknown token", resolveFound: false},
		{name: "revoked or void invoice", resolveFound: true, loadFound: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := newPortalInvoiceTestHandler(nil, test.resolveFound, test.loadFound, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, portalInvoiceRequest(http.MethodGet, portalTestToken))
			if response.Code != http.StatusNotFound || response.Body.String() != "{\"error\":\"not found\"}\n" {
				t.Fatalf("status=%d body=%q, want indistinguishable 404", response.Code, response.Body.String())
			}
			assertPortalPrivacyHeaders(t, response)
		})
	}
}

func TestPortalInvoiceHandlerValidatesMethodAndToken(t *testing.T) {
	for _, test := range []struct {
		name       string
		method     string
		token      string
		wantStatus int
	}{
		{name: "unsupported method", method: http.MethodPost, token: portalTestToken, wantStatus: http.StatusMethodNotAllowed},
		{name: "short token", method: http.MethodGet, token: "short", wantStatus: http.StatusNotFound},
		{name: "non base64url token", method: http.MethodGet, token: "share/token/123456789012345678", wantStatus: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := newPortalInvoiceTestHandler(nil, false, false, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, portalInvoiceRequest(test.method, test.token))
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			assertPortalPrivacyHeaders(t, response)
			if test.method != http.MethodGet && response.Header().Get("Allow") != http.MethodGet {
				t.Fatalf("Allow = %q, want GET", response.Header().Get("Allow"))
			}
		})
	}
}

func TestPortalInvoiceHandlerRateLimitAndDatabaseErrorsArePrivate(t *testing.T) {
	t.Run("rate limited", func(t *testing.T) {
		handler := newPortalInvoiceTestHandler(nil, true, true, nil, nil)
		handler.allowAttempt = func(context.Context, *pgxpool.Pool, string) (bool, time.Duration, error) {
			return false, 3 * time.Second, nil
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, portalInvoiceRequest(http.MethodGet, portalTestToken))
		if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "3" {
			t.Fatalf("status=%d retry-after=%q body=%s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
		}
		assertPortalPrivacyHeaders(t, response)
	})

	for _, test := range []struct {
		name  string
		setup func(*portalInvoiceHandler)
	}{
		{name: "rate storage failure", setup: func(h *portalInvoiceHandler) {
			h.allowAttempt = func(context.Context, *pgxpool.Pool, string) (bool, time.Duration, error) {
				return false, 0, errors.New("private database password")
			}
		}},
		{name: "token resolver failure", setup: func(h *portalInvoiceHandler) {
			h.resolveOrg = func(context.Context, *pgxpool.Pool, string) (string, bool, error) {
				return "", false, errors.New("private database password")
			}
		}},
		{name: "invoice query failure", setup: func(h *portalInvoiceHandler) {
			h.loadInvoice = func(context.Context, *pgxpool.Pool, string, string) (*portalInvoice, bool, error) {
				return nil, false, errors.New("private database password")
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := newPortalInvoiceTestHandler(nil, true, true, nil, nil)
			test.setup(handler)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, portalInvoiceRequest(http.MethodGet, portalTestToken))
			if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database password") {
				t.Fatalf("status=%d body=%q, want generic 500", response.Code, response.Body.String())
			}
			assertPortalPrivacyHeaders(t, response)
		})
	}
}

func TestPortalOutstandingUsesCreditAdjustedNonNegativeBalance(t *testing.T) {
	for _, test := range []struct {
		total, paid, credited int64
		want                  int64
	}{
		{total: 10000, paid: 2500, credited: 1000, want: 6500},
		{total: 100, paid: 70, credited: 50, want: 0},
		{total: 100, paid: 100, credited: 0, want: 0},
	} {
		got, err := portalOutstanding(test.total, test.paid, test.credited)
		if err != nil || got != test.want {
			t.Errorf("portalOutstanding(%d,%d,%d) = %d, %v, want %d", test.total, test.paid, test.credited, got, err, test.want)
		}
	}
	if _, err := portalOutstanding(-1, 0, 0); err == nil {
		t.Fatal("negative invoice total was accepted")
	}
	if _, err := portalOutstanding(portalInvoiceMaxSafeInt+1, 0, 0); err == nil {
		t.Fatal("unsafe invoice total was accepted")
	}
}
