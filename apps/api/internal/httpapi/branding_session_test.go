package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type fakeBrandingReader struct {
	row   *BrandingRead
	orgID string
	err   error
	calls int
}

func (f *fakeBrandingReader) ReadBranding(_ context.Context, orgID string) (*BrandingRead, error) {
	f.calls++
	f.orgID = orgID
	return f.row, f.err
}

func brandingRequest(method, body string) *http.Request {
	r := directCapabilityRequest(method, body)
	r.URL.Path = "/api/branding"
	return r
}

func TestBrandingSessionHandlerReadReturnsContractAndPermission(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	logo := "data:image/png;base64,aGVsbG8="
	accent := "#aabbcc"
	footer := "Thank you"
	reader := &fakeBrandingReader{row: &BrandingRead{LogoDataURL: &logo, AccentColor: &accent, InvoiceFooter: &footer, Layout: "modern"}}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	handler := NewBrandingSessionHandler(resolver, &fakeDirectCapabilityExecutor{}, reader, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, brandingRequest(http.MethodGet, ""))

	if response.Code != http.StatusOK || reader.calls != 1 || reader.orgID != *identity.OrgID {
		t.Fatalf("status=%d calls=%d org=%q body=%s", response.Code, reader.calls, reader.orgID, response.Body.String())
	}
	var body struct {
		Branding *BrandingRead `json:"branding"`
		CanEdit  bool          `json:"canEdit"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Branding == nil || body.Branding.Layout != "modern" || !body.CanEdit {
		t.Fatalf("unexpected contract: %+v", body)
	}
}

func TestBrandingSessionHandlerWriteUsesGovernedCapability(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"saved":true}`)}}
	handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, brandingRequest(http.MethodPost, `{"accentColor":"#AABBCC","layout":"modern","intentId":"change print branding","ignoredLegacyKey":true}`))

	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
	if executor.capID != "iam.setOrgBranding" || executor.claims.Subject != directTestIdentity().UserID || executor.claims.OrganizationID != *directTestIdentity().OrgID || executor.claims.IntentID != "change print branding" {
		t.Fatalf("unexpected claims/capability: id=%q claims=%+v", executor.capID, executor.claims)
	}
	if !strings.Contains(string(executor.input), `"accentColor":"#AABBCC"`) || !strings.Contains(string(executor.input), `"layout":"modern"`) {
		t.Fatalf("unexpected capability input: %s", executor.input)
	}
	if strings.Contains(string(executor.input), "ignoredLegacyKey") {
		t.Fatalf("unknown key should be stripped before capability execution: %s", executor.input)
	}
}

func TestBrandingSessionHandlerPreservesLegacyPermissionFailureStatus(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{Error: "forbidden: missing permission: iam.admin"}}
	handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, brandingRequest(http.MethodPost, `{"layout":"modern"}`))
	if response.Code != http.StatusUnprocessableEntity || response.Body.String() != "{\"error\":\"forbidden: missing permission: iam.admin\"}\n" {
		t.Fatalf("status=%d body=%s, want legacy 422 capability error", response.Code, response.Body.String())
	}
}

