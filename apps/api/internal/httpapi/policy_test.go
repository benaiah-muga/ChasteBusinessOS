package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
)

const assertionSecret = "0123456789abcdef0123456789abcdef"

type fakePolicyReader struct {
	orgID string
	value policy.Value
}

func (r *fakePolicyReader) ForOrg(_ context.Context, orgID string) (policy.Value, error) {
	r.orgID = orgID
	return r.value, nil
}

func TestGoPolicyHandlerUsesVerifiedOrgAndReturnsPolicy(t *testing.T) {
	reader := &fakePolicyReader{value: policy.Value{
		MaxRiskAutonomous:   "write",
		MoneyThresholdMinor: 50_000,
		RequiresApprovalFor: json.RawMessage("[]"),
	}}
	claims := authbridge.Claims{
		Audience:       authbridge.PolicyReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-1",
		CanEdit:        true,
		IssuedAt:       time.Now().Unix(),
		ExpiresAt:      time.Now().Add(30 * time.Second).Unix(),
	}
	assertion, err := authbridge.Sign(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/__go/policy", nil)
	request.Header.Set(sessionAssertionHeader, assertion)
	response := httptest.NewRecorder()
	NewGoPolicyHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if reader.orgID != claims.OrganizationID {
		t.Fatalf("reader org id = %q, want signed org id %q", reader.orgID, claims.OrganizationID)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got, want := response.Body.String(), "{\"policy\":{\"maxRiskAutonomous\":\"write\",\"moneyThresholdMinor\":50000,\"requiresApprovalFor\":[]},\"canEdit\":true}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestGoPolicyHandlerPreservesMixedApprovalArrayValues(t *testing.T) {
	reader := &fakePolicyReader{value: policy.Value{
		MaxRiskAutonomous:   "write",
		MoneyThresholdMinor: 50_000,
		RequiresApprovalFor: json.RawMessage(`["identity",7]`),
	}}
	claims := authbridge.Claims{
		Audience:       authbridge.PolicyReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-1",
		IssuedAt:       time.Now().Unix(),
		ExpiresAt:      time.Now().Add(30 * time.Second).Unix(),
	}
	assertion, err := authbridge.Sign(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/__go/policy", nil)
	request.Header.Set(sessionAssertionHeader, assertion)
	response := httptest.NewRecorder()
	NewGoPolicyHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if got := response.Body.String(); got != "{\"policy\":{\"maxRiskAutonomous\":\"write\",\"moneyThresholdMinor\":50000,\"requiresApprovalFor\":[\"identity\",7]},\"canEdit\":false}\n" {
		t.Fatalf("body = %q, want mixed array passed through", got)
	}
}

func TestGoPolicyHandlerRejectsInvalidAssertion(t *testing.T) {
	response := httptest.NewRecorder()
	NewGoPolicyHandler(assertionSecret, &fakePolicyReader{}, nil).ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/__go/policy", nil),
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestGoPolicyHandlerRequiresBridgeConfiguration(t *testing.T) {
	response := httptest.NewRecorder()
	NewGoPolicyHandler("", &fakePolicyReader{}, nil).ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/__go/policy", nil),
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}
