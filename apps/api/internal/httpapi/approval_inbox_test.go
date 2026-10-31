package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

type fakeApprovalInboxReader struct {
	calls        int
	claims       authbridge.ApprovalInboxClaims
	capabilities map[string]string
	response     ApprovalInboxResponse
}

func (reader *fakeApprovalInboxReader) ReadApprovalInbox(_ context.Context, claims authbridge.ApprovalInboxClaims, capabilities map[string]string) (ApprovalInboxResponse, error) {
	reader.calls++
	reader.claims = claims
	reader.capabilities = capabilities
	return reader.response, nil
}

func signApprovalInboxClaims(t *testing.T, body []byte, mutate func(*authbridge.ApprovalInboxClaims)) string {
	t.Helper()
	actorID := "64f0d8af-4b2b-48dc-92d1-1c736ca5ef59"
	digest := sha256.Sum256(body)
	claims := authbridge.ApprovalInboxClaims{
		Audience:       authbridge.ApprovalInboxReadAudience,
		Subject:        actorID,
		OrganizationID: "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5",
		InputSHA256:    hex.EncodeToString(digest[:]),
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"accounting.post"},
		AuthSessionID:  "session-verified",
		IssuedAt:       time.Now().Unix(),
		ExpiresAt:      time.Now().Add(30 * time.Second).Unix(),
	}
	if mutate != nil {
		mutate(&claims)
	}
	encodedJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(encodedJSON)
	mac := hmac.New(sha256.New, []byte(assertionSecret))
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestGoApprovalInboxHandlerBindsIdentityOrganizationAndRegistry(t *testing.T) {
	body := []byte(`{"capabilityPermissions":{"accounting.recordPayment":"accounting.post","iam.createRole":"iam.admin"}}`)
	reader := &fakeApprovalInboxReader{response: ApprovalInboxResponse{Approvals: []ApprovalInboxRow{}, History: []ApprovalInboxRow{}}}
	request := httptest.NewRequest(http.MethodPost, "/__go/approvals/inbox", bytesReader(body))
	request.Header.Set(sessionAssertionHeader, signApprovalInboxClaims(t, body, func(claims *authbridge.ApprovalInboxClaims) {
		claims.OrganizationID = "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5"
	}))
	response := httptest.NewRecorder()
	NewGoApprovalInboxHandler(assertionSecret, reader, nil).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if reader.calls != 1 || reader.claims.OrganizationID != "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5" || reader.claims.Subject != "64f0d8af-4b2b-48dc-92d1-1c736ca5ef59" || reader.capabilities["iam.createRole"] != "iam.admin" {
		t.Fatalf("reader received calls=%d claims=%+v capability map=%v", reader.calls, reader.claims, reader.capabilities)
	}
	if got, want := response.Body.String(), "{\"approvals\":[],\"history\":[]}\n"; got != want {
		t.Fatalf("body=%q want=%q", got, want)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("approval inbox response was cacheable")
	}
}

func TestGoApprovalInboxHandlerRejectsBadAuthAndBodyBinding(t *testing.T) {
	body := []byte(`{"capabilityPermissions":{"accounting.recordPayment":"accounting.post"}}`)
	for _, test := range []struct {
		name        string
		token       string
		requestBody []byte
		want        int
	}{
		{name: "missing assertion", requestBody: body, want: http.StatusUnauthorized},
		{name: "tampered body", token: signApprovalInboxClaims(t, body, nil), requestBody: []byte(`{"capabilityPermissions":{}}`), want: http.StatusUnauthorized},
		{name: "wrong actor type", token: signApprovalInboxClaims(t, body, func(claims *authbridge.ApprovalInboxClaims) { claims.ActorType = "agent" }), requestBody: body, want: http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &fakeApprovalInboxReader{}
			request := httptest.NewRequest(http.MethodPost, "/__go/approvals/inbox", bytesReader(test.requestBody))
			if test.token != "" {
				request.Header.Set(sessionAssertionHeader, test.token)
			}
			response := httptest.NewRecorder()
			NewGoApprovalInboxHandler(assertionSecret, reader, nil).ServeHTTP(response, request)
			if response.Code != test.want || reader.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, reader.calls, response.Body.String())
			}
		})
	}
}

func TestApprovalDocumentIDsPreservePayloadOrderAndDeduplicate(t *testing.T) {
	payload := json.RawMessage(`{"sourceDocumentId":"64f0d8af-4b2b-48dc-92d1-1c736ca5ef59","nested":{"documentId":"d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5"},"again":{"documentId":"64f0d8af-4b2b-48dc-92d1-1c736ca5ef59"}}`)
	got := approvalDocumentIDs(payload)
	if len(got) != 2 || got[0] != "64f0d8af-4b2b-48dc-92d1-1c736ca5ef59" || got[1] != "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5" {
		t.Fatalf("document ids=%v, want stable traversal order and deduplication", got)
	}
}

func bytesReader(value []byte) *bytes.Reader { return bytes.NewReader(value) }
