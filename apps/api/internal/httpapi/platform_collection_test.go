package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	platformTestUserID     = "10000000-0000-4000-8000-000000000001"
	platformTestOrgID      = "10000000-0000-4000-8000-000000000002"
	platformTestSessionID  = "10000000-0000-4000-8000-000000000003"
	platformTestProposalID = "10000000-0000-4000-8000-000000000004"
	platformTestGapTicket  = "10000000-0000-4000-8000-000000000005"
	platformTestReleaseID  = "10000000-0000-4000-8000-000000000006"
	platformTestListingID  = "10000000-0000-4000-8000-000000000007"
	platformTestDigest     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

func platformTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func platformTestString(value string) *string {
	return &value
}

type platformTestResolver struct {
	user *session.ResolvedUser
	err  error
}

func (r platformTestResolver) Resolve(context.Context, string, string) (*session.ResolvedUser, error) {
	return r.user, r.err
}

type platformTestBearerResolver struct{ platformTestResolver }

func (r platformTestBearerResolver) ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error) {
	return r.user, r.err
}

func platformTestUser() *session.ResolvedUser {
	orgID := platformTestOrgID
	return &session.ResolvedUser{
		UserID: platformTestUserID, Email: "platform-user@example.test", OrgID: &orgID,
		Permissions:   map[string]bool{"platform.creator": true, "harness.approve": true},
		EmailVerified: true, AuthSessionID: platformTestSessionID,
	}
}

type platformTestExecutor struct {
	calls          int
	lastClaims     authbridge.CapabilityClaims
	lastCapability string
	lastInput      json.RawMessage
	fn             func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error)
}

func (e *platformTestExecutor) Execute(ctx context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	e.calls++
	e.lastClaims = claims
	e.lastCapability = capabilityID
	e.lastInput = append(json.RawMessage(nil), input...)
	if e.fn != nil {
		return e.fn(ctx, claims, capabilityID, input)
	}
	return capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil
}

func platformTestRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.TLS = &tls.ConnectionState{}
	req.Host = "app.example.test"
	req.Header.Set("Origin", "https://app.example.test")
	req.Header.Set("X-Organization-ID", platformTestOrgID)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func platformTestDecode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return body
}

func TestPlatformHandlerConstructorsRejectMissingDependencies(t *testing.T) {
	logger := platformTestLogger()
	executor := &platformTestExecutor{}
	if _, err := NewCapabilityGapsHandler(nil, executor, nil, logger); err == nil {
		t.Fatal("capability gaps accepted a nil resolver")
	}
	if _, err := NewCapabilityGapsHandler(platformTestResolver{}, nil, nil, logger); err == nil {
		t.Fatal("capability gaps accepted a nil executor")
	}
	if _, err := NewHarnessCompositionsHandler(nil, executor, nil, logger); err == nil {
		t.Fatal("harness compositions accepted a nil resolver")
	}
	if _, err := NewHarnessCompositionsHandler(platformTestResolver{}, nil, nil, logger); err == nil {
		t.Fatal("harness compositions accepted a nil executor")
	}
	if _, err := NewProposalsHandler(nil, executor, nil, logger); err == nil {
		t.Fatal("proposals accepted a nil resolver")
	}
	if _, err := NewProposalsHandler(platformTestResolver{}, nil, nil, logger); err == nil {
		t.Fatal("proposals accepted a nil executor")
	}
	if _, err := NewMarketplaceHandler(nil, executor, nil, logger); err == nil {
		t.Fatal("marketplace accepted a nil resolver")
	}
	if _, err := NewMarketplaceHandler(platformTestResolver{}, nil, nil, logger); err == nil {
		t.Fatal("marketplace accepted a nil executor")
	}
	if _, err := NewCreatorEvolutionHandler(nil, executor, nil, logger); err == nil {
		t.Fatal("creator evolution accepted a nil resolver")
	}
	if _, err := NewCreatorEvolutionHandler(platformTestResolver{}, nil, nil, logger); err == nil {
		t.Fatal("creator evolution accepted a nil executor")
	}
	if _, err := NewCreatorAgentHandler(nil, nil, logger); err == nil {
		t.Fatal("creator agent accepted a nil resolver")
	}
}

