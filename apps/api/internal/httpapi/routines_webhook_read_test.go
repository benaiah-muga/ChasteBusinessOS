package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutineWebhookReadRefusesGetAndFallsThrough(t *testing.T) {
	baseCalls := 0
	var baseMethod, basePath string
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		baseCalls++
		baseMethod, basePath = r.Method, r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})
	handler := MountGoRoutinesWebhookReadRoute(base, NewRoutinesWebhookReadHandler())

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "/api/routines/webhook/tok-1", nil))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost {
			t.Fatalf("method=%s status=%d allow=%q body=%s", method, response.Code, response.Header().Get("Allow"), response.Body.String())
		}
		var body map[string]string
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["error"] != "method not allowed" {
			t.Fatalf("method=%s body=%s", method, response.Body.String())
		}
	}
	if baseCalls != 0 {
		t.Fatalf("refused methods reached the base handler: calls=%d", baseCalls)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/routines/webhook/tok-1", nil))
	if response.Code != http.StatusNoContent || baseCalls != 1 || baseMethod != http.MethodPost || basePath != "/api/routines/webhook/tok-1" {
		t.Fatalf("POST fell through wrong: status=%d calls=%d method=%s path=%s", response.Code, baseCalls, baseMethod, basePath)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/routines/other", nil))
	if response.Code != http.StatusNoContent || baseCalls != 2 {
		t.Fatalf("other path status=%d calls=%d", response.Code, baseCalls)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/routines/webhook/tok-1/extra", nil))
	if response.Code != http.StatusNoContent || baseCalls != 3 {
		t.Fatalf("nested path status=%d calls=%d", response.Code, baseCalls)
	}
}
