package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const approvalDecisionSubject = "3cb98ed4-f31e-4d94-9c8e-e47ce8a216d7"
const approvalDecisionOrg = "eef7d82f-8c44-454d-86e2-ed8195852fa9"
const approvalDecisionID = "8d74001f-8c3f-4951-8bf3-86eb941f1e31"

type fakeApprovalDecisionDecider struct {
	claims authbridge.CapabilityClaims
	input  capability.ApprovalDecisionInput
	result capability.ApprovalDecisionResult
	err    error
	calls  int
}

func (d *fakeApprovalDecisionDecider) Decide(_ context.Context, claims authbridge.CapabilityClaims, input capability.ApprovalDecisionInput) (capability.ApprovalDecisionResult, error) {
	d.calls++
	d.claims = claims
	d.input = input
	return d.result, d.err
}

func validApprovalDecisionClaims() authbridge.ApprovalDecisionClaims {
	actorID := approvalDecisionSubject
	comment := "Checked the linked evidence."
	now := time.Now()
	return authbridge.ApprovalDecisionClaims{
		Audience:       authbridge.ApprovalDecisionAudience,
		Subject:        approvalDecisionSubject,
		OrganizationID: approvalDecisionOrg,
		CapabilityID:   "accounting.recordPayment",
		InputSHA256:    strings.Repeat("b", 64),
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"accounting.post", "accounting.read"},
		AuthSessionID:  "better-auth-session",
		ApprovalID:     approvalDecisionID,
		Decision:       "approve",
		Comment:        &comment,
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(25 * time.Second).Unix(),
	}
}

func approvalDecisionToken(t *testing.T, claims authbridge.ApprovalDecisionClaims) string {
	t.Helper()
	token, err := authbridge.SignApprovalDecision(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func marshalApprovalDecisionBody(t *testing.T, claims authbridge.ApprovalDecisionClaims) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"approvalId":   claims.ApprovalID,
		"capabilityId": claims.CapabilityID,
		"inputSha256":  claims.InputSHA256,
		"decision":     claims.Decision,
		"comment":      claims.Comment,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func approvalDecisionRequest(t *testing.T, claims authbridge.ApprovalDecisionClaims, body string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/__go/approval/decide", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(sessionAssertionHeader, approvalDecisionToken(t, claims))
	return request
}

func TestGoApprovalDecisionHandlerPassesOnlyBoundSignedDecision(t *testing.T) {
	claims := validApprovalDecisionClaims()
	decider := &fakeApprovalDecisionDecider{result: capability.ApprovalDecisionResult{
		OK:         false,
		Status:     "already_decided",
		Error:      "approval has already been decided",
		HTTPStatus: http.StatusConflict,
	}}
	response := httptest.NewRecorder()
	NewGoApprovalDecisionHandler(assertionSecret, decider, nil).ServeHTTP(response, approvalDecisionRequest(t, claims, marshalApprovalDecisionBody(t, claims)))

	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusConflict, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"status":"already_decided"`) || !strings.Contains(response.Body.String(), `"error":"approval has already been decided"`) {
		t.Fatalf("decision result body was not propagated: %s", response.Body.String())
	}
	if decider.calls != 1 || decider.claims.Audience != authbridge.CapabilityExecuteAudience || decider.claims.CapabilityID != claims.CapabilityID ||
		decider.claims.InputSHA256 != claims.InputSHA256 || decider.claims.Subject != claims.Subject || decider.claims.OrganizationID != claims.OrganizationID ||
		decider.claims.AuthSessionID != claims.AuthSessionID || decider.claims.ActorType != "human" || decider.claims.ActorID == nil || *decider.claims.ActorID != claims.Subject {
		t.Fatalf("decider received unexpected capability claims: calls=%d claims=%+v", decider.calls, decider.claims)
	}
	if decider.input.ApprovalID != claims.ApprovalID || decider.input.Decision != claims.Decision || decider.input.Comment == nil || *decider.input.Comment != *claims.Comment {
		t.Fatalf("decider received unexpected decision input: %+v", decider.input)
	}
}

func TestGoApprovalDecisionHandlerRejectsBadAssertionAndChangedBody(t *testing.T) {
	claims := validApprovalDecisionClaims()
	body := marshalApprovalDecisionBody(t, claims)
	for name, mutate := range map[string]func(*authbridge.ApprovalDecisionClaims, *string){
		"wrong audience": func(c *authbridge.ApprovalDecisionClaims, _ *string) {
			c.Audience = authbridge.CapabilityExecuteAudience
		},
		"bad signature": func(_ *authbridge.ApprovalDecisionClaims, token *string) { *token += "x" },
	} {
		t.Run(name, func(t *testing.T) {
			decider := &fakeApprovalDecisionDecider{}
			request := httptest.NewRequest(http.MethodPost, "/__go/approval/decide", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			token := approvalDecisionToken(t, claims)
			changedClaims := claims
			mutate(&changedClaims, &token)
			if name == "wrong audience" {
				token = approvalDecisionToken(t, changedClaims)
			}
			request.Header.Set(sessionAssertionHeader, token)
			response := httptest.NewRecorder()
			NewGoApprovalDecisionHandler(assertionSecret, decider, nil).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || decider.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want unauthorized without decider call", response.Code, decider.calls, response.Body.String())
			}
		})
	}

	for name, changedBody := range map[string]string{
		"approval id":    strings.Replace(body, claims.ApprovalID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1),
		"capability id":  strings.Replace(body, claims.CapabilityID, "accounting.other", 1),
		"payload digest": strings.Replace(body, claims.InputSHA256, strings.Repeat("c", 64), 1),
		"decision":       strings.Replace(body, `"decision":"approve"`, `"decision":"reject"`, 1),
		"comment":        strings.Replace(body, *claims.Comment, "altered comment", 1),
	} {
		t.Run(name, func(t *testing.T) {
			decider := &fakeApprovalDecisionDecider{}
			response := httptest.NewRecorder()
			NewGoApprovalDecisionHandler(assertionSecret, decider, nil).ServeHTTP(response, approvalDecisionRequest(t, claims, changedBody))
			if response.Code != http.StatusUnauthorized || decider.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want unauthorized without decider call", response.Code, decider.calls, response.Body.String())
			}
		})
	}
}

func TestGoApprovalDecisionHandlerReturnsUnavailableWithoutDependency(t *testing.T) {
	claims := validApprovalDecisionClaims()
	response := httptest.NewRecorder()
	NewGoApprovalDecisionHandler(assertionSecret, nil, nil).ServeHTTP(response, approvalDecisionRequest(t, claims, marshalApprovalDecisionBody(t, claims)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
}

func TestRouterMountsPrivateApprovalDecisionRoute(t *testing.T) {
	response := httptest.NewRecorder()
	NewRouter(nil, nil, assertionSecret, nil, nil, nil, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/__go/approval/decide", strings.NewReader(`{}`)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want mounted route's unavailable response %d: %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
}

func TestGoApprovalDecisionHandlerHidesDeciderErrors(t *testing.T) {
	claims := validApprovalDecisionClaims()
	decider := &fakeApprovalDecisionDecider{err: errors.New("sensitive database detail")}
	response := httptest.NewRecorder()
	NewGoApprovalDecisionHandler(assertionSecret, decider, nil).ServeHTTP(response, approvalDecisionRequest(t, claims, marshalApprovalDecisionBody(t, claims)))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "sensitive database detail") {
		t.Fatalf("status=%d body=%s, want generic internal error", response.Code, response.Body.String())
	}
}
