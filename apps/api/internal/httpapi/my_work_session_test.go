package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	businesscontract "github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract/business"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeMyWorkReader struct {
	orgID             string
	includePurchasing bool
	data              dashboard.MyWorkData
	err               error
	calls             int
}

func (f *fakeMyWorkReader) ForOrg(_ context.Context, orgID string, includePurchasing bool) (dashboard.MyWorkData, error) {
	f.calls++
	f.orgID = orgID
	f.includePurchasing = includePurchasing
	return f.data, f.err
}

func myWorkRequest(method string) *http.Request {
	request := httptest.NewRequest(method, "/api/my-work", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "work-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestMyWorkSessionHandlerReturnsPermissionScopedRankedCards(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["purchasing.read"] = true
	identity.Permissions["signals.read"] = true
	identity.Permissions["crm.write"] = true
	createdAt := time.Date(2026, 10, 4, 7, 8, 9, 123456000, time.UTC)
	reader := &fakeMyWorkReader{data: dashboard.MyWorkData{
		Approvals: []dashboard.PendingApproval{
			{ID: "approval-1", CapabilityID: "sales.createOrder", Rationale: nil, RiskClass: "money", CreatedAt: createdAt},
			{ID: "approval-2", CapabilityID: "crm.createCustomer", Rationale: nil, RiskClass: "write", CreatedAt: createdAt},
			{ID: "approval-hidden", CapabilityID: "not.in.go", RiskClass: "write", CreatedAt: createdAt},
		},
		Remainders: []dashboard.ReceiptRemainder{{
			PurchaseOrderID: "po-1", Number: 42, Remaining: 1250,
			Lines: []dashboard.ReceiptRemainderLine{{Position: 2, Description: "Beans", Remaining: 1250}},
		}},
	}}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	handler := NewMyWorkSessionHandler(resolver, reader, dashboardExecutorWithSuccess(), nil).(*MyWorkSessionHandler)
	handler.now = func() time.Time { return time.Date(2026, 10, 4, 9, 0, 0, 987654321, time.UTC) }
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, myWorkRequest(http.MethodGet))

	if response.Code != http.StatusOK || reader.orgID != *identity.OrgID || !reader.includePurchasing {
		t.Fatalf("status=%d org=%q purchasing=%t body=%s", response.Code, reader.orgID, reader.includePurchasing, response.Body.String())
	}
	var got businesscontract.MyWorkResponse
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Cards) != 4 {
		t.Fatalf("cards=%+v, want two permitted approvals, one remainder, and one signal", got.Cards)
	}
	if got.Cards[0].Id != "approval-1" || got.Cards[1].Id != "approval-2" || got.Cards[2].Id != "po-1" || got.Cards[3].Id != "cash.low" {
		t.Fatalf("cards are not ranked in legacy order: %+v", got.Cards)
	}
	if got.Cards[0].Detail != "money action waiting for a decision" || got.Cards[0].CreatedAt == nil || !got.Cards[0].CreatedAt.Equal(createdAt.Truncate(time.Millisecond)) {
		t.Fatalf("approval semantics differ: %+v", got.Cards[0])
	}
	if got.Cards[2].Title != "PO 42: 1.25 units still outstanding" || got.Cards[2].Detail != `line 2 "Beans"` || got.Cards[2].ActionHref != "/purchasing/receiving?poNumber=42" {
		t.Fatalf("receipt remainder semantics differ: %+v", got.Cards[2])
	}
	if !got.GeneratedAt.Equal(time.Date(2026, 10, 4, 9, 0, 0, 987000000, time.UTC)) {
		t.Fatalf("generatedAt=%q", got.GeneratedAt)
	}
	if resolver.resolveCalls == 0 {
		t.Fatal("session resolver was not called")
	}
}

func TestMyWorkSessionHandlerDoesNotQueryPurchasingForUnauthorizedViewer(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeMyWorkReader{}
	response := httptest.NewRecorder()
	NewMyWorkSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, &fakeDashboardExecutor{}, nil).ServeHTTP(response, myWorkRequest(http.MethodGet))
	if response.Code != http.StatusOK || reader.includePurchasing || reader.calls != 1 {
		t.Fatalf("status=%d purchasing=%t calls=%d body=%s", response.Code, reader.includePurchasing, reader.calls, response.Body.String())
	}
	var got businesscontract.MyWorkResponse
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil || len(got.Cards) != 0 {
		t.Fatalf("expected an empty work queue, err=%v cards=%+v", err, got.Cards)
	}
}

