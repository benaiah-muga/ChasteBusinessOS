package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeRecordSearchReader struct {
	groups      []recordSearchGroup
	query       string
	permissions map[string]bool
	calls       int
}

func (reader *fakeRecordSearchReader) Search(_ context.Context, _ string, _ string, permissions map[string]bool, query string, _ int) ([]recordSearchGroup, error) {
	reader.calls++
	reader.query = query
	reader.permissions = permissions
	return reader.groups, nil
}

func TestRecordSearchHandlerReturnsPermissionAwareGroups(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeRecordSearchReader{groups: []recordSearchGroup{{
		Type: "customer", Label: "Customers",
		Items: []recordSearchItem{{ID: "c-1", Title: "Acme", Subtitle: "acme@example.test", Href: "/crm"}},
	}}}
	handler := newRecordSearchHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/search?q=Acme", nil)
	request.AddCookie(&http.Cookie{Name: "better-auth.session_token", Value: "search-cookie"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || reader.calls != 1 || reader.query != "Acme" {
		t.Fatalf("status=%d reader=%+v body=%s", response.Code, reader, response.Body.String())
	}
	if !reader.permissions["crm.read"] {
		t.Fatalf("permissions=%v", reader.permissions)
	}
	if strings.TrimSpace(response.Body.String()) != `{"query":"Acme","groups":[{"type":"customer","label":"Customers","items":[{"id":"c-1","title":"Acme","subtitle":"acme@example.test","href":"/crm"}]}]}` {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestRecordSearchHandlerRejectsShortQueriesAndWrongMethods(t *testing.T) {
	reader := &fakeRecordSearchReader{}
	handler := newRecordSearchHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil)
	short := httptest.NewRequest(http.MethodGet, "/api/search?q=a", nil)
	short.AddCookie(&http.Cookie{Name: "better-auth.session_token", Value: "search-cookie"})
	shortResponse := httptest.NewRecorder()
	handler.ServeHTTP(shortResponse, short)
	if shortResponse.Code != http.StatusBadRequest || reader.calls != 0 {
		t.Fatalf("short status=%d calls=%d", shortResponse.Code, reader.calls)
	}
	post := httptest.NewRequest(http.MethodPost, "/api/search?q=acme", nil)
	postResponse := httptest.NewRecorder()
	handler.ServeHTTP(postResponse, post)
	if postResponse.Code != http.StatusMethodNotAllowed || postResponse.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("post status=%d allow=%q", postResponse.Code, postResponse.Header().Get("Allow"))
	}
}
