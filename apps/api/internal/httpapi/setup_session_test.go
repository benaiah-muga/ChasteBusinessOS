package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeSetupReader struct {
	orgID   string
	payload dashboard.SetupPayload
	err     error
	calls   int
}

func (f *fakeSetupReader) ForOrg(_ context.Context, orgID string) (dashboard.SetupPayload, error) {
	f.calls++
	f.orgID = orgID
	return f.payload, f.err
}

func setupRequest(method string) *http.Request {
	request := httptest.NewRequest(method, "/api/setup", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "setup-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestSetupSessionHandlerReturnsTenantScopedChecklist(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	reader := &fakeSetupReader{payload: dashboard.SetupPayload{
		Items:     []dashboard.SetupItem{{ID: "products", Title: "Add what you sell", Why: "Add products first.", Href: "/products", Done: false}},
		Remaining: 1,
	}}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	response := httptest.NewRecorder()
	NewSetupSessionHandler(resolver, reader, nil).ServeHTTP(response, setupRequest(http.MethodGet))

	if response.Code != http.StatusOK || reader.orgID != *identity.OrgID || reader.calls != 1 {
		t.Fatalf("status=%d org=%q calls=%d body=%s", response.Code, reader.orgID, reader.calls, response.Body.String())
	}
	var got dashboard.SetupPayload
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Remaining != 1 || len(got.Items) != 1 || got.Items[0].ID != "products" {
		t.Fatalf("unexpected setup payload: %+v", got)
	}
}

func TestSetupSessionHandlerRequiresIAMAdmin(t *testing.T) {
	reader := &fakeSetupReader{}
	response := httptest.NewRecorder()
	NewSetupSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(response, setupRequest(http.MethodGet))
	if response.Code != http.StatusForbidden || reader.calls != 0 || !strings.Contains(response.Body.String(), `"error":"forbidden: missing iam.admin"`) {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, reader.calls, response.Body.String())
	}
}

func TestSetupSessionHandlerAllowsWildcardPermission(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["*"] = true
	reader := &fakeSetupReader{}
	response := httptest.NewRecorder()
	NewSetupSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, setupRequest(http.MethodGet))
	if response.Code != http.StatusOK || reader.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, reader.calls, response.Body.String())
	}
}

func TestSetupSessionHandlerFailsClosedOnReaderError(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	response := httptest.NewRecorder()
	reader := &fakeSetupReader{err: errors.New("database unavailable")}
	NewSetupSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, setupRequest(http.MethodGet))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSetupSessionHandlerRejectsUnauthenticatedAndWrongMethod(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewSetupSessionHandler(&fakeDirectSessionResolver{err: session.ErrNoSession}, &fakeSetupReader{}, nil).ServeHTTP(response, setupRequest(http.MethodGet))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("wrong method", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewSetupSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeSetupReader{}, nil).ServeHTTP(response, setupRequest(http.MethodPost))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("status=%d Allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
		}
	})
}
