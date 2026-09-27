package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
)

type fakeLedgerReader struct {
	orgID  string
	limit  int
	calls  int
	events []ledger.Event
}

func (r *fakeLedgerReader) RecentForOrg(_ context.Context, orgID string, limit int) ([]ledger.Event, error) {
	r.calls++
	r.orgID = orgID
	r.limit = limit
	return r.events, nil
}

func ledgerAssertion(t *testing.T, claims authbridge.Claims) string {
	t.Helper()
	claims.IssuedAt = time.Now().Unix()
	claims.ExpiresAt = time.Now().Add(30 * time.Second).Unix()
	assertion, err := authbridge.Sign(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	return assertion
}

func TestGoLedgerHandlerUsesSignedOrganizationAndPreservesEventShape(t *testing.T) {
	reader := &fakeLedgerReader{events: []ledger.Event{{
		Seq:          42,
		Kind:         "capability.executed",
		CapabilityID: stringPointer("crm.createCustomer"),
		ActorType:    "human",
		Payload:      []byte(`{"customerId":"c-1"}`),
		Hash:         "hash-42",
		OccurredAt:   "2026-09-27T10:11:12.130Z",
	}}}
	assertion := ledgerAssertion(t, authbridge.Claims{
		Audience:       authbridge.LedgerReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-verified",
		CanReadLedger:  true,
	})
	request := httptest.NewRequest(http.MethodGet, "/__go/ledger?limit=17", nil)
	request.Header.Set(sessionAssertionHeader, assertion)
	response := httptest.NewRecorder()
	NewGoLedgerHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if reader.orgID != "org-verified" || reader.limit != 17 || reader.calls != 1 {
		t.Fatalf("reader called with org=%q limit=%d calls=%d", reader.orgID, reader.limit, reader.calls)
	}
	if got, want := response.Body.String(), `{"events":[{"seq":42,"kind":"capability.executed","capabilityId":"crm.createCustomer","actorType":"human","actorId":null,"sessionId":null,"payload":{"customerId":"c-1"},"hash":"hash-42","prevHash":null,"occurredAt":"2026-09-27T10:11:12.130Z"}]}`+"\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestGoLedgerHandlerRejectsMissingPermissionBeforeRead(t *testing.T) {
	reader := &fakeLedgerReader{}
	assertion := ledgerAssertion(t, authbridge.Claims{
		Audience:       authbridge.LedgerReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-1",
	})
	request := httptest.NewRequest(http.MethodGet, "/__go/ledger", nil)
	request.Header.Set(sessionAssertionHeader, assertion)
	response := httptest.NewRecorder()
	NewGoLedgerHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusForbidden || reader.calls != 0 {
		t.Fatalf("status=%d reader calls=%d, want forbidden and zero reads", response.Code, reader.calls)
	}
}

func TestGoLedgerHandlerRejectsWrongAudienceBeforeRead(t *testing.T) {
	reader := &fakeLedgerReader{}
	assertion := ledgerAssertion(t, authbridge.Claims{
		Audience:       authbridge.PolicyReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-1",
	})
	request := httptest.NewRequest(http.MethodGet, "/__go/ledger", nil)
	request.Header.Set(sessionAssertionHeader, assertion)
	response := httptest.NewRecorder()
	NewGoLedgerHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized || reader.calls != 0 {
		t.Fatalf("status=%d reader calls=%d, want unauthorized and zero reads", response.Code, reader.calls)
	}
}

func TestParseLedgerLimitMatchesLegacyClamping(t *testing.T) {
	for _, test := range []struct {
		name    string
		value   string
		present bool
		want    int
	}{
		{name: "default", want: 60},
		{name: "empty clamps to one", value: "", present: true, want: 1},
		{name: "whitespace clamps to one", value: "  ", present: true, want: 1},
		{name: "fraction floors", value: "12.9", present: true, want: 12},
		{name: "negative clamps", value: "-4", present: true, want: 1},
		{name: "maximum clamps", value: "999", present: true, want: 200},
		{name: "invalid defaults", value: "abc", present: true, want: 60},
		{name: "hex numeric string", value: "0x10", present: true, want: 16},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := parseLedgerLimit(test.value, test.present); got != test.want {
				t.Fatalf("parseLedgerLimit(%q, %t) = %d, want %d", test.value, test.present, got, test.want)
			}
		})
	}
}

func stringPointer(value string) *string {
	return &value
}
