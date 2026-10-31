package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeBankingPaymentReader struct {
	payments []bankingRESTPayment
	err      error
	orgID    string
}

func bankingInt64(value int64) *int64 { return &value }

func (reader *fakeBankingPaymentReader) RecentBankingPayments(_ context.Context, orgID string) ([]bankingRESTPayment, error) {
	reader.orgID = orgID
	return reader.payments, reader.err
}

func newBankingRESTRequest(method, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/banking", strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return r
}

func TestBankingSessionHandlerReadsWorkspaceThroughCapability(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{
		"accounts":[{"id":"bank-1","name":"Operating","currencyCode":"UGX","last4":"1234","balanceMinor":9000}],
		"unmatched":[{"id":"txn-1","bankAccountId":"bank-1","currencyCode":"UGX","postedAt":"2026-10-01T00:00:00Z","amountMinor":500,"remainingMinor":500,"description":"Deposit"}],
		"matched":[],"excluded":[],
		"payments":[{"id":"payment-1","invoiceNumber":42,"currencyCode":"UGX","customerName":"A Customer","amountMinor":500,"remainingMinor":100,"receivedAt":"2026-10-02T00:00:00Z"}],
		"entries":[{"id":"entry-1","memo":"Cash sale","currencyCode":"UGX","postedAt":"2026-10-03T00:00:00Z","remainingMinor":300}],
		"summary":{"accounts":[],"unmatchedCount":1}
	}`)}}
	reader := &fakeBankingPaymentReader{payments: []bankingRESTPayment{{ID: "payment-1", InvoiceNumber: bankingInt64(42), CustomerName: "A Customer", AmountMinor: 500}}}
	handler := NewBankingSessionHandler(resolver, executor, reader, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newBankingRESTRequest(http.MethodGet, ""))

	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.listBankingWorkspace" {
		t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
	}
	if string(executor.input) != `{}` || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID {
		t.Fatalf("input=%s claims=%+v", executor.input, executor.claims)
	}
	if reader.orgID != *identity.OrgID {
		t.Fatalf("payment reader org=%q, want %q", reader.orgID, *identity.OrgID)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 6 {
		t.Fatalf("GET returned legacy fields plus unexpected keys: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "\"entries\"") || strings.Contains(response.Body.String(), "\"remainingMinor\"") || strings.Contains(response.Body.String(), "\"currencyCode\":\"UGX\",\"customerName\"") {
		t.Fatalf("GET did not preserve the legacy REST projection: %s", response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache policy=%q", response.Header().Get("Cache-Control"))
	}
}

func TestBankingCapabilityRequestMatchesLegacyFalsyDefaults(t *testing.T) {
	capabilityID, input, err := bankingCapabilityRequest(bankingRESTRequest{
		Action:       "addBankAccount",
		Name:         json.RawMessage(`"Operating"`),
		CurrencyCode: json.RawMessage(`42`),
		Last4:        json.RawMessage(`""`),
		BalanceMinor: json.RawMessage(`"9000"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if capabilityID != "accounting.addBankAccount" || string(input) != `{"balanceMinor":0,"name":"Operating"}` {
		t.Fatalf("capability=%q input=%s", capabilityID, input)
	}
	if _, _, err := bankingCapabilityRequest(bankingRESTRequest{Action: "addBankAccount", Name: json.RawMessage(`""`)}); err == nil || err.Error() != "name is required" {
		t.Fatalf("empty name error=%v", err)
	}
	if _, _, err := bankingCapabilityRequest(bankingRESTRequest{Action: "deleteBankTransaction", TransactionID: json.RawMessage(`0`)}); err == nil || err.Error() != "transactionId is required" {
		t.Fatalf("zero transaction id error=%v", err)
	}
}

