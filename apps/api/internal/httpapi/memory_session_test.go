package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type fakeOrgMemoryReader struct {
	rows []orgMemoryProjection
	err  error
	org  string
}

func (r *fakeOrgMemoryReader) ListOrganizationMemory(_ context.Context, orgID string) ([]orgMemoryProjection, error) {
	r.org = orgID
	return r.rows, r.err
}

func TestMemorySessionHandlerListsFilteredRowsAndPreFilterTotal(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeOrgMemoryReader{rows: []orgMemoryProjection{
		{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Kind: "sop", Source: stringPtr("Guide Needle"), Content: "A local memory", CreatedAt: time.Date(2026, 1, 3, 0, 0, 0, 123456789, time.UTC)},
		{ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Kind: "sop", Source: stringPtr("another"), Content: "A memory mentioning needle", CreatedAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)},
		{ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Kind: "decision", Source: nil, Content: "Another local item", CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
	}}
	handler := &MemorySessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity},
		executor: &fakeDirectCapabilityExecutor{}, reader: reader, logger: routinesTestLogger(),
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/memory?q=local&kind=sop", ""))
	if response.Code != http.StatusOK || reader.org != *identity.OrgID {
		t.Fatalf("status=%d readerOrg=%q body=%s", response.Code, reader.org, response.Body.String())
	}
	var body struct {
		Memories []struct {
			ID        string  `json:"id"`
			Kind      string  `json:"kind"`
			Source    *string `json:"source"`
			Content   string  `json:"content"`
			Preview   string  `json:"preview"`
			CreatedAt string  `json:"createdAt"`
		} `json:"memories"`
		Total   int  `json:"total"`
		CanEdit bool `json:"canEdit"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Memories) != 1 || body.Memories[0].ID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" || body.Memories[0].Source == nil || body.Memories[0].CreatedAt != "2026-01-03T00:00:00.123Z" {
		t.Fatalf("memory projection = %+v", body.Memories)
	}
	if body.Total != 3 || body.CanEdit {
		t.Fatalf("total=%d canEdit=%t, want pre-filter total 3 and no write permission", body.Total, body.CanEdit)
	}
}

func TestMemorySessionHandlerRunsGovernedDeletionWithResolvedAuthority(t *testing.T) {
	identity := routinesTestIdentity()
	identity.Permissions["documents.write"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"deleted":true,"kind":"sop"}`)}}
	handler := &MemorySessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor,
		reader: &fakeOrgMemoryReader{}, logger: routinesTestLogger(),
	}
	const memoryID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const intentID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/memory", `{"action":"delete","memoryId":"`+memoryID+`","intentId":"`+intentID+`"}`))
	if response.Code != http.StatusOK || executor.capID != "documents.deleteOrgMemory" || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.IntentID != intentID {
		t.Fatalf("status=%d cap=%q claims=%+v body=%s", response.Code, executor.capID, executor.claims, response.Body.String())
	}
	if string(executor.input) != `{"memoryId":"`+memoryID+`"}` || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("capability input=%s body=%s", executor.input, response.Body.String())
	}
}

func TestMemorySessionHandlerPreservesPendingApprovalResponse(t *testing.T) {
	identity := routinesTestIdentity()
	identity.Permissions["documents.write"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{
		PendingApproval:   true,
		ApprovalRationale: "A human must approve this memory deletion.",
	}}
	handler := &MemorySessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor,
		reader: &fakeOrgMemoryReader{}, logger: routinesTestLogger(),
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/memory", `{"action":"delete","memoryId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`))
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var pending bool
	var hint string
	if err := json.Unmarshal(body["pendingApproval"], &pending); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body["hint"], &hint); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusAccepted || len(body) != 2 || !pending || hint != "Memory deletion proposed by the workmate waits for approval in the Approvals inbox." {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoMemoryRouteFallsThroughUnsupportedMethodsAndPaths(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Route-Owner", "fallback")
		w.WriteHeader(http.StatusNoContent)
	})
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Route-Owner", "go")
		w.WriteHeader(http.StatusNoContent)
	})
	handler := MountGoMemoryRoute(legacy, goRoute)
	for _, tc := range []struct {
		method string
		path   string
		owner  string
	}{
		{http.MethodGet, "/api/memory?q=abc", "go"},
		{http.MethodPost, "/api/memory", "go"},
		{http.MethodHead, "/api/memory", "fallback"},
		{http.MethodDelete, "/api/memory", "fallback"},
		{http.MethodGet, "/api/memory/extra", "fallback"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
		if got := response.Header().Get("X-Route-Owner"); got != tc.owner {
			t.Errorf("%s %s owner=%q, want %q", tc.method, tc.path, got, tc.owner)
		}
	}
}

func TestMemorySessionHandlerRequiresSameOriginForCookieWrites(t *testing.T) {
	identity := routinesTestIdentity()
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"deleted":true}`)}}
	handler := &MemorySessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor,
		reader: &fakeOrgMemoryReader{}, logger: routinesTestLogger(),
	}
	request := routinesSessionRequest(http.MethodPost, "/api/memory", `{"action":"delete","memoryId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`)
	request.Header.Del("Origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("status=%d executorCalls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}