func TestMyWorkSessionHandlerRequiresVerifiedOrganizationSession(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewMyWorkSessionHandler(&fakeDirectSessionResolver{err: session.ErrNoSession}, &fakeMyWorkReader{}, &fakeDashboardExecutor{}, nil).ServeHTTP(response, myWorkRequest(http.MethodGet))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("resolver infrastructure failure", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewMyWorkSessionHandler(&fakeDirectSessionResolver{err: errors.New("private resolver detail")}, &fakeMyWorkReader{}, &fakeDashboardExecutor{}, nil).
			ServeHTTP(response, myWorkRequest(http.MethodGet))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private resolver detail") {
			t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
		}
	})
	t.Run("short auth secret is unavailable", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewMyWorkSessionHandler(&fakeDirectSessionResolver{err: session.ErrSecretTooShort}, &fakeMyWorkReader{}, &fakeDashboardExecutor{}, nil).
			ServeHTTP(response, myWorkRequest(http.MethodGet))
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
		}
	})
	t.Run("wrong method", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewMyWorkSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeMyWorkReader{}, &fakeDashboardExecutor{}, nil).ServeHTTP(response, myWorkRequest(http.MethodPost))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("status=%d Allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
		}
	})
}

func TestMyWorkSessionHandlerRejectsOrganizationMismatch(t *testing.T) {
	reader := &fakeMyWorkReader{}
	request := myWorkRequest(http.MethodGet)
	request.Header.Set("X-Organization-ID", "44444444-4444-4444-8444-444444444444")
	response := httptest.NewRecorder()
	NewMyWorkSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, &fakeDashboardExecutor{}, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || reader.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, reader.calls, response.Body.String())
	}
}

func TestMyWorkSessionHandlerHidesReaderErrors(t *testing.T) {
	reader := &fakeMyWorkReader{err: errors.New("private database detail")}
	response := httptest.NewRecorder()
	NewMyWorkSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, &fakeDashboardExecutor{}, nil).ServeHTTP(response, myWorkRequest(http.MethodGet))
	if response.Code != http.StatusInternalServerError || response.Body.String() == "" || strings.Contains(response.Body.String(), "private database detail") {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestMyWorkSessionHandlerOmitsUnknownApprovalCapabilitiesForWildcard(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["*"] = true
	reader := &fakeMyWorkReader{data: dashboard.MyWorkData{Approvals: []dashboard.PendingApproval{{
		ID: "approval-hidden", CapabilityID: "not.in.go", RiskClass: "write",
	}}}}
	response := httptest.NewRecorder()
	NewMyWorkSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, dashboardExecutorWithSuccess(), nil).
		ServeHTTP(response, myWorkRequest(http.MethodGet))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var got businesscontract.MyWorkResponse
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for _, card := range got.Cards {
		if card.Id == "approval-hidden" {
			t.Fatalf("unknown capability approval was exposed to wildcard user: %+v", card)
		}
	}
}

func TestMyWorkSessionHandlerFailsClosedOnMalformedSignalModule(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["signals.read"] = true
	executor := dashboardExecutorWithSuccess()
	executor.results["signals.list"] = capability.Result{OK: true, Data: json.RawMessage(`{"signals":[{"id":"bad","severity":"red","module":"//evil.test","subject":"Bad","detail":"unsafe"}]}`)}
	response := httptest.NewRecorder()
	NewMyWorkSessionHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeMyWorkReader{}, executor, nil).
		ServeHTTP(response, myWorkRequest(http.MethodGet))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var got businesscontract.MyWorkResponse
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Cards) != 1 || got.Cards[0].Id != "signals-unavailable" || !validMyWorkActionHref(got.Cards[0].ActionHref) {
		t.Fatalf("unsafe signal projection was not replaced with the unavailable card: %+v", got.Cards)
	}
}
