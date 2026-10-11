package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type fakeModuleSettingsReader struct {
	settings json.RawMessage
	found    bool
	err      error
	orgID    string
	moduleID string
}

func (r *fakeModuleSettingsReader) ReadModuleSettings(_ context.Context, orgID, moduleID string) (json.RawMessage, bool, error) {
	r.orgID, r.moduleID = orgID, moduleID
	return r.settings, r.found, r.err
}

func TestModuleSettingsSessionHandlerReadsDefaultsAndAppliesInventorySchema(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeModuleSettingsReader{settings: json.RawMessage(`{"defaultUnitLabel":" each ","defaultReorderPointUnits":4,"legacyExtra":true}`), found: true}
	handler := &ModuleSettingsSessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity}, executor: &fakeDirectCapabilityExecutor{}, reader: reader, logger: routinesTestLogger(),
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/module-settings?module=inventory", ""))
	if response.Code != http.StatusOK || reader.orgID != *identity.OrgID || reader.moduleID != "inventory" {
		t.Fatalf("status=%d org=%q module=%q body=%s", response.Code, reader.orgID, reader.moduleID, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	settings, ok := body["settings"].(map[string]any)
	if !ok || body["module"] != "inventory" || settings["defaultUnitLabel"] != "each" || settings["defaultReorderPointUnits"] != float64(4) || settings["legacyExtra"] != nil {
		t.Fatalf("inventory settings response=%+v", body)
	}

	reader.settings, reader.found = json.RawMessage(`{}`), false
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/module-settings?module=inventory", ""))
	if response.Code != http.StatusOK || response.Body.String() != `{"module":"inventory","settings":{}}`+"\n" {
		t.Fatalf("missing row defaults status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestModuleSettingsSessionHandlerValidatesModuleAndUnsupportedWriteContract(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeModuleSettingsReader{settings: json.RawMessage(`{}`)}
	executor := &fakeDirectCapabilityExecutor{}
	handler := &ModuleSettingsSessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor, reader: reader, logger: routinesTestLogger()}
	for _, tc := range []struct {
		method string
		path   string
		body   string
		status int
	}{
		{method: http.MethodGet, path: "/api/module-settings", status: http.StatusBadRequest},
		{method: http.MethodGet, path: "/api/module-settings?module=bad.module", status: http.StatusBadRequest},
		{method: http.MethodPost, path: "/api/module-settings", body: `{"module":"bad.module","settings":{}}`, status: http.StatusBadRequest},
		{method: http.MethodPost, path: "/api/module-settings", body: `{"module":"sales","settings":{}}`, status: http.StatusNotFound},
		{method: http.MethodPost, path: "/api/module-settings", body: `{"module":"inventory","settings":{"defaultReorderPointUnits":1.5}}`, status: http.StatusBadRequest},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, routinesSessionRequest(tc.method, tc.path, tc.body))
		if response.Code != tc.status {
			t.Errorf("%s %s status=%d want=%d body=%s", tc.method, tc.path, response.Code, tc.status, response.Body.String())
		}
	}
	if executor.calls != 0 {
		t.Fatalf("invalid or unsupported writes reached capability executor %d times", executor.calls)
	}
}

func TestModuleSettingsSessionHandlerRunsGovernedWriteAndPreservesEnvelopes(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"module":"inventory","settings":{"defaultUnitLabel":"each"}}`)}}
	handler := &ModuleSettingsSessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor,
		reader: &fakeModuleSettingsReader{}, logger: routinesTestLogger(),
	}
	const intentID = "44444444-4444-4444-8444-444444444444"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/module-settings", `{"module":"inventory","settings":{"defaultUnitLabel":" each ","defaultReorderPointUnits":0,"ignored":true},"intentId":"`+intentID+`"}`))
	hasAdmin := false
	for _, permission := range executor.claims.Permissions {
		if permission == "iam.admin" {
			hasAdmin = true
		}
	}
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "iam.setModuleConfig" || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.IntentID != intentID || !hasAdmin {
		t.Fatalf("status=%d calls=%d capability=%q claims=%+v body=%s", response.Code, executor.calls, executor.capID, executor.claims, response.Body.String())
	}
	if string(executor.input) != `{"module":"inventory","settings":{"defaultReorderPointUnits":0,"defaultUnitLabel":"each"}}` ||
		!strings.Contains(response.Body.String(), `"ok":true`) || !strings.Contains(response.Body.String(), `"data":{"module":"inventory"`) {
		t.Fatalf("input=%s body=%s", executor.input, response.Body.String())
	}

	executor.result = capability.Result{PendingApproval: true}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/module-settings", `{"module":"inventory","settings":{},"intentId":"55555555-5555-4555-8555-555555555555"}`))
	var pending map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	var hint string
	if err := json.Unmarshal(pending["hint"], &hint); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusAccepted || len(pending) != 2 || string(pending["pendingApproval"]) != "true" || hint != "This settings change waits for approval in the Approvals inbox." {
		t.Fatalf("pending envelope status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoModuleSettingsRouteFallsThroughUnsupportedMethodsAndPaths(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "go") })
	handler := MountGoModuleSettingsRoute(fallback, goRoute)
	for _, tc := range []struct{ method, path, owner string }{
		{http.MethodGet, "/api/module-settings?module=inventory", "go"},
		{http.MethodPost, "/api/module-settings", "go"},
		{http.MethodHead, "/api/module-settings", "fallback"},
		{http.MethodDelete, "/api/module-settings", "fallback"},
		{http.MethodGet, "/api/module-settings/extra", "fallback"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
		if got := response.Header().Get("X-Route-Owner"); got != tc.owner {
			t.Errorf("%s %s owner=%q want=%q", tc.method, tc.path, got, tc.owner)
		}
	}
}
