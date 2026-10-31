package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type salesInvoiceResolverStub struct {
	user          *session.ResolvedUser
	err           error
	seenCookie    string
	seenOrgCookie string
	seenBearer    string
}

func (s *salesInvoiceResolverStub) ResolveBearerToken(_ context.Context, token, activeOrg string) (*session.ResolvedUser, error) {
	s.seenBearer, s.seenOrgCookie = token, activeOrg
	return s.user, s.err
}

func (s *salesInvoiceResolverStub) Resolve(_ context.Context, cookie, activeOrgCookie string) (*session.ResolvedUser, error) {
	s.seenCookie = cookie
	s.seenOrgCookie = activeOrgCookie
	return s.user, s.err
}

func salesInvoiceRequest(path string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.SetPathValue("orderId", finalPathSegment(r.URL.Path))
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-session"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "org-cookie"})
	return r
}

func salesInvoiceTestHandler(resolver *salesInvoiceResolverStub, load salesInvoiceLoadFunc) http.Handler {
	return &SalesInvoiceHandler{resolver: resolver, load: load}
}

func TestSalesInvoiceHandlerReturnsLegacyNotFoundContractAndNoStore(t *testing.T) {
	resolver := &salesInvoiceResolverStub{user: &session.ResolvedUser{EmailVerified: true, OrgID: salesInvoiceStringPointer("org-a")}}
	loads := 0
	handler := salesInvoiceTestHandler(resolver, func(context.Context, string, string) (*salesInvoicePayload, error) {
		loads++
		return nil, nil
	})

	for _, path := range []string{
		"/api/sales/not-a-uuid",
		"/api/sales/aaaaaaaa-0000-4000-8000-000000000001",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, salesInvoiceRequest(path))
		if response.Code != http.StatusOK {
			t.Fatalf("status for %s = %d, want 200", path, response.Code)
		}
		if body := strings.TrimSpace(response.Body.String()); body != `{"error":"Invoice not found."}` {
			t.Fatalf("body for %s = %s", path, body)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
		}
	}
	if loads != 1 {
		t.Fatalf("loader calls = %d, want only missing valid UUID lookup", loads)
	}
}

