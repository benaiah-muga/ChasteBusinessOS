package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type salesCustomersTestReader struct {
	data salesCustomersData
	org  string
}

func (r *salesCustomersTestReader) Read(_ context.Context, orgID string) (salesCustomersData, error) {
	r.org = orgID
	return r.data, nil
}

func salesCustomersRequest(orgID string) *http.Request {
	request := salesOrdersRequest("/api/sales/customers")
	if orgID != "" {
		request.Header.Set("X-Organization-ID", orgID)
	}
	return request
}

func TestSalesCustomersSessionHandlerAllowsSalesReadAndReturnsMinimalOptions(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"sales.read": true}
	reader := &salesCustomersTestReader{data: salesCustomersData{Customers: []salesCustomerOption{{ID: "20000000-0000-4000-8000-000000000001", Name: "Amina"}}}}
	response := httptest.NewRecorder()
	newSalesCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, salesCustomersRequest(*identity.OrgID))
	if response.Code != http.StatusOK || reader.org != *identity.OrgID {
		t.Fatalf("status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}
	var body salesCustomersData
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Customers) != 1 || body.Customers[0].Name != "Amina" || body.Customers[0].ID == "" {
		t.Fatalf("customer response=%+v", body)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control=%q", response.Header().Get("Cache-Control"))
	}
}

func TestSalesCustomersSessionHandlerDeniesNonSalesPermission(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"pos.sell": true}
	reader := &salesCustomersTestReader{}
	response := httptest.NewRecorder()
	newSalesCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, salesCustomersRequest(*identity.OrgID))
	if response.Code != http.StatusForbidden || reader.org != "" {
		t.Fatalf("status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}
}

func TestSalesCustomersSessionHandlerRejectsInvalidOrganizationUUID(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"sales.read": true}
	reader := &salesCustomersTestReader{}
	response := httptest.NewRecorder()
	newSalesCustomersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, salesCustomersRequest("org-not-a-uuid"))
	if response.Code != http.StatusBadRequest || reader.org != "" {
		t.Fatalf("status=%d org=%q body=%s", response.Code, reader.org, response.Body.String())
	}
}

func TestMountGoSalesCustomersRouteOnlyHandlesExactGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoSalesCustomersRoute(legacy, routeMarker("go-sales-customers"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/sales/customers", "go-sales-customers"},
		{http.MethodGet, "/api/sales/customers?active=1", "go-sales-customers"},
		{http.MethodPost, "/api/sales/customers", "legacy"},
		{http.MethodGet, "/api/sales/customers/extra", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}

var _ salesCustomersReader = (*salesCustomersTestReader)(nil)
