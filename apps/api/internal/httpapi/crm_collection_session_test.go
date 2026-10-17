package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	crmTestDealID     = "44444444-4444-4444-8444-444444444444"
	crmTestCustomerID = "55555555-5555-4555-8555-555555555555"
)

type crmRoutingExecutor struct {
	calls  int
	capID  string
	input  json.RawMessage
	claims authbridge.CapabilityClaims
	result func(capabilityID string, claims authbridge.CapabilityClaims, input json.RawMessage) (capability.Result, error)
}

func (f *crmRoutingExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims, f.capID, f.input = claims, capabilityID, input
	if f.result != nil {
		return f.result(capabilityID, claims, input)
	}
	return capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil
}

func crmCollectionTestRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return r
}

func crmIsV4UUID(value string) bool {
	if !isUUID(value) {
		return false
	}
	return value[14] == '4' && strings.ContainsRune("89ab", rune(value[19]))
}

func TestCRMCollectionConvertLeadGeneratesDurableIntent(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"dealId":"` + crmTestDealID + `","customerId":"` + crmTestCustomerID + `","stage":"qualified"}`)}}
	handler := NewCRMCollectionSessionHandler(resolver, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crmCollectionTestRequest(http.MethodPost, "/api/crm", `{"action":"convertLead","dealId":"`+crmTestDealID+`","customerName":"Ada"}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var success struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(response.Body.Bytes(), &success) != nil || !success.OK || !strings.Contains(string(success.Data), crmTestDealID) {
		t.Fatalf("response=%s", response.Body.String())
	}
	if executor.calls != 1 || executor.capID != "crm.convertLead" {
		t.Fatalf("executor calls=%d capability=%q", executor.calls, executor.capID)
	}
	if !crmIsV4UUID(executor.claims.IntentID) {
		t.Fatalf("intent=%q, want a generated v4 UUID", executor.claims.IntentID)
	}
	var input map[string]json.RawMessage
	if json.Unmarshal(executor.input, &input) != nil {
		t.Fatalf("input=%s", executor.input)
	}
	if _, hasAction := input["action"]; hasAction {
		t.Fatalf("action leaked into capability input: %s", executor.input)
	}
	if string(input["dealId"]) != `"`+crmTestDealID+`"` || string(input["customerName"]) != `"Ada"` {
		t.Fatalf("input=%s", executor.input)
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID ||
		executor.claims.ActorID == nil || *executor.claims.ActorID != identity.UserID || executor.claims.ActorType != "human" ||
		executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.Audience != authbridge.CapabilityExecuteAudience ||
		strings.Join(executor.claims.Permissions, ",") != "crm.read,sales.write" {
		t.Fatalf("claims=%+v", executor.claims)
	}
}

func TestCRMCollectionTaskActionsHonorCallerIntentAndEnvelopes(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		capID    string
		result   capability.Result
		wantCode int
		wantBody string
	}{
		{
			name:     "create task passes caller intent",
			body:     `{"action":"createTask","title":"Call Ada","intentId":"intent-123"}`,
			capID:    "crm.createTask",
			result:   capability.Result{OK: true, Data: json.RawMessage(`{"taskId":"` + crmTestDealID + `"}`)},
			wantCode: http.StatusOK,
			wantBody: `"ok":true`,
		},
		{
			name:     "pending approval uses legacy envelope",
			body:     `{"action":"completeTask","taskId":"` + crmTestDealID + `"}`,
			capID:    "crm.completeTask",
			result:   capability.Result{PendingApproval: true, Error: "pending human approval", ApprovalRationale: "needs approval"},
			wantCode: http.StatusAccepted,
			wantBody: `"pendingApproval":true`,
		},
		{
			name:     "refusal uses legacy envelope",
			body:     `{"action":"updateTaskDetails","taskId":"` + crmTestDealID + `","note":"hi"}`,
			capID:    "crm.updateTaskDetails",
			result:   capability.Result{OK: false, Error: "invalid input: note is not allowed"},
			wantCode: http.StatusUnprocessableEntity,
			wantBody: `"ok":false`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: tc.result}
			response := httptest.NewRecorder()
			NewCRMCollectionSessionHandler(resolver, executor, nil).ServeHTTP(response, crmCollectionTestRequest(http.MethodPost, "/api/crm", tc.body))
			if response.Code != tc.wantCode || !strings.Contains(response.Body.String(), tc.wantBody) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if executor.capID != tc.capID {
				t.Fatalf("capability=%q, want %q", executor.capID, tc.capID)
			}
			if tc.capID == "crm.createTask" && executor.claims.IntentID != "intent-123" {
				t.Fatalf("intent=%q, want caller intent", executor.claims.IntentID)
			}
		})
	}
}

