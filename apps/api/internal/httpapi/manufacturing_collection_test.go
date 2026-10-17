package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	manufacturingTestOrgID  = "d1d1d1d1-1111-4111-8111-111111111111"
	manufacturingTestUserID = "d2d2d2d2-2222-4222-8222-222222222222"
	manufacturingTestSess   = "d3d3d3d3-3333-4333-8333-333333333333"
)

func manufacturingTestIdentity(permissions ...string) *session.ResolvedUser {
	granted := map[string]bool{}
	for _, permission := range permissions {
		granted[permission] = true
	}
	orgID := manufacturingTestOrgID
	return &session.ResolvedUser{
		UserID: manufacturingTestUserID, OrgID: &orgID,
		Permissions: granted, EmailVerified: true, AuthSessionID: manufacturingTestSess,
	}
}

func manufacturingTestRequest(method, target, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: manufacturingTestOrgID})
	return r
}

func TestManufacturingCollectionGuards(t *testing.T) {
	t.Run("unsupported method", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read")}, &fakeDirectCapabilityExecutor{}, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodDelete, "/api/manufacturing", ""))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" {
			t.Fatalf("status=%d allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
		}
	})

	t.Run("missing session", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{err: session.ErrNoSession}, &fakeDirectCapabilityExecutor{}, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing", ""))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("module disabled", func(t *testing.T) {
		identity := manufacturingTestIdentity("manufacturing.read")
		identity.ModulesRestricted = true
		identity.EnabledModules = []string{"crm"}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing", ""))
		if response.Code != http.StatusNotFound || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestManufacturingCollectionReads(t *testing.T) {
	overview := `{"boms":[{"assemblySku":"DESK","componentSku":"LEG","componentName":"Leg","quantityThousandths":4000,"scrapPctThousandths":0}],"assemblies":[],"workOrders":[],"productionRuns":[],"lots":[]}`

	t.Run("overview is a bare payload", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(overview)}}
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read")}, executor, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing", ""))
		if response.Code != http.StatusOK || executor.capID != "manufacturing.overviewReport" || string(executor.input) != `{}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
		if strings.TrimSpace(response.Body.String()) != overview {
			t.Fatalf("overview response=%s", response.Body.String())
		}
	})

	t.Run("sku without lot code stays on the overview", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(overview)}}
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read")}, executor, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing?sku=DESK", ""))
		if executor.capID != "manufacturing.overviewReport" {
			t.Fatalf("cap=%q body=%s", executor.capID, response.Body.String())
		}
	})

	t.Run("lot trace is enveloped", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"lot":{"code":"L1"},"upstream":[]}`)}}
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read")}, executor, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing?sku=DESK&lotCode=L1", ""))
		if response.Code != http.StatusOK || executor.capID != "manufacturing.lotTrace" || string(executor.input) != `{"lotCode":"L1","sku":"DESK"}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
		var body struct {
			OK   bool            `json:"ok"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.OK || string(body.Data) != `{"lot":{"code":"L1"},"upstream":[]}` {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("missing lot is an untyped 422 refusal", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: errors.New(`no lot "L1" for DESK`)}
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read")}, executor, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing?sku=DESK&lotCode=L1", ""))
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var body map[string]any
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["ok"] != false {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("overview permission refusal is forbidden", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: manufacturing.read"}}
		response := httptest.NewRecorder()
		NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity()}, executor, nil).
			ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing", ""))
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestManufacturingCollectionActions(t *testing.T) {
	newHandler := func(result capability.Result, err error) (http.Handler, *fakeDirectCapabilityExecutor) {
		t.Helper()
		executor := &fakeDirectCapabilityExecutor{result: result, err: err}
		return NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read", "manufacturing.write")}, executor, nil), executor
	}

	t.Run("bom tree forwards the body and the intent", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{"assemblySku":"DESK","components":[]}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
			`{"action":"bomTree","assemblySku":"DESK","intentId":"intent-tree"}`))
		if response.Code != http.StatusOK || executor.capID != "manufacturing.bomTree" || string(executor.input) != `{"assemblySku":"DESK"}` || executor.claims.IntentID != "intent-tree" {
			t.Fatalf("status=%d cap=%q input=%s claims=%+v body=%s", response.Code, executor.capID, executor.input, executor.claims, response.Body.String())
		}
		var body map[string]any
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["ok"] != true {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("reverse run maps runId to runRef", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{"runRef":"R-1"}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
			`{"action":"reverseProductionRun","runId":"R-1"}`))
		if executor.capID != "manufacturing.reverseProductionRun" || string(executor.input) != `{"runRef":"R-1"}` {
			t.Fatalf("cap=%q input=%s body=%s", executor.capID, executor.input, response.Body.String())
		}
	})

	t.Run("reverse run falls back to runRef when runId is null", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
			`{"action":"reverseProductionRun","runId":null,"runRef":"R-2"}`))
		if string(executor.input) != `{"runRef":"R-2"}` {
			t.Fatalf("input=%s body=%s", executor.input, response.Body.String())
		}
	})

	t.Run("unknown or missing action is invalid", func(t *testing.T) {
		for _, body := range []string{`{"action":"restoreBom"}`, `{}`, `{"action":5}`} {
			handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing", body))
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid action") || executor.calls != 0 {
				t.Fatalf("body=%q status=%d calls=%d response=%s", body, response.Code, executor.calls, response.Body.String())
			}
		}
	})

	t.Run("malformed body is a bad request", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing", `{"action":`))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid body") || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("pending approval is accepted", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{OK: false, PendingApproval: true, Error: "needs approval"}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
			`{"action":"produceFromBom","assemblySku":"DESK","quantityThousandths":1000}`))
		if response.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var body map[string]any
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["ok"] != false || body["pendingApproval"] != true || body["reason"] != "needs approval" {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("domain refusals are unprocessable", func(t *testing.T) {
		for _, err := range []error{
			capability.ManufacturingDomainError("insufficient stock: LEG"),
			errors.New("no item with SKU MISSING"),
			errors.New("MISSING has no bill of materials"),
		} {
			handler, _ := newHandler(capability.Result{}, err)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
				`{"action":"bomTree","assemblySku":"MISSING"}`))
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("err=%v status=%d body=%s", err, response.Code, response.Body.String())
			}
			var body map[string]any
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["ok"] != false || body["error"] != err.Error() {
				t.Fatalf("err=%v body=%s", err, response.Body.String())
			}
		}
	})

	t.Run("internal failures are opaque", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{}, errors.New("database connection failed"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
			`{"action":"bomTree","assemblySku":"DESK"}`))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("executor forbidden result is forbidden", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{OK: false, Error: "forbidden: missing permission: manufacturing.write"}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, manufacturingTestRequest(http.MethodPost, "/api/manufacturing",
			`{"action":"createWorkOrder","assemblySku":"DESK","plannedQtyThousandths":1000}`))
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestManufacturingCollectionMountFallsThrough(t *testing.T) {
	baseCalls := 0
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		baseCalls++
		w.WriteHeader(http.StatusNoContent)
	})
	route := NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read")}, &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}, nil)
	handler := MountGoManufacturingCollectionRoute(base, route)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, manufacturingTestRequest(http.MethodGet, "/api/manufacturing/other", ""))
	if response.Code != http.StatusNoContent || baseCalls != 1 {
		t.Fatalf("fallthrough status=%d calls=%d", response.Code, baseCalls)
	}
}

func TestManufacturingCollectionCookieWritesRequireSameOrigin(t *testing.T) {
	handlerFor := func() (http.Handler, *fakeDirectCapabilityExecutor) {
		t.Helper()
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"ok":true}`)}}
		return NewManufacturingCollectionHandler(&fakeDirectSessionResolver{resolved: manufacturingTestIdentity("manufacturing.read", "manufacturing.write")}, executor, nil), executor
	}

	t.Run("cross-site cookie post is refused before execution", func(t *testing.T) {
		handler, executor := handlerFor()
		request := manufacturingTestRequest(http.MethodPost, "/api/manufacturing", `{"action":"createWorkOrder","itemSku":"DESK","quantityThousandths":1000}`)
		request.Header.Del("Origin")
		request.Header.Set("Sec-Fetch-Site", "cross-site")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "same-origin") || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("bearer posts stay allowed without an origin", func(t *testing.T) {
		handler, executor := handlerFor()
		request := manufacturingTestRequest(http.MethodPost, "/api/manufacturing", `{"action":"createWorkOrder","itemSku":"DESK","quantityThousandths":1000}`)
		request.Header.Del("Origin")
		request.Header.Set("Authorization", "Bearer machine-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || executor.calls != 1 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}