func TestBrandingSessionHandlerRejectsCrossOriginCookieWrite(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
	r := brandingRequest(http.MethodPost, `{"layout":"classic"}`)
	r.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("status=%d capability calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}

func TestBrandingSessionHandlerRejectsMismatchedOrganizationAndMalformedBody(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	reader := &fakeBrandingReader{}
	handler := NewBrandingSessionHandler(resolver, executor, reader, nil)
	r := brandingRequest(http.MethodGet, "")
	r.Header.Set("X-Organization-ID", "44444444-4444-4444-8444-444444444444")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusUnauthorized || reader.calls != 0 {
		t.Fatalf("mismatch status=%d reader calls=%d", response.Code, reader.calls)
	}

	for _, body := range []string{
		`null`,
		`[]`,
		`{"accentColor":"red"}`,
		`{"layout":"wide"}`,
		`{"invoiceFooter":null}`,
		`{"intentId":null}`,
		`{"intentId":"bad\nintent"}`,
		`{"intentId":"` + strings.Repeat("x", 201) + `"}`,
		`{"layout":"modern"} {}`,
	} {
		r := brandingRequest(http.MethodPost, body)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("body=%s status=%d calls=%d", body, response.Code, executor.calls)
		}
	}
}

func TestBrandingSessionHandlerIgnoresCaseVariantFieldsLikeLegacy(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "case alias alone is stripped",
			body: `{"InvoiceFooter":"alias"}`,
			want: `{}`,
		},
		{
			name: "canonical spelling wins over case alias",
			body: `{"invoiceFooter":"canonical","InvoiceFooter":"alias"}`,
			want: `{"invoiceFooter":"canonical"}`,
		},
		{
			name: "canonical spelling wins when case alias comes first",
			body: `{"InvoiceFooter":"alias","invoiceFooter":"canonical"}`,
			want: `{"invoiceFooter":"canonical"}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
			handler := NewBrandingSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, &fakeBrandingReader{}, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, brandingRequest(http.MethodPost, test.body))
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if executor.calls != 1 || string(executor.input) != test.want {
				t.Fatalf("calls=%d input=%s, want one call with %s", executor.calls, executor.input, test.want)
			}
		})
	}
}

func TestBrandingSessionHandlerIntentLimitMatchesJavaScriptCodeUnits(t *testing.T) {
	for _, test := range []struct {
		name       string
		intentID   string
		wantStatus int
	}{
		{name: "200 UTF-16 units", intentID: strings.Repeat("😀", 100), wantStatus: http.StatusOK},
		{name: "202 UTF-16 units", intentID: strings.Repeat("😀", 101), wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
			handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
			body, err := json.Marshal(map[string]string{"intentId": test.intentID})
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, brandingRequest(http.MethodPost, string(body)))
			if response.Code != test.wantStatus {
				t.Fatalf("status=%d calls=%d body=%s, want %d", response.Code, executor.calls, response.Body.String(), test.wantStatus)
			}
		})
	}
}

func TestBrandingSessionHandlerSupportsBearerAndPendingApproval(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalRationale: "approval required"}}
	handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/branding", strings.NewReader(`{"invoiceFooter":"Thanks"}`))
	r.Header.Set("Authorization", "Bearer access-token")
	r.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusAccepted || resolver.bearerCalls != 1 || executor.calls != 1 || !strings.Contains(response.Body.String(), `"pendingApproval":true`) {
		t.Fatalf("status=%d bearer calls=%d executor calls=%d body=%s", response.Code, resolver.bearerCalls, executor.calls, response.Body.String())
	}
	if response.Body.String() != "{\"pendingApproval\":true,\"hint\":\"Branding changes proposed by the workmate wait for approval in the Approvals inbox.\"}\n" {
		t.Fatalf("pending envelope=%s, want legacy hint without private approval rationale", response.Body.String())
	}
	if resolver.activeOrg != *identity.OrgID || resolver.bearer != "access-token" {
		t.Fatalf("bearer resolution token=%q active org=%q", resolver.bearer, resolver.activeOrg)
	}
}

func TestBrandingSessionHandlerAcceptsLegacyUTF16FooterLimit(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
	footer := strings.Repeat("😀", 150)
	r := brandingRequest(http.MethodPost, `{"invoiceFooter":"`+footer+`"}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s, want 300 UTF-16 code-unit footer accepted", response.Code, executor.calls, response.Body.String())
	}
}

func TestBrandingSessionHandlerAcceptsSupportedLogoPayloadSize(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := NewBrandingSessionHandler(resolver, executor, &fakeBrandingReader{}, nil)
	logo := "data:image/png;base64," + strings.Repeat("A", 200_000)
	encoded, err := json.Marshal(map[string]string{"logoDataUrl": logo})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, brandingRequest(http.MethodPost, string(encoded)))
	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d capability calls=%d", response.Code, executor.calls)
	}
}