func TestCapabilityGapsHandlerContract(t *testing.T) {
	logger := platformTestLogger()
	unauthenticated, err := NewCapabilityGapsHandler(platformTestResolver{}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/capability-gaps", ""))
	if response.Code != http.StatusUnauthorized || platformTestDecode(t, response)["error"] != "unauthorized" {
		t.Fatalf("unauthenticated status=%d body=%s, want 401 unauthorized", response.Code, response.Body.String())
	}

	forbiddenExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: false, Error: "forbidden: missing permission: platform.creator"}, nil
	}}
	forbidden, err := NewCapabilityGapsHandler(platformTestResolver{user: platformTestUser()}, forbiddenExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	forbidden.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/capability-gaps", ""))
	if response.Code != http.StatusForbidden || platformTestDecode(t, response)["error"] != "requires platform.creator permission" {
		t.Fatalf("forbidden status=%d body=%s, want 403 requires platform.creator permission", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("capability gaps cache headers=%q/%q, want no-store/no-cache", response.Header().Get("Cache-Control"), response.Header().Get("Pragma"))
	}

	disabledExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: false, Error: `creator module is disabled for this organization`}, nil
	}}
	disabled, err := NewCapabilityGapsHandler(platformTestResolver{user: platformTestUser()}, disabledExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/capability-gaps", ""))
	if response.Code != http.StatusNotFound || platformTestDecode(t, response)["error"] != "not found" {
		t.Fatalf("module-disabled status=%d body=%s, want 404 not found", response.Code, response.Body.String())
	}

	data := `{"gaps":[{"id":"` + platformTestProposalID + `","title":"Gap","description":"Missing capability","status":"open","createdAt":"2026-01-01T00:00:00.000Z"}]}`
	executor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(data)}, nil
	}}
	handler, err := NewCapabilityGapsHandler(platformTestResolver{user: platformTestUser()}, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/capability-gaps", ""))
	body := platformTestDecode(t, response)
	gaps, _ := body["gaps"].([]any)
	if response.Code != http.StatusOK || len(gaps) != 1 {
		t.Fatalf("success status=%d body=%s, want one gap", response.Code, response.Body.String())
	}
	if executor.lastCapability != "creator.listCapabilityGaps" || string(executor.lastInput) != "{}" {
		t.Fatalf("executor capability=%q input=%s, want creator.listCapabilityGaps {}", executor.lastCapability, executor.lastInput)
	}
	if executor.lastClaims.ActorType != "human" || executor.lastClaims.AuthSessionID != platformTestSessionID ||
		executor.lastClaims.OrganizationID != platformTestOrgID || executor.lastClaims.Subject != platformTestUserID {
		t.Fatalf("executor claims=%+v, want human session claims for the resolved user", executor.lastClaims)
	}

	unsupported, err := NewCapabilityGapsHandler(platformTestResolver{user: platformTestUser()}, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	unsupported.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/capability-gaps", ""))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
		t.Fatalf("unsupported method status=%d allow=%q, want 405 GET", response.Code, response.Header().Get("Allow"))
	}
}

func TestHarnessCompositionsHandlerContract(t *testing.T) {
	logger := platformTestLogger()
	forbiddenExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: false, Error: "forbidden: missing permission: harness.approve"}, nil
	}}
	forbidden, err := NewHarnessCompositionsHandler(platformTestResolver{user: platformTestUser()}, forbiddenExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	forbidden.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/harness/compositions", ""))
	if response.Code != http.StatusForbidden || platformTestDecode(t, response)["error"] != "requires harness.approve permission" {
		t.Fatalf("forbidden status=%d body=%s, want 403 requires harness.approve permission", response.Code, response.Body.String())
	}

	data := `{"compositions":[{"id":"` + platformTestProposalID + `","name":"support-triage"}]}`
	executor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(data)}, nil
	}}
	handler, err := NewHarnessCompositionsHandler(platformTestResolver{user: platformTestUser()}, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/harness/compositions", ""))
	body := platformTestDecode(t, response)
	compositions, _ := body["compositions"].([]any)
	if response.Code != http.StatusOK || len(compositions) != 1 {
		t.Fatalf("success status=%d body=%s, want one composition", response.Code, response.Body.String())
	}
	if executor.lastCapability != "harness.listCompositions" {
		t.Fatalf("executor capability=%q, want harness.listCompositions", executor.lastCapability)
	}
}

