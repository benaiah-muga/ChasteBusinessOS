package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const capabilityTestUserID = "11111111-1111-4111-8111-111111111111"
const capabilityTestOrgID = "22222222-2222-4222-8222-222222222222"
const capabilityTestInput = `{"name":"Acme","preferredContactMethod":"email","doNotContact":false}`

func messageUploadInputAtLimit(t *testing.T) json.RawMessage {
	t.Helper()
	content := base64.StdEncoding.EncodeToString(make([]byte, 5*1024*1024))
	input, err := json.Marshal(struct {
		ConversationID string `json:"conversationId"`
		Filename       string `json:"filename"`
		MimeType       string `json:"mimeType"`
		ContentBase64  string `json:"contentBase64"`
	}{
		ConversationID: "33333333-3333-4333-8333-333333333333",
		Filename:       "upload.bin",
		MimeType:       "application/octet-stream",
		ContentBase64:  content,
	})
	if err != nil {
		t.Fatal(err)
	}
	return input
}

type fakeCapabilityExecutor struct {
	calls  int
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
	result capability.Result
	err    error
}

func (f *fakeCapabilityExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capID string, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims = claims
	f.capID = capID
	f.input = append(json.RawMessage(nil), input...)
	return f.result, f.err
}

func signedCapabilityAssertion(t *testing.T, claims authbridge.CapabilityClaims) string {
	t.Helper()
	now := time.Now().Unix()
	claims.Audience = authbridge.CapabilityExecuteAudience
	claims.IssuedAt = now
	claims.ExpiresAt = now + 30
	token, err := authbridge.SignCapability(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func validCapabilityClaims(t *testing.T, rawInput string) authbridge.CapabilityClaims {
	t.Helper()
	hash, err := capability.InputHash(json.RawMessage(rawInput))
	if err != nil {
		t.Fatal(err)
	}
	actorID := capabilityTestUserID
	return authbridge.CapabilityClaims{
		Subject:        capabilityTestUserID,
		OrganizationID: capabilityTestOrgID,
		CapabilityID:   "crm.createCustomer",
		InputSHA256:    hash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"crm.write"},
		AuthSessionID:  "better-auth-session",
	}
}

func TestGoCapabilityHandlerForwardsOnlyVerifiedCapabilityScope(t *testing.T) {
	input := json.RawMessage(capabilityTestInput)
	executor := &fakeCapabilityExecutor{result: capability.Result{
		OK:   true,
		Data: json.RawMessage(`{"customerId":"customer-1","duplicateWarning":null}`),
	}}
	request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(`{"capabilityId":"crm.createCustomer","input":`+string(input)+`}`))
	request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, validCapabilityClaims(t, string(input))))
	response := httptest.NewRecorder()
	NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s, want successful single execution", response.Code, executor.calls, response.Body.String())
	}
	if executor.capID != "crm.createCustomer" || executor.claims.Subject != capabilityTestUserID || string(executor.input) != string(input) {
		t.Fatalf("executor received cap=%q user=%q input=%s", executor.capID, executor.claims.Subject, executor.input)
	}
	if got, want := response.Body.String(), "{\"ok\":true,\"data\":{\"customerId\":\"customer-1\",\"duplicateWarning\":null}}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
}

func TestGoCapabilityHandlerRejectsInputDigestMismatchBeforeExecution(t *testing.T) {
	executor := &fakeCapabilityExecutor{}
	claims := validCapabilityClaims(t, capabilityTestInput)
	claims.InputSHA256 = strings.Repeat("0", 64)
	request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(`{"capabilityId":"crm.createCustomer","input":`+capabilityTestInput+`}`))
	request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
	response := httptest.NewRecorder()
	NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized || executor.calls != 0 {
		t.Fatalf("status=%d calls=%d, want unauthorized before execution", response.Code, executor.calls)
	}
}

func TestGoCapabilityHandlerRejectsCapabilityMismatchAndMalformedBody(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		cap  string
		want int
	}{
		{name: "capability mismatch", body: `{"capabilityId":"crm.deactivateCustomer","input":` + capabilityTestInput + `}`, cap: "crm.createCustomer", want: http.StatusUnauthorized},
		{name: "unknown property", body: `{"capabilityId":"crm.createCustomer","input":` + capabilityTestInput + `,"unexpected":true}`, cap: "crm.createCustomer", want: http.StatusBadRequest},
		{name: "trailing data", body: `{"capabilityId":"crm.createCustomer","input":` + capabilityTestInput + `} {}`, cap: "crm.createCustomer", want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeCapabilityExecutor{}
			claims := validCapabilityClaims(t, capabilityTestInput)
			claims.CapabilityID = test.cap
			request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(test.body))
			request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
			response := httptest.NewRecorder()
			NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
			if response.Code != test.want || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%q, want status %d before execution", response.Code, executor.calls, response.Body.String(), test.want)
			}
		})
	}
}

