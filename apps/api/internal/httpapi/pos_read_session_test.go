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

type posReadTestReader struct {
	data posReadData
	err  error
	org  string
}

func (r *posReadTestReader) Read(_ context.Context, orgID string) (posReadData, error) {
	r.org = orgID
	return r.data, r.err
}

func posReadIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"pos.read": true}
	return identity
}

func posReadRequest(path string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *posReadIdentity().OrgID})
	return request
}

func TestPosReadSessionHandlerReturnsLegacyEnvelopeAndRequiresPermission(t *testing.T) {
	identity := posReadIdentity()
	createdAt := legacySessionTime(time.Date(2026, 10, 5, 11, 0, 0, 0, time.UTC))
	reader := &posReadTestReader{data: posReadData{
		Sessions: []posReadSession{{ID: "session-id", OrgID: *identity.OrgID, Register: "main", Status: "open", OpenedAt: createdAt}},
		Sales: []posReadSale{{
			ID: "sale-id", Number: 24, Status: "paid", TotalMinor: 1200, CreditedMinor: 200,
			Method: "cash + card", ReturnMode: "credit-review", UnallocatedCreditMinor: 100,
			Lines: []posReadSaleLine{{ID: "line-id", ItemID: posReadStringPointer("item-id"), Description: "Tea", Quantity: 1000,
				UnitPriceMinor: 1200, ReturnedQuantity: 250, StockTracked: true}}, CreatedAt: createdAt,
		}},
	}}
	response := httptest.NewRecorder()
	newPosReadSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/pos"))
	if response.Code != http.StatusOK || reader.org != *identity.OrgID {
		t.Fatalf("status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}
	want := `{"sessions":[{"id":"session-id","orgId":"` + *identity.OrgID + `","register":"main","status":"open","openingFloatMinor":0,"countedCashMinor":null,"expectedCashMinor":0,"varianceMinor":null,"openedByUserId":null,"closedByUserId":null,"openedAt":"` + createdAt + `","closedAt":null,"varianceReason":null}],"sales":[{"id":"sale-id","number":24,"status":"paid","totalMinor":1200,"creditedMinor":200,"memo":null,"customerId":null,"customerName":null,"method":"cash + card","returnMode":"credit-review","unallocatedCreditMinor":100,"lines":[{"id":"line-id","itemId":"item-id","description":"Tea","quantity":1000,"unitPriceMinor":1200,"taxMinor":0,"returnedQuantity":250,"stockTracked":true}],"createdAt":"` + createdAt + `"}]}` + "\n"
	if response.Body.String() != want {
		t.Fatalf("POS response contract mismatch:\n got: %s want: %s", response.Body.String(), want)
	}

	denied := directTestIdentity()
	denied.Permissions = map[string]bool{"inventory.read": true}
	reader.org = ""
	response = httptest.NewRecorder()
	newPosReadSessionHandler(&fakeDirectSessionResolver{resolved: denied}, reader, nil).ServeHTTP(response, posReadRequest("/api/pos"))
	if response.Code != http.StatusForbidden || reader.org != "" {
		t.Fatalf("permission check status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}
}

func TestPosReadSessionHandlerUsesBearerAndSanitizesReaderErrors(t *testing.T) {
	identity := posReadIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &posReadTestReader{data: posReadData{}, err: errors.New("private database detail")}
	request := posReadRequest("/api/pos")
	request.Header.Set("Authorization", "Bearer native-session-token")
	response := httptest.NewRecorder()
	newPosReadSessionHandler(resolver, reader, nil).ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.bearerCalls != 1 || resolver.resolveCalls != 0 || resolver.bearer != "native-session-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("session resolution mismatch: %+v", resolver)
	}
}

func TestPosSaleMemoMethodFallback(t *testing.T) {
	for _, test := range []struct {
		memo *string
		want string
	}{
		{memo: posReadStringPointer("POS (mobile_money)"), want: "mobile_money"},
		{memo: posReadStringPointer("legacy register invoice"), want: "cash"},
		{memo: nil, want: "cash"},
	} {
		if got := posSaleMemoMethod(test.memo); got != test.want {
			t.Errorf("posSaleMemoMethod(%v) = %q, want %q", test.memo, got, test.want)
		}
	}
}

func TestMountGoPOSReadRouteOnlyHandlesExactGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoPOSReadRoute(legacy, routeMarker("go-pos"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/pos", "go-pos"},
		{http.MethodGet, "/api/pos?status=open", "go-pos"},
		{http.MethodHead, "/api/pos", "legacy"},
		{http.MethodPost, "/api/pos", "legacy"},
		{http.MethodGet, "/api/pos/extra", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}

func posReadStringPointer(value string) *string { return &value }