func TestCRMCollectionCustomerActionsRouteToCapabilities(t *testing.T) {
	cases := []struct {
		body         string
		capID        string
		intentWanted bool
	}{
		{`{"action":"create","name":"Ada"}`, "crm.createCustomer", false},
		{`{"action":"deactivate","customerId":"` + crmTestCustomerID + `"}`, "crm.deactivateCustomer", false},
		{`{"action":"merge","survivorCustomerId":"` + crmTestCustomerID + `","duplicateCustomerId":"` + crmTestDealID + `"}`, "crm.mergeCustomers", true},
		{`{"action":"undoMerge","survivorCustomerId":"` + crmTestCustomerID + `","duplicateCustomerId":"` + crmTestDealID + `","mergeIntentId":"` + crmTestDealID + `"}`, "crm.restoreCustomerMerge", false},
		{`{"action":"updateProfile","customerIds":["` + crmTestCustomerID + `"],"notes":"vip"}`, "crm.updateCustomerProfiles", false},
	}
	for _, tc := range cases {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"deactivated":true}`)}}
		response := httptest.NewRecorder()
		NewCRMCollectionSessionHandler(resolver, executor, nil).ServeHTTP(response, crmCollectionTestRequest(http.MethodPost, "/api/customers", tc.body))
		if response.Code != http.StatusOK || executor.capID != tc.capID {
			t.Fatalf("body=%s status=%d capability=%q response=%s", tc.body, response.Code, executor.capID, response.Body.String())
		}
		if tc.intentWanted && !crmIsV4UUID(executor.claims.IntentID) {
			t.Fatalf("merge intent=%q, want generated v4 UUID", executor.claims.IntentID)
		}
	}
	unknown := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).
		ServeHTTP(unknown, crmCollectionTestRequest(http.MethodPost, "/api/customers", `{"action":"nope"}`))
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown action status=%d body=%s", unknown.Code, unknown.Body.String())
	}
}

func TestCRMCollectionDealsReadEnforcesPermissionAndReturnsRawData(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["crm.read"] = false
	executor := &fakeDirectCapabilityExecutor{}
	denied := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).
		ServeHTTP(denied, crmCollectionTestRequest(http.MethodGet, "/api/deals", ""))
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "forbidden: missing crm.read") || executor.calls != 0 {
		t.Fatalf("status=%d body=%s calls=%d", denied.Code, denied.Body.String(), executor.calls)
	}

	executor = &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"deals":[{"id":"` + crmTestDealID + `"}]}`)}}
	allowed := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).
		ServeHTTP(allowed, crmCollectionTestRequest(http.MethodGet, "/api/deals", ""))
	if allowed.Code != http.StatusOK || strings.TrimSpace(allowed.Body.String()) != `{"deals":[{"id":"`+crmTestDealID+`"}]}` || executor.capID != "crm.listDeals" {
		t.Fatalf("status=%d body=%s capability=%q", allowed.Code, allowed.Body.String(), executor.capID)
	}
}

func TestCRMCollectionDomainErrorsMapToRefusalStatuses(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{name: "missing deal", err: errors.New("deal not found"), want: http.StatusNotFound},
		{name: "domain refusal", err: errors.New("cannot move deal to an earlier stage"), want: http.StatusUnprocessableEntity},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{err: tc.err}
			response := httptest.NewRecorder()
			NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).
				ServeHTTP(response, crmCollectionTestRequest(http.MethodGet, "/api/deals", ""))
			if response.Code != tc.want || !strings.Contains(response.Body.String(), `"error"`) {
				t.Fatalf("status=%d want=%d body=%s", response.Code, tc.want, response.Body.String())
			}
		})
	}
}