func TestGoCapabilityHandlerUsesSignedCapabilityForUploadBodyLimit(t *testing.T) {
	t.Run("maximum upload envelope accepted", func(t *testing.T) {
		input := messageUploadInputAtLimit(t)
		hash, err := capability.InputHash(input)
		if err != nil {
			t.Fatal(err)
		}
		claims := validCapabilityClaims(t, string(input))
		claims.CapabilityID = messagingUploadCapabilityID
		claims.InputSHA256 = hash
		body := `{"capabilityId":"` + messagingUploadCapabilityID + `","input":` + string(input) + `}`
		executor := &fakeCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(body))
		request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
		response := httptest.NewRecorder()
		NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != messagingUploadCapabilityID {
			t.Fatalf("status=%d calls=%d capability=%q body=%q", response.Code, executor.calls, executor.capID, response.Body.String())
		}
	})

	t.Run("upload envelope above hard ceiling rejected", func(t *testing.T) {
		input := `{"contentBase64":"` + strings.Repeat("A", messagingUploadBodyLimit) + `"}`
		claims := validCapabilityClaims(t, input)
		claims.CapabilityID = messagingUploadCapabilityID
		hash, err := capability.InputHash(json.RawMessage(input))
		if err != nil {
			t.Fatal(err)
		}
		claims.InputSHA256 = hash
		body := `{"capabilityId":"` + messagingUploadCapabilityID + `","input":` + input + `}`
		executor := &fakeCapabilityExecutor{}
		request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(body))
		request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
		response := httptest.NewRecorder()
		NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%q, want upload beyond hard ceiling rejected", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("ordinary capability stays below 64 KiB", func(t *testing.T) {
		input := `{"blob":"` + strings.Repeat("x", capabilityBodyLimit) + `"}`
		claims := validCapabilityClaims(t, input)
		body := `{"capabilityId":"crm.createCustomer","input":` + input + `}`
		executor := &fakeCapabilityExecutor{}
		request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(body))
		request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
		response := httptest.NewRecorder()
		NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%q, want oversized ordinary capability rejected", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("body cannot spoof upload against ordinary assertion", func(t *testing.T) {
		input := messageUploadInputAtLimit(t)
		claims := validCapabilityClaims(t, string(input))
		hash, err := capability.InputHash(input)
		if err != nil {
			t.Fatal(err)
		}
		claims.InputSHA256 = hash
		body := `{"capabilityId":"` + messagingUploadCapabilityID + `","input":` + string(input) + `}`
		executor := &fakeCapabilityExecutor{}
		request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(body))
		request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
		response := httptest.NewRecorder()
		NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%q, want signed ordinary action to retain the small limit", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("upload assertion cannot execute a different oversized action", func(t *testing.T) {
		input := json.RawMessage(`{"blob":"` + strings.Repeat("x", capabilityBodyLimit) + `"}`)
		claims := validCapabilityClaims(t, string(input))
		claims.CapabilityID = messagingUploadCapabilityID
		hash, err := capability.InputHash(input)
		if err != nil {
			t.Fatal(err)
		}
		claims.InputSHA256 = hash
		body := `{"capabilityId":"crm.createCustomer","input":` + string(input) + `}`
		executor := &fakeCapabilityExecutor{}
		request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(body))
		request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, claims))
		response := httptest.NewRecorder()
		NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%q, want capability mismatch rejected", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestGoCapabilityHandlerMapsPendingApprovalToExistingResponse(t *testing.T) {
	executor := &fakeCapabilityExecutor{result: capability.Result{
		OK:                false,
		PendingApproval:   true,
		ApprovalID:        "33333333-3333-4333-8333-333333333333",
		ApprovalRationale: "amount 50001 exceeds autonomous threshold 50000",
		Error:             "pending human approval",
	}}
	request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(`{"capabilityId":"crm.createCustomer","input":`+capabilityTestInput+`}`))
	request.Header.Set(sessionAssertionHeader, signedCapabilityAssertion(t, validCapabilityClaims(t, capabilityTestInput)))
	response := httptest.NewRecorder()
	NewGoCapabilityHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
	want := "{\"ok\":false,\"pendingApproval\":true,\"reason\":\"amount 50001 exceeds autonomous threshold 50000\",\"approvalId\":\"33333333-3333-4333-8333-333333333333\"}\n"
	if response.Code != http.StatusAccepted || response.Body.String() != want {
		t.Fatalf("status=%d body=%q, want legacy pending approval response", response.Code, response.Body.String())
	}
}

func TestGoCapabilityHandlerRejectsInvalidAssertionAndUnavailableExecutor(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	NewGoCapabilityHandler(assertionSecret, nil, nil).ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable executor status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}

	request = httptest.NewRequest(http.MethodPost, "/__go/capability/execute", strings.NewReader(`{}`))
	request.Header.Set(sessionAssertionHeader, "invalid")
	response = httptest.NewRecorder()
	NewGoCapabilityHandler(assertionSecret, &fakeCapabilityExecutor{}, nil).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid assertion status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
