package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOnboardingOriginTrustsForwardedSchemeOnlyFromConfiguredProxy(t *testing.T) {
	trusted, err := ParseTrustedProxyCIDRs("10.42.0.0/24")
	if err != nil {
		t.Fatal(err)
	}

	newRequest := func(remoteAddr, forwardedProto string) *http.Request {
		t.Helper()
		request := httptest.NewRequest("POST", "http://business.example.test/api/onboarding", nil)
		request.RemoteAddr = remoteAddr
		request.Header.Set("Origin", "https://business.example.test")
		request.Header.Set("X-Forwarded-Proto", forwardedProto)
		return request
	}

	if !sameOriginCapabilityRequest(newRequest("10.42.0.17:443", "https"), trusted) {
		t.Fatal("configured proxy could not preserve the external HTTPS origin")
	}
	if sameOriginCapabilityRequest(newRequest("192.0.2.17:443", "https"), trusted) {
		t.Fatal("untrusted peer controlled the forwarded request scheme")
	}
	if sameOriginCapabilityRequest(newRequest("10.42.0.17:443", "https, http"), trusted) {
		t.Fatal("ambiguous forwarded scheme was accepted")
	}
}