func TestCRMCollectionDealsWriteRoutesAndViewsEnvelope(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"moved":true,"stage":"qualified"}`)}}
	response := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).
		ServeHTTP(response, crmCollectionTestRequest(http.MethodPost, "/api/deals", `{"action":"move","dealId":"`+crmTestDealID+`","stage":"qualified"}`))
	if response.Code != http.StatusOK || executor.capID != "crm.moveDealStage" || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
	}
	var input map[string]json.RawMessage
	if json.Unmarshal(executor.input, &input) != nil || string(input["stage"]) != `"qualified"` || input["action"] != nil {
		t.Fatalf("input=%s", executor.input)
	}

	viewExecutor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"viewId":"` + crmTestDealID + `","previous":null}`)}}
	view := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, viewExecutor, nil).
		ServeHTTP(view, crmCollectionTestRequest(http.MethodPost, "/api/crm/views", `{"name":"Mine","filters":{"status":"active","owner":"","staleOnly":false,"duplicateOnly":false,"tag":""},"isShared":false,"isPinned":true,"intentId":"intent-9"}`))
	if view.Code != http.StatusOK || viewExecutor.capID != "crm.saveCustomerView" || viewExecutor.claims.IntentID != "intent-9" {
		t.Fatalf("status=%d capability=%q claims=%+v body=%s", view.Code, viewExecutor.capID, viewExecutor.claims, view.Body.String())
	}
	if !strings.Contains(view.Body.String(), `"viewId"`) || strings.Contains(view.Body.String(), "intent-9") {
		t.Fatalf("wrong view envelope: %s", view.Body.String())
	}

	pending := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, Error: "pending human approval", ApprovalRationale: "policy"}}
	pendingResponse := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, pending, nil).
		ServeHTTP(pendingResponse, crmCollectionTestRequest(http.MethodPost, "/api/crm/views", `{"name":"Mine"}`))
	if pendingResponse.Code != http.StatusAccepted || !strings.Contains(pendingResponse.Body.String(), `"pendingApproval":true`) || !strings.Contains(pendingResponse.Body.String(), `"error":"policy"`) {
		t.Fatalf("status=%d body=%s", pendingResponse.Code, pendingResponse.Body.String())
	}
}

func TestCRMCollectionWritesRequireSameOriginHumanSession(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{}
	handler := NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	crossOrigin := crmCollectionTestRequest(http.MethodPost, "/api/deals", `{"action":"create","title":"Ada","valueMinor":100}`)
	crossOrigin.Header.Set("Origin", "https://evil.example.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crossOrigin)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}

	unauthorized := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{}, executor, nil).
		ServeHTTP(unauthorized, crmCollectionTestRequest(http.MethodPost, "/api/deals", `{"action":"create","title":"Ada","valueMinor":100}`))
	if unauthorized.Code != http.StatusUnauthorized || executor.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", unauthorized.Code, executor.calls, unauthorized.Body.String())
	}
}

func TestCRMCollectionMethodNotAllowedAndFollowUpDraft(t *testing.T) {
	method := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).
		ServeHTTP(method, crmCollectionTestRequest(http.MethodGet, "/api/customers", ""))
	if method.Code != http.StatusMethodNotAllowed || method.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("status=%d allow=%q", method.Code, method.Header().Get("Allow"))
	}

	draftCalls := 0
	var draftBody []byte
	draft := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		draftCalls++
		draftBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"draft":"hello"}`))
	})
	response := httptest.NewRecorder()
	NewCRMCollectionSessionHandlerWithFollowUpDraft(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, draft, nil).
		ServeHTTP(response, crmCollectionTestRequest(http.MethodPost, "/api/crm", `{"action":"draftFollowUp","customerId":"`+crmTestCustomerID+`"}`))
	if response.Code != http.StatusOK || draftCalls != 1 || strings.TrimSpace(string(draftBody)) != `{"customerId":"`+crmTestCustomerID+`"}` {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, draftCalls, draftBody)
	}

	withoutDraft := httptest.NewRecorder()
	NewCRMCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).
		ServeHTTP(withoutDraft, crmCollectionTestRequest(http.MethodPost, "/api/crm", `{"action":"draftFollowUp","customerId":"`+crmTestCustomerID+`"}`))
	if withoutDraft.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", withoutDraft.Code, withoutDraft.Body.String())
	}
}
