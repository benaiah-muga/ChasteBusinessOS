package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

func TestSessionCapabilityHandlerGatesPurchasingWorkflowWithServerFlag(t *testing.T) {
	for _, test := range []struct {
		name       string
		enabled    bool
		wantStatus int
		wantExec   int
	}{
		{name: "default off", wantStatus: http.StatusServiceUnavailable},
		{name: "enabled", enabled: true, wantStatus: http.StatusOK, wantExec: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			identity := directTestIdentity()
			identity.Permissions["purchasing.read"] = true
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{
				OK:   true,
				Data: json.RawMessage(`{"requests":[]}`),
			}}
			handler := NewSessionCapabilityHandlerWithDisabledCapabilities(
				&fakeDirectSessionResolver{resolved: identity}, executor, nil,
				PurchasingWorkflowDisabledCapabilities(test.enabled),
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost,
				`{"capabilityId":"purchasing.listPurchaseWorkflow","input":{},"intentId":"purchasing-workflow-read-intent"}`,
			))
			if response.Code != test.wantStatus || executor.calls != test.wantExec {
				t.Fatalf("status=%d executor=%d body=%s, want status=%d executor=%d", response.Code, executor.calls, response.Body.String(), test.wantStatus, test.wantExec)
			}
			if test.enabled && executor.capID != "purchasing.listPurchaseWorkflow" {
				t.Fatalf("capability=%q, want purchasing.listPurchaseWorkflow", executor.capID)
			}
		})
	}
}
