package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type posCustomersTestReader struct {
	data posCustomersData
	err  error
	org  string
}

func (r *posCustomersTestReader) Read(_ context.Context, orgID string) (posCustomersData, error) {
	r.org = orgID
	return r.data, r.err
}

func TestPosCustomersSessionHandlerAllowsEitherCRMOrPOSSellPermission(t *testing.T) {
	for _, permission := range []string{"crm.read", "pos.sell"} {
		identity := directTestIdentity()
		identity.Permissions = map[string]bool{permission: true}
		reader := &posCustomersTestReader{data: posCustomersData{Customers: []posCustomerOption{{
			ID: "customer-id", Name: "Amina", Email: posReadStringPointer("amina@example.test"), PurchaseCount: 3, LifetimeSpendMinor: 4500,
		}}}}
		response := httptest.NewRecorder()
		newPosCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/pos/customers"))
		if response.Code != http.StatusOK || reader.org != *identity.OrgID {
			t.Fatalf("permission=%s status=%d org=%q body=%s", permission, response.Code, reader.org, response.Body.String())
		}
		var body posCustomersData
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Customers) != 1 || body.Customers[0].PurchaseCount != 3 || body.Customers[0].LifetimeSpendMinor != 4500 {
			t.Fatalf("permission=%s customer response=%+v", permission, body)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("permission=%s cache-control=%q", permission, response.Header().Get("Cache-Control"))
		}
	}
}

func TestPosCustomersSessionHandlerDeniesWithoutEitherPermissionAndSanitizesErrors(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"crm.write": true}
	reader := &posCustomersTestReader{data: posCustomersData{}, err: errors.New("private database detail")}
	response := httptest.NewRecorder()
	newPosCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/pos/customers"))
	if response.Code != http.StatusForbidden || reader.org != "" {
		t.Fatalf("status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}

	identity.Permissions = map[string]bool{"pos.sell": true}
	response = httptest.NewRecorder()
	newPosCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/pos/customers"))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPosCustomersSessionHandlerResolvesBearerAndRejectsUnverifiedSessions(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"pos.sell": true}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &posCustomersTestReader{data: posCustomersData{Customers: []posCustomerOption{}}}
	request := posReadRequest("/api/pos/customers")
	request.Header.Set("Authorization", "Bearer pos-customer-token")
	response := httptest.NewRecorder()
	newPosCustomersSessionHandler(resolver, reader, nil).ServeHTTP(response, request)
	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.resolveCalls != 0 || resolver.bearer != "pos-customer-token" {
		t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
	}

	identity.EmailVerified = false
	response = httptest.NewRecorder()
	newPosCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/pos/customers"))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unverified session status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoPOSCustomersRouteOnlyHandlesExactGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoPOSCustomersRoute(legacy, routeMarker("go-customers"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/pos/customers", "go-customers"},
		{http.MethodGet, "/api/pos/customers?active=1", "go-customers"},
		{http.MethodPost, "/api/pos/customers", "legacy"},
		{http.MethodGet, "/api/pos/customers/extra", "legacy"},
		{http.MethodGet, "/api/pos", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
	response := httptest.NewRecorder()
	MountGoPOSCustomersRoute(legacy, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pos/customers", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled route response=%d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

var _ posCustomersSessionResolver = (*fakeDirectSessionResolver)(nil)
var _ posCustomersReader = (*posCustomersTestReader)(nil)