func TestBankingSessionHandlerWritesUseGovernedCapability(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		capability string
		input      string
		intentID   string
	}{
		{"add account", `{"action":"addBankAccount","name":"Operating","currencyCode":"UGX","last4":"1234","balanceMinor":9000,"intentId":"bank-intent"}`, "accounting.addBankAccount", `{"balanceMinor":9000,"currencyCode":"UGX","last4":"1234","name":"Operating"}`, "bank-intent"},
		{"import feed", `{"action":"importBankFeed","intentId":"bank-import-1","bankAccountId":"11111111-1111-4111-8111-111111111111","rows":[{"postedAt":"2026-10-01","amountMinor":500,"description":"Deposit"}]}`, "accounting.importBankFeed", `{"bankAccountId":"11111111-1111-4111-8111-111111111111","rows":[{"postedAt":"2026-10-01","amountMinor":500,"description":"Deposit"}]}`, "bank-import-1"},
		{"match payment", `{"action":"matchBankTransaction","intentId":"bank-match-1","transactionId":"11111111-1111-4111-8111-111111111111","paymentId":"22222222-2222-4222-8222-222222222222"}`, "accounting.matchBankTransaction", `{"paymentId":"22222222-2222-4222-8222-222222222222","transactionId":"11111111-1111-4111-8111-111111111111"}`, "bank-match-1"},
		{"unmatch", `{"action":"unmatchBankTransaction","intentId":"bank-unmatch-1","transactionId":"11111111-1111-4111-8111-111111111111","futureProperty":true}`, "accounting.unmatchBankTransaction", `{"transactionId":"11111111-1111-4111-8111-111111111111"}`, "bank-unmatch-1"},
		{"exclude", `{"action":"excludeBankTransaction","intentId":"bank-exclude-1","transactionId":"11111111-1111-4111-8111-111111111111"}`, "accounting.excludeBankTransaction", `{"transactionId":"11111111-1111-4111-8111-111111111111"}`, "bank-exclude-1"},
		{"restore exclusion", `{"action":"unexcludeBankTransaction","intentId":"bank-restore-1","transactionId":"11111111-1111-4111-8111-111111111111"}`, "accounting.unexcludeBankTransaction", `{"transactionId":"11111111-1111-4111-8111-111111111111"}`, "bank-restore-1"},
		{"delete", `{"action":"deleteBankTransaction","intentId":"bank-delete-1","transactionId":"11111111-1111-4111-8111-111111111111"}`, "accounting.deleteBankTransaction", `{"transactionId":"11111111-1111-4111-8111-111111111111"}`, "bank-delete-1"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			identity := directTestIdentity()
			resolver := &fakeDirectSessionResolver{resolved: identity}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"saved":true}`)}}
			response := httptest.NewRecorder()
			NewBankingSessionHandler(resolver, executor, nil, nil).ServeHTTP(response, newBankingRESTRequest(http.MethodPost, test.body))
			if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != test.capability {
				t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
			}
			var got, want map[string]any
			if json.Unmarshal(executor.input, &got) != nil || json.Unmarshal([]byte(test.input), &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("input=%s want=%s", executor.input, test.input)
			}
			if executor.claims.ActorType != "human" || executor.claims.ActorID == nil || *executor.claims.ActorID != identity.UserID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.IntentID != test.intentID {
				t.Fatalf("claims=%+v", executor.claims)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("cache policy=%q", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestBankingSessionHandlerMapsApprovalAndRefusal(t *testing.T) {
	for _, test := range []struct {
		name   string
		result capability.Result
		status int
		body   string
	}{
		{"approval", capability.Result{PendingApproval: true, ApprovalRationale: "Manager approval required"}, http.StatusAccepted, `{"ok":false,"pendingApproval":true,"reason":"Manager approval required"}`},
		{"refusal", capability.Result{OK: false, Error: "banking action refused"}, http.StatusUnprocessableEntity, `{"error":"banking action refused","ok":false}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: test.result}
			response := httptest.NewRecorder()
			NewBankingSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil, nil).ServeHTTP(response, newBankingRESTRequest(http.MethodPost, `{"action":"excludeBankTransaction","intentId":"bank-result-1","transactionId":"11111111-1111-4111-8111-111111111111"}`))
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var got, want any
			if json.Unmarshal(response.Body.Bytes(), &got) != nil || json.Unmarshal([]byte(test.body), &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("body=%s want=%s", response.Body.String(), test.body)
			}
		})
	}
}

