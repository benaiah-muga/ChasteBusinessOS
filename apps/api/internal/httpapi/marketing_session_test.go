package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func marketingRequest(method, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/marketing", strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://app.example.test")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return request
}

func TestMarketingSessionHandlerReadsSnapshotThroughCapability(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["marketing.read"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"segments":[],"campaigns":[],"sendCounts":[],"recentSends":[]}`)}}
	response := httptest.NewRecorder()
	NewMarketingSessionHandler(resolver, executor, nil).ServeHTTP(response, marketingRequest(http.MethodGet, ""))

	if response.Code != http.StatusOK || response.Body.String() != "{\"segments\":[],\"campaigns\":[],\"sendCounts\":[],\"recentSends\":[]}\n" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.calls != 1 || executor.capID != "marketing.overviewSnapshot" || string(executor.input) != `{}` || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID {
		t.Fatalf("executor call mismatch: %+v", executor)
	}
}

func TestMarketingSessionHandlerRequiresReadPermissionAndRejectsMalformedWrites(t *testing.T) {
	for _, test := range []struct {
		name     string
		method   string
		body     string
		origin   string
		identity *session.ResolvedUser
		want     int
	}{
		{name: "read permission", method: http.MethodGet, identity: directTestIdentity(), want: http.StatusForbidden},
		{name: "foreign origin", method: http.MethodPost, body: `{"action":"createSegment","intentId":"intent-1","name":"Loyal"}`, origin: "https://evil.example", identity: directTestIdentity(), want: http.StatusForbidden},
		{name: "missing intent", method: http.MethodPost, body: `{"action":"createSegment","name":"Loyal"}`, identity: directTestIdentity(), want: http.StatusBadRequest},
		{name: "unknown field", method: http.MethodPost, body: `{"action":"createSegment","intentId":"intent-1","name":"Loyal","extra":true}`, identity: directTestIdentity(), want: http.StatusBadRequest},
		{name: "bad amount", method: http.MethodPost, body: `{"action":"createSegment","intentId":"intent-1","name":"Loyal","minSpendMinor":-1}`, identity: directTestIdentity(), want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.identity}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"segmentId":"11111111-1111-4111-8111-111111111111"}`)}}
			request := marketingRequest(test.method, test.body)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			response := httptest.NewRecorder()
			NewMarketingSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
			if executor.calls != 0 {
				t.Fatalf("invalid request reached executor: %+v", executor)
			}
		})
	}
}

func TestMarketingSessionHandlerExecutesGovernedWritesAndChecksOutput(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["marketing.write"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"segmentId":"11111111-1111-4111-8111-111111111111"}`)}}
	response := httptest.NewRecorder()
	NewMarketingSessionHandler(resolver, executor, nil).ServeHTTP(response, marketingRequest(http.MethodPost, `{"action":"createSegment","intentId":"marketing-create-segment-1","name":"Loyal","minSpendMinor":900}`))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "marketing.createSegment" || string(executor.input) != `{"minSpendMinor":900,"name":"Loyal"}` || executor.claims.IntentID != "marketing-create-segment-1" {
		t.Fatalf("status=%d calls=%d capability=%q intent=%q input=%s body=%s", response.Code, executor.calls, executor.capID, executor.claims.IntentID, executor.input, response.Body.String())
	}

	executor = &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"segmentId":"not-a-uuid"}`)}}
	response = httptest.NewRecorder()
	NewMarketingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, marketingRequest(http.MethodPost, `{"action":"createSegment","intentId":"marketing-create-segment-2","name":"Loyal"}`))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("invalid capability output status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMarketingSessionHandlerReturnsPendingApprovalContract(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["marketing.write"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalRationale: "approval required"}}
	response := httptest.NewRecorder()
	NewMarketingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, marketingRequest(http.MethodPost, `{"action":"sendCampaign","intentId":"marketing-send-1","campaignId":"11111111-1111-4111-8111-111111111111"}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"reason":"approval required"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMarketingSessionHandlerPreservesCapabilityRefusalEnvelope(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["marketing.write"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{Error: "campaign already sent"}}
	response := httptest.NewRecorder()
	NewMarketingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, marketingRequest(http.MethodPost, `{"action":"sendCampaign","intentId":"marketing-send-2","campaignId":"11111111-1111-4111-8111-111111111111"}`))
	if response.Code != http.StatusUnprocessableEntity || response.Body.String() != "{\"error\":\"campaign already sent\",\"ok\":false}\n" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMarketingOutputValidatorsRejectMalformedAndUnknownFields(t *testing.T) {
	validSnapshot := json.RawMessage(`{"segments":[{"id":"11111111-1111-4111-8111-111111111111","name":"Loyal","minSpendMinor":100,"createdAt":"2026-10-15T00:00:00.000Z"}],"campaigns":[{"id":"22222222-2222-4222-8222-222222222222","segmentId":"11111111-1111-4111-8111-111111111111","name":"Launch","subject":"Hello","body":"Body","queuedAt":null,"createdAt":"2026-10-15T00:00:00.000Z"}],"sendCounts":[{"campaignId":"22222222-2222-4222-8222-222222222222","count":1}],"recentSends":[{"id":"33333333-3333-4333-8333-333333333333","campaignId":"22222222-2222-4222-8222-222222222222","customerName":"Customer","customerEmail":null,"queuedAt":"2026-10-15T00:00:00.000Z","status":"queued","sentAt":null}]}`)
	var output capability.MarketingOverviewSnapshotOutput
	if !validMarketingSnapshot(validSnapshot, &output) || len(output.Segments) != 1 || len(output.RecentSends) != 1 {
		t.Fatalf("valid marketing snapshot rejected: %+v", output)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"segments":[],"campaigns":[],"sendCounts":[]}`),
		json.RawMessage(`{"segments":[{"id":"11111111-1111-4111-8111-111111111111","name":"Loyal","minSpendMinor":100,"createdAt":"2026-10-15T00:00:00.000Z","extra":true}],"campaigns":[],"sendCounts":[],"recentSends":[]}`),
		json.RawMessage(`{"segments":[],"campaigns":[{"id":"22222222-2222-4222-8222-222222222222","segmentId":"11111111-1111-4111-8111-111111111111","name":"Launch","subject":"Hello","body":"Body","queuedAt":"bad","createdAt":"2026-10-15T00:00:00.000Z"}],"sendCounts":[],"recentSends":[]}`),
	} {
		if validMarketingSnapshot(raw, &capability.MarketingOverviewSnapshotOutput{}) {
			t.Errorf("malformed marketing snapshot accepted: %s", raw)
		}
	}
	if validMarketingOutput("sendCampaign", json.RawMessage(`{"recipients":1,"skippedOptOut":0,"skippedNoAddress":0,"alreadySent":0,"extra":true}`)) {
		t.Fatal("marketing output with an undocumented field accepted")
	}
}
