package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type supportCustomersTestReader struct {
	data            supportCustomersData
	org             string
	includeInactive bool
}

func (r *supportCustomersTestReader) Read(_ context.Context, orgID string, includeInactive bool) (supportCustomersData, error) {
	r.org = orgID
	r.includeInactive = includeInactive
	return r.data, nil
}

func TestSupportCustomersSessionHandlerUsesPermissionSpecificCustomerScope(t *testing.T) {
	for _, test := range []struct {
		permission      string
		includeInactive bool
	}{
		{permission: "crm.read", includeInactive: true},
		{permission: "pos.sell", includeInactive: false},
	} {
		identity := directTestIdentity()
		identity.Permissions = map[string]bool{test.permission: true}
		reader := &supportCustomersTestReader{data: supportCustomersData{Customers: []supportCustomerOption{{
			ID: "customer-id", Name: "Amina", Email: posReadStringPointer("amina@example.test"),
		}}}}
		response := httptest.NewRecorder()
		newSupportCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/support/customers"))
		if response.Code != http.StatusOK || reader.org != *identity.OrgID || reader.includeInactive != test.includeInactive {
			t.Fatalf("permission=%s status=%d org=%q includeInactive=%t body=%s", test.permission, response.Code, reader.org, reader.includeInactive, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("permission=%s cache-control=%q", test.permission, response.Header().Get("Cache-Control"))
		}
	}
}

func TestSupportCustomersSessionHandlerRequiresCRMOrPOSSellAndHonorsOrgSelector(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"crm.write": true}
	reader := &supportCustomersTestReader{}
	response := httptest.NewRecorder()
	newSupportCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, posReadRequest("/api/support/customers"))
	if response.Code != http.StatusForbidden || reader.org != "" {
		t.Fatalf("denied status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}

	identity.Permissions = map[string]bool{"pos.sell": true}
	request := posReadRequest("/api/support/customers")
	request.Header.Set("X-Organization-ID", "00000000-0000-4000-8000-000000000099")
	response = httptest.NewRecorder()
	newSupportCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || reader.org != "" {
		t.Fatalf("foreign org selector status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}
}

func TestMountGoSupportCustomersRouteHandlesOnlyExactGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoSupportCustomersRoute(legacy, routeMarker("go-support-customers"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/support/customers", "go-support-customers"},
		{http.MethodGet, "/api/support/customers/extra", "legacy"},
		{http.MethodPost, "/api/support/customers", "legacy"},
		{http.MethodGet, "/api/customers", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}

var _ supportCustomersReader = (*supportCustomersTestReader)(nil)
