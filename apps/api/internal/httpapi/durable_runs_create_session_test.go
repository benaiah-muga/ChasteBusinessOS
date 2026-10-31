package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/jobs"
)

type fakeDurableRunsStarter struct {
	input  jobs.StartDurableRunInput
	result jobs.StartDurableRunResult
	err    error
	calls  int
}

func newDurableRunCreateTestHandler(resolver durableRunsSessionResolver, reader durableRunsSessionReader, starter durableRunsSessionStarter) *DurableRunsSessionHandler {
	handler := newDurableRunsSessionHandler(resolver, reader, nil).(*DurableRunsSessionHandler)
	handler.starter = starter
	return handler
}

func (f *fakeDurableRunsStarter) CreateAndDispatch(_ context.Context, input jobs.StartDurableRunInput) (jobs.StartDurableRunResult, error) {
	f.calls++
	f.input = input
	return f.result, f.err
}

func TestDurableRunCreateRouteAuthenticatesAndDispatchesThroughStarter(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["harness.approve"] = true
	identity.Permissions["crm.read"] = true
	starter := &fakeDurableRunsStarter{result: jobs.StartDurableRunResult{RunID: "55555555-5555-4555-8555-555555555555"}}
	handler := newDurableRunCreateTestHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDurableRunsSessionReader{}, starter)
	body := `{"runId":"55555555-5555-4555-8555-555555555555","goal":"Read the customer list","harnessCompositionId":"66666666-6666-4666-8666-666666666666","harnessCompositionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compositionApprovalId":"77777777-7777-4777-8777-777777777777","steps":[{"capabilityId":"crm.listCustomers","input":{}}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || starter.calls != 1 || starter.input.OrgID != *identity.OrgID || starter.input.ActorID != identity.UserID || starter.input.Steps[0].CapabilityID != "crm.listCustomers" {
		t.Fatalf("status=%d calls=%d input=%+v body=%s", response.Code, starter.calls, starter.input, response.Body.String())
	}
	var responseBody map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &responseBody); err != nil || responseBody["runId"] != starter.result.RunID || responseBody["status"] != "pending" {
		t.Fatalf("response=%s err=%v", response.Body.String(), err)
	}
}

func TestDurableRunCreateRouteRequiresHarnessAndStepPermissions(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["crm.read"] = true
	starter := &fakeDurableRunsStarter{}
	handler := newDurableRunCreateTestHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDurableRunsSessionReader{}, starter)
	body := `{"runId":"55555555-5555-4555-8555-555555555555","goal":"Read the customer list","harnessCompositionId":"66666666-6666-4666-8666-666666666666","harnessCompositionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compositionApprovalId":"77777777-7777-4777-8777-777777777777","steps":[{"capabilityId":"crm.listCustomers","input":{}}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || starter.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s, want forbidden before dispatch", response.Code, starter.calls, response.Body.String())
	}

	identity.Permissions["harness.approve"] = true
	identity.Permissions["crm.read"] = false
	request = httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-token")
	response = httptest.NewRecorder()
	handler = newDurableRunCreateTestHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDurableRunsSessionReader{}, starter)
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || starter.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s, want forbidden before dispatch", response.Code, starter.calls, response.Body.String())
	}
}

func TestDurableRunCreateRouteRejectsConflictingRunID(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["harness.approve"] = true
	identity.Permissions["crm.read"] = true
	starter := &fakeDurableRunsStarter{err: jobs.ErrDurableRunConflict}
	handler := newDurableRunCreateTestHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDurableRunsSessionReader{}, starter)
	body := `{"runId":"55555555-5555-4555-8555-555555555555","goal":"Read the customer list","harnessCompositionId":"66666666-6666-4666-8666-666666666666","harnessCompositionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compositionApprovalId":"77777777-7777-4777-8777-777777777777","steps":[{"capabilityId":"crm.listCustomers","input":{}}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || starter.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, starter.calls, response.Body.String())
	}
}

func TestDurableRunCreateRouteHidesInternalDispatchErrors(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["harness.approve"] = true
	identity.Permissions["crm.read"] = true
	starter := &fakeDurableRunsStarter{err: errors.New("private database detail")}
	handler := newDurableRunCreateTestHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDurableRunsSessionReader{}, starter)
	body := `{"runId":"55555555-5555-4555-8555-555555555555","goal":"Read the customer list","harnessCompositionId":"66666666-6666-4666-8666-666666666666","harnessCompositionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compositionApprovalId":"77777777-7777-4777-8777-777777777777","steps":[{"capabilityId":"crm.listCustomers","input":{}}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") {
		t.Fatalf("status=%d body=%s, want hidden internal error", response.Code, response.Body.String())
	}
}