func TestProposalsCollectionContract(t *testing.T) {
	logger := platformTestLogger()
	user := platformTestUser()

	executor := &platformTestExecutor{}
	handler, err := NewProposalsHandler(platformTestResolver{user: user}, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/proposals?status=archived", ""))
	body := platformTestDecode(t, response)
	proposals, _ := body["proposals"].([]any)
	if response.Code != http.StatusOK || len(proposals) != 0 || executor.calls != 0 {
		t.Fatalf("invalid status status=%d body=%s calls=%d, want an empty page without execution", response.Code, response.Body.String(), executor.calls)
	}

	filteredExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"proposals":[]}`)}, nil
	}}
	filtered, err := NewProposalsHandler(platformTestResolver{user: user}, filteredExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	filtered.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/proposals?status=approved", ""))
	if response.Code != http.StatusOK || filteredExecutor.lastCapability != "creator.listProposals" {
		t.Fatalf("filtered status=%d capability=%q, want 200 creator.listProposals", response.Code, filteredExecutor.lastCapability)
	}
	if string(filteredExecutor.lastInput) != `{"status":"approved"}` {
		t.Fatalf("filtered input=%s, want status forwarded", filteredExecutor.lastInput)
	}

	reviewBody := `{"proposalId":"` + platformTestProposalID + `","decision":"approved"}`

	malformed, err := NewProposalsHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	malformed.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/proposals", "{"))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != "invalid body" {
		t.Fatalf("malformed status=%d body=%s, want 400 invalid body", response.Code, response.Body.String())
	}

	invalidDecision, err := NewProposalsHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	invalidDecision.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/proposals", `{"proposalId":"`+platformTestProposalID+`","decision":"maybe"}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid decision status=%d body=%s, want 400", response.Code, response.Body.String())
	}

	conflictExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{}, capability.CreatorDomainError("conflict: proposal already decided or no longer in review")
	}}
	conflict, err := NewProposalsHandler(platformTestResolver{user: user}, conflictExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	conflict.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/proposals", reviewBody))
	if response.Code != http.StatusConflict || platformTestDecode(t, response)["error"] != "conflict: proposal already decided or no longer in review" {
		t.Fatalf("conflict status=%d body=%s, want 409 conflict", response.Code, response.Body.String())
	}

	missingExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{}, capability.CreatorDomainError("creator proposal not found for organization")
	}}
	missing, err := NewProposalsHandler(platformTestResolver{user: user}, missingExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	missing.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/proposals", reviewBody))
	if response.Code != http.StatusNotFound || platformTestDecode(t, response)["error"] != "not found" {
		t.Fatalf("missing status=%d body=%s, want 404 not found", response.Code, response.Body.String())
	}

	reviewExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"note":"decision recorded; merge the change through your normal PR flow"}`)}, nil
	}}
	review, err := NewProposalsHandler(platformTestResolver{user: user}, reviewExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	review.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/proposals", reviewBody))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusOK || body["ok"] != true || body["note"] != "decision recorded; merge the change through your normal PR flow" {
		t.Fatalf("review status=%d body=%s, want recorded decision note", response.Code, response.Body.String())
	}
	if reviewExecutor.lastCapability != "creator.reviewProposal" || reviewExecutor.lastClaims.IntentID != "" {
		t.Fatalf("review capability=%q intent=%q, want creator.reviewProposal without intent", reviewExecutor.lastCapability, reviewExecutor.lastClaims.IntentID)
	}

	crossOrigin, err := NewProposalsHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	request := platformTestRequest(http.MethodPost, "/api/proposals", reviewBody)
	request.Header.Del("Origin")
	response = httptest.NewRecorder()
	crossOrigin.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || platformTestDecode(t, response)["error"] != "origin check failed" {
		t.Fatalf("cross-origin status=%d body=%s, want 403 origin check failed", response.Code, response.Body.String())
	}

	bearer, err := NewProposalsHandler(platformTestBearerResolver{platformTestResolver{user: user}}, reviewExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	request = platformTestRequest(http.MethodPost, "/api/proposals", reviewBody)
	request.Header.Del("Origin")
	request.Header.Set("Authorization", "Bearer native-client-token")
	response = httptest.NewRecorder()
	bearer.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("bearer review status=%d body=%s, want 200 without an origin header", response.Code, response.Body.String())
	}
}

func TestMarketplaceCollectionContract(t *testing.T) {
	logger := platformTestLogger()
	user := platformTestUser()

	listExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"listings":[]}`)}, nil
	}}
	list, err := NewMarketplaceHandler(platformTestResolver{user: user}, listExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	list.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/marketplace", ""))
	if response.Code != http.StatusOK || listExecutor.lastCapability != "creator.listMarketplace" {
		t.Fatalf("list status=%d capability=%q, want 200 creator.listMarketplace", response.Code, listExecutor.lastCapability)
	}

	manifest := `"manifest":{"slug":"demo-plugin","version":"1.0.0"},"signatureBase64":"c2lnbmF0dXJl","publisherPublicKeyBase64":"cHVibGlzaGVyS2V5"`

	invalidVerdictExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"valid":false,"reason":"signature verification failed"}`)}, nil
	}}
	invalidVerdict, err := NewMarketplaceHandler(platformTestResolver{user: user}, invalidVerdictExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	invalidVerdict.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"verify",`+manifest+`}`))
	body := platformTestDecode(t, response)
	if response.Code != http.StatusUnprocessableEntity || body["valid"] != false || body["reason"] != "signature verification failed" {
		t.Fatalf("invalid verdict status=%d body=%s, want 422 valid:false", response.Code, response.Body.String())
	}

	validVerdictExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"valid":true}`)}, nil
	}}
	validVerdict, err := NewMarketplaceHandler(platformTestResolver{user: user}, validVerdictExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	validVerdict.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"verify",`+manifest+`}`))
	if response.Code != http.StatusOK || platformTestDecode(t, response)["valid"] != true {
		t.Fatalf("valid verdict status=%d body=%s, want 200 valid:true", response.Code, response.Body.String())
	}

	refusalExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: false, Error: "publisherPublicKeyBase64 must be at least 16 characters"}, nil
	}}
	refusal, err := NewMarketplaceHandler(platformTestResolver{user: user}, refusalExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	refusal.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"verify",`+manifest+`}`))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusUnprocessableEntity || body["valid"] != false || body["reason"] != "publisherPublicKeyBase64 must be at least 16 characters" {
		t.Fatalf("verify refusal status=%d body=%s, want 422 valid:false reason", response.Code, response.Body.String())
	}

	publishExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"listingId":"` + platformTestListingID + `","slug":"demo-plugin","status":"published"}`)}, nil
	}}
	publish, err := NewMarketplaceHandler(platformTestResolver{user: user}, publishExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	publish.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"publish","intentId":"publish-plugin",`+manifest+`}`))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusOK || body["ok"] != true {
		t.Fatalf("publish status=%d body=%s, want ok:true", response.Code, response.Body.String())
	}
	if publishExecutor.lastCapability != "creator.publishListing" || publishExecutor.lastClaims.IntentID != "publish-plugin" {
		t.Fatalf("publish capability=%q intent=%q, want creator.publishListing publish-plugin", publishExecutor.lastCapability, publishExecutor.lastClaims.IntentID)
	}
	if !strings.Contains(string(publishExecutor.lastInput), `"signatureBase64"`) || !strings.Contains(string(publishExecutor.lastInput), `"publisherPublicKeyBase64"`) {
		t.Fatalf("publish input=%s, want manifest signature and publisher key", publishExecutor.lastInput)
	}

	missingManifest, err := NewMarketplaceHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	missingManifest.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"publish"}`))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != "manifest, signature and publisher key required" {
		t.Fatalf("missing manifest status=%d body=%s, want 400 manifest message", response.Code, response.Body.String())
	}

	installExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"installed":true,"slug":"demo-plugin","version":"1.0.0"}`)}, nil
	}}
	install, err := NewMarketplaceHandler(platformTestResolver{user: user}, installExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	install.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"install","listingId":"`+platformTestListingID+`"}`))
	if response.Code != http.StatusOK || platformTestDecode(t, response)["ok"] != true || installExecutor.lastCapability != "creator.installListing" {
		t.Fatalf("install status=%d body=%s capability=%q, want ok:true creator.installListing", response.Code, response.Body.String(), installExecutor.lastCapability)
	}

	missingListing, err := NewMarketplaceHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	missingListing.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"uninstall"}`))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != "invalid action" {
		t.Fatalf("missing listing status=%d body=%s, want 400 invalid action", response.Code, response.Body.String())
	}

	unknown, err := NewMarketplaceHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	unknown.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/marketplace", `{"action":"teleport"}`))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != "invalid action" {
		t.Fatalf("unknown action status=%d body=%s, want 400 invalid action", response.Code, response.Body.String())
	}

	deniedExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{}, capability.ErrNotMember
	}}
	denied, err := NewMarketplaceHandler(platformTestResolver{user: user}, deniedExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	denied.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/marketplace", ""))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusForbidden || body["ok"] != false || body["error"] != "forbidden" {
		t.Fatalf("denied status=%d body=%s, want 403 ok:false forbidden", response.Code, response.Body.String())
	}

	disabledExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: false, Error: `creator module is disabled for this organization`}, nil
	}}
	disabled, err := NewMarketplaceHandler(platformTestResolver{user: user}, disabledExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/marketplace", ""))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusNotFound || body["ok"] != false || body["error"] != "not found" {
		t.Fatalf("module-disabled status=%d body=%s, want 404 ok:false not found", response.Code, response.Body.String())
	}
}

func TestCreatorEvolutionContract(t *testing.T) {
	logger := platformTestLogger()
	user := platformTestUser()

	stageBody := `{"action":"stage","proposalId":"` + platformTestProposalID + `","gapTicketId":"` + platformTestGapTicket +
		`","candidateDigest":"` + platformTestDigest + `","artifactRef":"artifact://candidate-one"}`

	invalidStage, err := NewCreatorEvolutionHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	invalidStage.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/creator/evolution", `{"action":"stage","proposalId":"not-a-uuid"}`))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != "invalid body" {
		t.Fatalf("invalid stage status=%d body=%s, want 400 invalid body", response.Code, response.Body.String())
	}

	stageExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"releaseId":"` + platformTestReleaseID + `","status":"staged"}`)}, nil
	}}
	stage, err := NewCreatorEvolutionHandler(platformTestResolver{user: user}, stageExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	stage.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/creator/evolution", stageBody))
	if response.Code != http.StatusOK || platformTestDecode(t, response)["ok"] != true || stageExecutor.lastCapability != "creator.stageCandidate" {
		t.Fatalf("stage status=%d body=%s capability=%q, want 200 ok:true creator.stageCandidate", response.Code, response.Body.String(), stageExecutor.lastCapability)
	}
	if !strings.Contains(string(stageExecutor.lastInput), `"candidateDigest":"`+platformTestDigest+`"`) {
		t.Fatalf("stage input=%s, want canonical digest field", stageExecutor.lastInput)
	}

	unknown, err := NewCreatorEvolutionHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	unknown.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/creator/evolution", `{"action":"launch"}`))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != "invalid body" {
		t.Fatalf("unknown action status=%d body=%s, want 400 invalid body", response.Code, response.Body.String())
	}

	pendingExecutor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: false, PendingApproval: true, ApprovalID: "approval-1", Error: "Approval required."}, nil
	}}
	canaryBody := `{"action":"canary","releaseId":"` + platformTestReleaseID + `","gapTicketId":"` + platformTestGapTicket +
		`","candidateDigest":"` + platformTestDigest + `","verdict":"pass","evidenceRef":"evidence://canary-run-1"}`
	canary, err := NewCreatorEvolutionHandler(platformTestResolver{user: user}, pendingExecutor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	canary.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/creator/evolution", canaryBody))
	body := platformTestDecode(t, response)
	if response.Code != http.StatusAccepted || body["ok"] != false || body["pendingApproval"] != true || body["approvalId"] != "approval-1" {
		t.Fatalf("canary pending status=%d body=%s, want 202 pending approval", response.Code, response.Body.String())
	}
	if pendingExecutor.lastCapability != "creator.recordCanaryOutcome" {
		t.Fatalf("canary capability=%q, want creator.recordCanaryOutcome", pendingExecutor.lastCapability)
	}

	unavailable, err := NewCreatorEvolutionHandler(platformTestResolver{user: user}, &platformTestExecutor{}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	unavailable.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/creator/evolution", ""))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "POST" {
		t.Fatalf("unsupported method status=%d allow=%q, want 405 POST", response.Code, response.Header().Get("Allow"))
	}
}

type platformTestAgentRunner struct {
	detection codingAgentDetection
	err       error
}

func (r platformTestAgentRunner) Detect(context.Context) (codingAgentDetection, error) {
	return r.detection, r.err
}

func TestLocalCodingAgentDetectorUsesBinariesAndConfigDirs(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".config", "opencode"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(binDir, "codex")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'codex-cli 9.9.9'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	detector := &localCodingAgentDetector{home: home, pathEnv: binDir, statPath: os.Stat, runVersion: probeCodingAgentVersion}
	detection, err := detector.Detect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !detection.Installed || detection.CLI == nil || *detection.CLI != "codex" {
		t.Fatalf("detection=%+v, want codex installed via binary", detection)
	}
	if detection.Label == nil || *detection.Label != "OpenAI Codex CLI" {
		t.Fatalf("detection label=%v, want OpenAI Codex CLI", detection.Label)
	}
	if detection.Version == nil || *detection.Version != "codex-cli 9.9.9" {
		t.Fatalf("detection version=%v, want probed version", detection.Version)
	}
	if len(detection.Agents) != 2 {
		t.Fatalf("agents=%+v, want codex binary plus opencode config hit", detection.Agents)
	}
	if detection.Agents[0].ID != "codex" || !detection.Agents[0].ViaBinary {
		t.Fatalf("first agent=%+v, want the binary hit ranked first", detection.Agents[0])
	}
	opencode := detection.Agents[1]
	if opencode.ID != "opencode" || opencode.ViaBinary || len(opencode.ConfigDirs) != 1 || opencode.ConfigDirs[0] != "~/.config/opencode" {
		t.Fatalf("config-only agent=%+v, want opencode with a shortened config dir", opencode)
	}
	if len(detection.Candidates) != 6 || detection.Candidates[0].CLI != "claude" {
		t.Fatalf("candidates=%+v, want the six wizard install hints", detection.Candidates)
	}

	configOnlyHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(configOnlyHome, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	configOnly := &localCodingAgentDetector{home: configOnlyHome, pathEnv: t.TempDir(), statPath: os.Stat, runVersion: probeCodingAgentVersion}
	detection, err = configOnly.Detect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if detection.Installed || detection.CLI != nil || len(detection.Agents) != 1 || detection.Agents[0].ID != "claude-code" || detection.Agents[0].ViaBinary {
		t.Fatalf("config-only detection=%+v, want claude-code found but not installed", detection)
	}
}

func TestCreatorAgentHandlerContract(t *testing.T) {
	logger := platformTestLogger()
	unauthenticated := newCreatorAgentHandler(platformTestResolver{}, platformTestAgentRunner{}, nil, logger)
	response := httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/creator/agent", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s, want 401", response.Code, response.Body.String())
	}

	detection := codingAgentDetection{
		Installed: true, CLI: platformTestString("opencode"), Label: platformTestString("OpenCode"),
		Agents:     []codingAgentFound{{ID: "opencode", Label: "OpenCode", ViaBinary: true, ConfigDirs: []string{}}},
		Candidates: []codingAgentCandidate{{CLI: "opencode", Label: "OpenCode", Install: "install", AuthNote: "sign in"}},
	}
	handler := newCreatorAgentHandler(platformTestResolver{user: platformTestUser()}, platformTestAgentRunner{detection: detection}, nil, logger)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/creator/agent", ""))
	body := platformTestDecode(t, response)
	if response.Code != http.StatusOK || body["installed"] != true || body["cli"] != "opencode" {
		t.Fatalf("detection status=%d body=%s, want installed opencode", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("detection Cache-Control=%q, want no-store", response.Header().Get("Cache-Control"))
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/creator/agent", ""))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
		t.Fatalf("unsupported method status=%d allow=%q, want 405 GET", response.Code, response.Header().Get("Allow"))
	}

	failing := newCreatorAgentHandler(platformTestResolver{user: platformTestUser()}, platformTestAgentRunner{err: errors.New("probe exploded")}, nil, logger)
	response = httptest.NewRecorder()
	failing.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/creator/agent", ""))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failing detector status=%d body=%s, want 500", response.Code, response.Body.String())
	}
}