func TestSalesInvoiceHandlerRequiresVerifiedMembershipBeforeRead(t *testing.T) {
	for name, user := range map[string]*session.ResolvedUser{
		"no resolved session": nil,
		"unverified email":    {EmailVerified: false, OrgID: salesInvoiceStringPointer("org-a")},
		"no organization":     {EmailVerified: true},
	} {
		t.Run(name, func(t *testing.T) {
			resolver := &salesInvoiceResolverStub{user: user}
			called := false
			handler := salesInvoiceTestHandler(resolver, func(context.Context, string, string) (*salesInvoicePayload, error) {
				called = true
				return nil, nil
			})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, salesInvoiceRequest("/api/sales/aaaaaaaa-0000-4000-8000-000000000001"))
			if response.Code != http.StatusUnauthorized || strings.TrimSpace(response.Body.String()) != `{"error":"unauthorized"}` {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if called {
				t.Fatal("loader was called without verified organization membership")
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
		})
	}

	resolver := &salesInvoiceResolverStub{err: errors.New("expired session")}
	handler := salesInvoiceTestHandler(resolver, func(context.Context, string, string) (*salesInvoicePayload, error) {
		t.Fatal("loader called after resolver error")
		return nil, nil
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, salesInvoiceRequest("/api/sales/aaaaaaaa-0000-4000-8000-000000000001"))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("resolver error status = %d, want 401", response.Code)
	}
	if resolver.seenCookie != "signed-session" || resolver.seenOrgCookie != "org-cookie" {
		t.Fatalf("resolver cookies = %q, %q", resolver.seenCookie, resolver.seenOrgCookie)
	}
}

func TestSalesInvoiceHandlerPreservesInvoiceResponseShape(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	resolver := &salesInvoiceResolverStub{user: &session.ResolvedUser{EmailVerified: true, OrgID: &orgID}}
	createdAt := time.Date(2026, 10, 4, 12, 30, 0, 0, time.UTC)
	paymentTermDays := int64(30)
	note, email, logo, accent, footer, layout := "Invoice note", "buyer@example.test", "data:image/png;base64,abc", "#b45309", "Thank you", "modern"
	data := &salesInvoicePayload{
		Order: salesInvoiceOrder{
			Number: 42, Status: "confirmed", Note: &note, CreatedAt: createdAt,
			CustomerName: "Buyer", CustomerEmail: &email, PaymentTermDays: &paymentTermDays, OrgName: "Example Co",
		},
		Lines:    []salesInvoiceLine{{Description: "Widget", Quantity: 1000, UnitPriceMinor: 1200, TaxMinor: 120}},
		Branding: &salesInvoiceBranding{LogoDataURL: &logo, AccentColor: &accent, InvoiceFooter: &footer, Layout: &layout},
	}
	var gotOrgID, gotOrderID string
	handler := salesInvoiceTestHandler(resolver, func(_ context.Context, orgID, orderID string) (*salesInvoicePayload, error) {
		gotOrgID, gotOrderID = orgID, orderID
		return data, nil
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, salesInvoiceRequest("/api/sales/aaaaaaaa-0000-4000-8000-000000000001"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if gotOrgID != orgID || gotOrderID != "aaaaaaaa-0000-4000-8000-000000000001" {
		t.Fatalf("loader scope = %q %q", gotOrgID, gotOrderID)
	}
	for _, field := range []string{`"order"`, `"lines"`, `"branding"`, `"customerName":"Buyer"`, `"unitPriceMinor":1200`, `"invoiceFooter":"Thank you"`, `"createdAt":"2026-10-04T12:30:00Z"`} {
		if !strings.Contains(response.Body.String(), field) {
			t.Fatalf("response does not contain %s: %s", field, response.Body.String())
		}
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
}

func TestSalesInvoiceHandlerAcceptsBearerSessionAndOrganizationSelector(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	resolver := &salesInvoiceResolverStub{user: &session.ResolvedUser{EmailVerified: true, OrgID: &orgID}}
	loadedOrg := ""
	handler := salesInvoiceTestHandler(resolver, func(_ context.Context, resolvedOrg, _ string) (*salesInvoicePayload, error) {
		loadedOrg = resolvedOrg
		return &salesInvoicePayload{Order: salesInvoiceOrder{Number: 7}}, nil
	})
	request := salesInvoiceRequest("/api/sales/aaaaaaaa-0000-4000-8000-000000000002")
	request.Header.Set("Authorization", "Bearer native-session-token")
	request.Header.Set("X-Organization-ID", strings.ToUpper(orgID))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || resolver.seenBearer != "native-session-token" || resolver.seenOrgCookie != orgID || loadedOrg != orgID {
		t.Fatalf("status=%d bearer=%q orgSelector=%q loadedOrg=%q body=%s", response.Code, resolver.seenBearer, resolver.seenOrgCookie, loadedOrg, response.Body.String())
	}
}

func TestSalesInvoiceHandlerRejectsUnmatchedOrganizationSelector(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	resolver := &salesInvoiceResolverStub{user: &session.ResolvedUser{EmailVerified: true, OrgID: &orgID}}
	loads := 0
	handler := salesInvoiceTestHandler(resolver, func(context.Context, string, string) (*salesInvoicePayload, error) {
		loads++
		return nil, nil
	})
	request := salesInvoiceRequest("/api/sales/aaaaaaaa-0000-4000-8000-000000000002")
	request.Header.Set("X-Organization-ID", "bbbbbbbb-0000-4000-8000-000000000002")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || loads != 0 {
		t.Fatalf("status=%d invoice loads=%d body=%s", response.Code, loads, response.Body.String())
	}
}

func TestSalesInvoiceHandlerRejectsUnsafeJSONIntegersAndHidesReadErrors(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	resolver := &salesInvoiceResolverStub{user: &session.ResolvedUser{EmailVerified: true, OrgID: &orgID}}
	for name, load := range map[string]salesInvoiceLoadFunc{
		"unsafe integer": func(context.Context, string, string) (*salesInvoicePayload, error) {
			return &salesInvoicePayload{Order: salesInvoiceOrder{Number: maxSafeSalesInvoiceInteger + 1}}, nil
		},
		"database error": func(context.Context, string, string) (*salesInvoicePayload, error) {
			return nil, errors.New("private database detail")
		},
	} {
		t.Run(name, func(t *testing.T) {
			handler := salesInvoiceTestHandler(resolver, load)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, salesInvoiceRequest("/api/sales/aaaaaaaa-0000-4000-8000-000000000001"))
			if response.Code != http.StatusInternalServerError || strings.TrimSpace(response.Body.String()) != `{"error":"internal error"}` {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "private database detail") {
				t.Fatal("database error leaked to client")
			}
		})
	}
}

func TestSalesInvoiceHandlerRejectsNonGetMethods(t *testing.T) {
	resolver := &salesInvoiceResolverStub{}
	handler := salesInvoiceTestHandler(resolver, nil)
	request := httptest.NewRequest(http.MethodPost, "/api/sales/aaaaaaaa-0000-4000-8000-000000000001", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("response = %d allow %q", response.Code, response.Header().Get("Allow"))
	}
}

func salesInvoiceStringPointer(value string) *string { return &value }