func TestBankingSessionHandlerRejectsUnauthorizedCrossOriginAndMalformedWrites(t *testing.T) {
	tests := []struct {
		name     string
		identity *session.ResolvedUser
		request  func() *http.Request
		status   int
	}{
		{"anonymous", nil, func() *http.Request {
			return newBankingRESTRequest(http.MethodPost, `{"action":"deleteBankTransaction","transactionId":"x"}`)
		}, http.StatusUnauthorized},
		{"wrong organization selector", directTestIdentity(), func() *http.Request {
			r := newBankingRESTRequest(http.MethodGet, "")
			r.Header.Set("X-Organization-ID", "22222222-2222-4222-8222-222222222222")
			return r
		}, http.StatusForbidden},
		{"cross origin", directTestIdentity(), func() *http.Request {
			r := newBankingRESTRequest(http.MethodPost, `{"action":"deleteBankTransaction","transactionId":"x"}`)
			r.Header.Set("Origin", "https://evil.example")
			return r
		}, http.StatusForbidden},
		{"invalid body", directTestIdentity(), func() *http.Request { return newBankingRESTRequest(http.MethodPost, "{") }, http.StatusBadRequest},
		{"unknown action", directTestIdentity(), func() *http.Request { return newBankingRESTRequest(http.MethodPost, `{"action":"wipeAll"}`) }, http.StatusBadRequest},
		{"missing intent id", directTestIdentity(), func() *http.Request {
			return newBankingRESTRequest(http.MethodPost, `{"action":"deleteBankTransaction","transactionId":"11111111-1111-4111-8111-111111111111"}`)
		}, http.StatusBadRequest},
		{"missing transaction", directTestIdentity(), func() *http.Request {
			return newBankingRESTRequest(http.MethodPost, `{"action":"deleteBankTransaction","intentId":"bank-missing-transaction"}`)
		}, http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.identity}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
			request := test.request()
			response := httptest.NewRecorder()
			NewBankingSessionHandler(resolver, executor, nil, nil).ServeHTTP(response, request)
			if response.Code != test.status || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestBankingSessionHandlerMapsExecutorErrorsAndRejectsWrongMethods(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{err: errors.New("database unavailable")}
	response := httptest.NewRecorder()
	NewBankingSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, &fakeBankingPaymentReader{}, nil).ServeHTTP(response, newBankingRESTRequest(http.MethodGet, ""))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("executor error status=%d body=%s", response.Code, response.Body.String())
	}
	wrongMethod := newBankingRESTRequest(http.MethodDelete, "")
	response = httptest.NewRecorder()
	NewBankingSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, &fakeBankingPaymentReader{}, nil).ServeHTTP(response, wrongMethod)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("method status=%d allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
	}
}

func TestMountGoBankingRouteOwnsExactPath(t *testing.T) {
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	legacy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	router := MountGoBankingRoute(legacy, goRoute)

	exact := httptest.NewRecorder()
	router.ServeHTTP(exact, httptest.NewRequest(http.MethodGet, "/api/banking", nil))
	if exact.Code != http.StatusNoContent {
		t.Fatalf("exact path status=%d, want Go handler", exact.Code)
	}

	other := httptest.NewRecorder()
	router.ServeHTTP(other, httptest.NewRequest(http.MethodGet, "/api/banking/extra", nil))
	if other.Code != http.StatusTeapot {
		t.Fatalf("nested path status=%d, want fallback", other.Code)
	}
}
