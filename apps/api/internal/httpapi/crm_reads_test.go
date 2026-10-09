package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const crmReadTestUserID = "11111111-1111-4111-8111-111111111111"
const crmReadTestOrgID = "22222222-2222-4222-8222-222222222222"
const crmReadTestCustomerID = "33333333-3333-4333-8333-333333333333"
const crmReadTestOtherCustomerID = "44444444-4444-4444-8444-444444444444"

type fakeCRMCapabilityExecutor struct {
	calls  int
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
	result capability.Result
	err    error
}

func (f *fakeCRMCapabilityExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capID string, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims = claims
	f.capID = capID
	f.input = append(json.RawMessage(nil), input...)
	return f.result, f.err
}

func signCRMReadAssertion(t *testing.T, capabilityID, input string, permissions []string) string {
	t.Helper()
	hash, err := capability.InputHash(json.RawMessage(input))
	if err != nil {
		t.Fatal(err)
	}
	actorID := crmReadTestUserID
	now := time.Now().Unix()
	claims := goCRMReadAssertionClaims{
		Audience:       CRMReadAudience,
		Subject:        crmReadTestUserID,
		OrganizationID: crmReadTestOrgID,
		CapabilityID:   capabilityID,
		InputSHA256:    hash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    permissions,
		AuthSessionID:  "better-auth-session",
		IssuedAt:       now,
		ExpiresAt:      now + 30,
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(assertionSecret))
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestGoCRMReadHandlerForwardsLegacyTimelineAndTaskQueryModes(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		capability string
		input      string
		response   string
	}{
		{
			name:       "timeline takes precedence",
			query:      "timeline=" + crmReadTestCustomerID + "&tasks=1&open=1",
			capability: "crm.customerTimeline",
			input:      `{"customerId":"` + crmReadTestCustomerID + `"}`,
			response:   `{"entries":[{"kind":"invoice","date":"2026-09-27T10:00:00.000Z","refId":"invoice-1","summary":"Invoice #1 (draft, 12.34)"}]}`,
		},
		{
			name:       "open task listing",
			query:      "tasks=anything&open=1",
			capability: "crm.listTasks",
			input:      `{"openOnly":true}`,
			response:   `{"tasks":[{"id":"task-1","title":"Call customer","dueAt":null,"doneAt":null,"refType":"customer","refId":"` + crmReadTestCustomerID + `","assigneeUserId":null,"assigneeName":null,"customerName":"Acme"}]}`,
		},
		{
			name:       "all task listing omits open filter",
			query:      "tasks=1&open=0",
			capability: "crm.listTasks",
			input:      `{}`,
			response:   `{"tasks":[]}`,
		},
		{
			name:       "deal listing",
			query:      "deals=1",
			capability: "crm.listDeals",
			input:      `{}`,
			response:   `{"deals":[{"id":"deal-1","title":"Deal","stage":"lead","valueMinor":12500,"note":null,"customerId":null,"customerName":null,"createdAt":"2026-09-28T10:00:00.000Z","updatedAt":"2026-09-28T10:00:00.000Z"}]}`,
		},
		{
			name:       "saved customer views",
			query:      "views=1",
			capability: "crm.listCustomerViews",
			input:      `{}`,
			response:   `{"views":[]}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeCRMCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(test.response)}}
			request := httptest.NewRequest(http.MethodGet, "/__go/crm?"+test.query, nil)
			request.Header.Set(sessionAssertionHeader, signCRMReadAssertion(t, test.capability, test.input, []string{"crm.read"}))
			response := httptest.NewRecorder()
			NewGoCRMReadHandler(assertionSecret, executor, nil).ServeHTTP(response, request)

			if response.Code != http.StatusOK || executor.calls != 1 {
				t.Fatalf("status=%d calls=%d body=%s, want one successful capability read", response.Code, executor.calls, response.Body.String())
			}
			if executor.capID != test.capability || string(executor.input) != test.input || executor.claims.OrganizationID != crmReadTestOrgID {
				t.Fatalf("executor cap=%q input=%s org=%q", executor.capID, executor.input, executor.claims.OrganizationID)
			}
			if got := response.Body.String(); got != test.response+"\n" {
				t.Fatalf("body=%q, want %q", got, test.response+"\n")
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control=%q, want no-store", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestGoCRMReadHandlerPreservesPermissionAndCrossOrganizationFailures(t *testing.T) {
	t.Run("missing permission", func(t *testing.T) {
		input := `{}`
		executor := &fakeCRMCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: crm.read"}}
		request := httptest.NewRequest(http.MethodGet, "/__go/crm?tasks=1", nil)
		request.Header.Set(sessionAssertionHeader, signCRMReadAssertion(t, "crm.listTasks", input, []string{}))
		response := httptest.NewRecorder()
		NewGoCRMReadHandler(assertionSecret, executor, nil).ServeHTTP(response, request)

		if response.Code != http.StatusUnprocessableEntity || response.Body.String() != "{\"error\":\"forbidden: missing permission: crm.read\"}\n" {
			t.Fatalf("status=%d body=%q, want the legacy 422 permission error", response.Code, response.Body.String())
		}
		if len(executor.claims.Permissions) != 0 {
			t.Fatalf("executor received permissions=%v, want the signed empty grant list", executor.claims.Permissions)
		}
	})

	t.Run("customer belongs to another organization", func(t *testing.T) {
		input := `{"customerId":"` + crmReadTestOtherCustomerID + `"}`
		executor := &fakeCRMCapabilityExecutor{err: errors.New("customer not found in this organization")}
		request := httptest.NewRequest(http.MethodGet, "/__go/crm?timeline="+crmReadTestOtherCustomerID, nil)
		request.Header.Set(sessionAssertionHeader, signCRMReadAssertion(t, "crm.customerTimeline", input, []string{"crm.read"}))
		response := httptest.NewRecorder()
		NewGoCRMReadHandler(assertionSecret, executor, nil).ServeHTTP(response, request)

		if response.Code != http.StatusUnprocessableEntity || response.Body.String() != "{\"error\":\"customer not found in this organization\"}\n" {
			t.Fatalf("status=%d body=%q, want legacy 422 tenant-scoped not-found error", response.Code, response.Body.String())
		}
	})
}

func TestGoCRMReadHandlerMapsSessionAndMembershipRechecks(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code int
		body string
	}{
		{name: "session expired", err: capability.ErrSessionInvalid, code: http.StatusUnauthorized, body: "{\"error\":\"unauthorized\"}\n"},
		{name: "scope mismatch", err: capability.ErrScopeMismatch, code: http.StatusUnauthorized, body: "{\"error\":\"unauthorized\"}\n"},
		{name: "membership revoked", err: capability.ErrNotMember, code: http.StatusForbidden, body: "{\"error\":\"forbidden\"}\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeCRMCapabilityExecutor{err: test.err}
			request := httptest.NewRequest(http.MethodGet, "/__go/crm?tasks=1", nil)
			request.Header.Set(sessionAssertionHeader, signCRMReadAssertion(t, "crm.listTasks", `{}`, []string{"crm.read"}))
			response := httptest.NewRecorder()
			NewGoCRMReadHandler(assertionSecret, executor, nil).ServeHTTP(response, request)
			if response.Code != test.code || response.Body.String() != test.body {
				t.Fatalf("status=%d body=%q, want %d %q", response.Code, response.Body.String(), test.code, test.body)
			}
		})
	}
}

func TestGoCRMReadHandlerRejectsTamperedInputAndWrongAudienceBeforeExecution(t *testing.T) {
	for _, test := range []struct {
		name      string
		query     string
		audience  string
		wantCalls int
	}{
		{name: "tampered customer", query: "timeline=" + crmReadTestOtherCustomerID, audience: CRMReadAudience},
		{name: "deals query capability mismatch", query: "deals=1", audience: CRMReadAudience},
		{name: "wrong audience", query: "timeline=" + crmReadTestCustomerID, audience: authbridge.LedgerReadAudience},
	} {
		t.Run(test.name, func(t *testing.T) {
			claimsInput := `{"customerId":"` + crmReadTestCustomerID + `"}`
			token := signCRMReadAssertion(t, "crm.customerTimeline", claimsInput, []string{"crm.read"})
			if test.audience != CRMReadAudience {
				now := time.Now().Unix()
				claims := authbridge.Claims{Audience: test.audience, Subject: crmReadTestUserID, OrganizationID: crmReadTestOrgID, IssuedAt: now, ExpiresAt: now + 30}
				var err error
				token, err = authbridge.Sign(assertionSecret, claims)
				if err != nil {
					t.Fatal(err)
				}
			}
			executor := &fakeCRMCapabilityExecutor{}
			request := httptest.NewRequest(http.MethodGet, "/__go/crm?"+test.query, nil)
			request.Header.Set(sessionAssertionHeader, token)
			response := httptest.NewRecorder()
			NewGoCRMReadHandler(assertionSecret, executor, nil).ServeHTTP(response, request)

			if response.Code != http.StatusUnauthorized || executor.calls != test.wantCalls {
				t.Fatalf("status=%d calls=%d, want unauthorized before execution", response.Code, executor.calls)
			}
		})
	}
}

func TestCRMReadRequestMatchesLegacyModePrecedence(t *testing.T) {
	for _, test := range []struct {
		query url.Values
		capID string
		input string
	}{
		{query: url.Values{"timeline": {crmReadTestCustomerID}, "tasks": {"1"}}, capID: "crm.customerTimeline", input: `{"customerId":"` + crmReadTestCustomerID + `"}`},
		{query: url.Values{"tasks": {"1"}, "open": {"1"}}, capID: "crm.listTasks", input: `{"openOnly":true}`},
		{query: url.Values{"tasks": {"1"}}, capID: "crm.listTasks", input: `{}`},
		{query: url.Values{"deals": {"1"}}, capID: "crm.listDeals", input: `{}`},
		{query: url.Values{"customers": {"1"}}, capID: "crm.listCustomerCollection", input: `{}`},
		{query: url.Values{"views": {"1"}}, capID: "crm.listCustomerViews", input: `{}`},
	} {
		capID, input, err := crmReadRequest(test.query)
		if err != nil || capID != test.capID || !reflect.DeepEqual(json.RawMessage(input), json.RawMessage(test.input)) {
			t.Fatalf("crmReadRequest(%v)=(%q,%s,%v), want (%q,%s,nil)", test.query, capID, input, err, test.capID, test.input)
		}
	}
	if _, _, err := crmReadRequest(url.Values{}); err == nil {
		t.Fatal("empty query unexpectedly selected a Go CRM capability")
	}
	for _, capabilityID := range []string{"crm.listCustomers", "crm.listCustomerCollection"} {
		token := signCRMReadAssertion(t, capabilityID, `{}`, []string{"crm.read"})
		if _, err := verifyCRMReadAssertion(assertionSecret, token, time.Now()); err != nil {
			t.Errorf("signed assertion for %s was rejected: %v", capabilityID, err)
		}
	}
}
