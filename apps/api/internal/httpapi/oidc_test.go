package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestValidateOIDCConfigRequiresExactBackendCallbackAndHTTPS(t *testing.T) {
	base := OIDCConfig{Issuer: "https://id.example.test/tenant", ClientID: "client", ClientSecret: "secret", RedirectURI: "https://api.example.test/api/auth/callback/oidc"}
	if _, err := validateOIDCConfig(base, true); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	for name, mutate := range map[string]func(*OIDCConfig){
		"http issuer":                       func(c *OIDCConfig) { c.Issuer = "http://id.example.test" },
		"client redirect":                   func(c *OIDCConfig) { c.RedirectURI = "https://app.example.test/callback" },
		"redirect query":                    func(c *OIDCConfig) { c.RedirectURI += "?next=https://evil.test" },
		"http callback":                     func(c *OIDCConfig) { c.RedirectURI = "http://api.example.test/api/auth/callback/oidc" },
		"wildcard endpoint host":            func(c *OIDCConfig) { c.AllowedEndpointHosts = "*.provider.example" },
		"endpoint URL instead of authority": func(c *OIDCConfig) { c.AllowedEndpointHosts = "https://provider.example" },
		"web redirect for native callback":  func(c *OIDCConfig) { c.NativeRedirectURI = "https://app.example.test/oidc" },
		"native callback query":             func(c *OIDCConfig) { c.NativeRedirectURI = "com.example.app://auth/callback?next=https://evil.test" },
		"javascript callback":               func(c *OIDCConfig) { c.NativeRedirectURI = "javascript://auth/callback" },
	} {
		t.Run(name, func(t *testing.T) {
			config := base
			mutate(&config)
			if _, err := validateOIDCConfig(config, true); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
}

func TestNativeOIDCRedirectCarriesOnlyOneTimeCodeAndState(t *testing.T) {
	redirect, err := nativeOIDCRedirect("com.example.chaste://auth/callback", "one-time-code", "client-state-012345", "")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(redirect)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "com.example.chaste" || parsed.Host != "auth" || parsed.Path != "/callback" || parsed.Query().Get("code") != "one-time-code" || parsed.Query().Get("state") != "client-state-012345" || parsed.Query().Has("access_token") {
		t.Fatalf("native callback contains unexpected data: %q", redirect)
	}
	if _, err := nativeOIDCRedirect("https://app.example.test/callback", "one-time-code", "client-state-012345", ""); err == nil {
		t.Fatal("web URL accepted as native callback")
	}
}

func TestNativeOIDCExchangeRejectsMalformedBodyWithoutReturningCredentials(t *testing.T) {
	handler := &oidcSignInHandler{config: OIDCConfig{NativeRedirectURI: "com.example.chaste://auth/callback"}}
	mux := http.NewServeMux()
	handler.Register(mux)
	request := httptest.NewRequest(http.MethodPost, "/native/exchange", strings.NewReader(`{"code":`))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "access_token") {
		t.Fatalf("response must be non-cacheable and must not expose a token: headers=%v body=%s", response.Header(), response.Body.String())
	}
}

func TestNativeOIDCExchangeReturnsLiveBearerOnce(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := authn.NewService(pool, "oidc-http-test-secret-0123456789012345", authn.Options{BaseURL: "https://api.example.test/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	stamp := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "oidc-http-handoff-" + stamp + "@fixture.test"
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM auth_user WHERE email = $1`, email) })
	identity, err := service.SignInOIDC(ctx, "https://issuer.fixture.test", "native-http-"+stamp, email, "Native HTTP Fixture", true, true)
	if err != nil {
		t.Fatal(err)
	}
	verifier := "native-http-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	code, err := service.CreateOIDCNativeHandoff(ctx, challenge, identity.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]string{"code": code, "code_verifier": verifier})
	if err != nil {
		t.Fatal(err)
	}
	handler := &oidcSignInHandler{service: service, config: OIDCConfig{NativeRedirectURI: "com.example.chaste://auth/callback"}}
	mux := http.NewServeMux()
	handler.Register(mux)
	request := httptest.NewRequest(http.MethodPost, "/native/exchange", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	var result struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || result.AccessToken != identity.Session.Token || result.TokenType != "Bearer" || response.Header().Get("Cache-Control") != "no-store" || len(response.Result().Cookies()) != 0 {
		t.Fatalf("exchange status=%d body=%s headers=%v", response.Code, response.Body.String(), response.Header())
	}

	replay := httptest.NewRecorder()
	mux.ServeHTTP(replay, httptest.NewRequest(http.MethodPost, "/native/exchange", strings.NewReader(string(body))))
	if replay.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("request without JSON content type status=%d", replay.Code)
	}
	replayRequest := httptest.NewRequest(http.MethodPost, "/native/exchange", strings.NewReader(string(body)))
	replayRequest.Header.Set("Content-Type", "application/json")
	replay = httptest.NewRecorder()
	mux.ServeHTTP(replay, replayRequest)
	if replay.Code != http.StatusUnauthorized || strings.Contains(replay.Body.String(), identity.Session.Token) {
		t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body.String())
	}
}

func TestValidateOIDCConfigAllowsLoopbackDevelopmentCallback(t *testing.T) {
	config := OIDCConfig{Issuer: "https://id.example.test", ClientID: "client", ClientSecret: "secret", RedirectURI: "http://localhost:8080/api/auth/callback/oidc"}
	if _, err := validateOIDCConfig(config, false); err != nil {
		t.Fatalf("loopback dev callback rejected: %v", err)
	}
	if _, err := validateOIDCConfig(config, true); err == nil {
		t.Fatal("loopback callback accepted with secure-cookie policy")
	}
}

func TestOIDCDiscoveryRejectsUntrustedTokenAndJWKSAuthorities(t *testing.T) {
	config := OIDCConfig{Issuer: "https://id.example.test", ClientID: "client", ClientSecret: "secret", RedirectURI: "https://api.example.test/api/auth/callback/oidc"}
	trusted, err := validateOIDCConfig(config, true)
	if err != nil {
		t.Fatal(err)
	}
	for name, document := range map[string]string{
		"private token endpoint":     `{"issuer":"https://id.example.test","authorization_endpoint":"https://id.example.test/auth","token_endpoint":"https://127.0.0.1:8443/token","jwks_uri":"https://id.example.test/keys"}`,
		"unapproved JWKS endpoint":   `{"issuer":"https://id.example.test","authorization_endpoint":"https://id.example.test/auth","token_endpoint":"https://id.example.test/token","jwks_uri":"https://keys.attacker.test/keys"}`,
		"insecure userinfo endpoint": `{"issuer":"https://id.example.test","authorization_endpoint":"https://id.example.test/auth","token_endpoint":"https://id.example.test/token","jwks_uri":"https://id.example.test/keys","userinfo_endpoint":"http://id.example.test/userinfo"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeOIDCProviderConfig([]byte(document), config.Issuer, trusted); err == nil {
				t.Fatal("untrusted discovery endpoint was accepted")
			}
		})
	}
}

func TestOIDCDiscoveryAllowsExplicitSplitHostAuthorities(t *testing.T) {
	config := OIDCConfig{
		Issuer: "https://id.example.test", ClientID: "client", ClientSecret: "secret",
		RedirectURI:          "https://api.example.test/api/auth/callback/oidc",
		AllowedEndpointHosts: "login.example.test:443,keys.example.test",
	}
	trusted, err := validateOIDCConfig(config, true)
	if err != nil {
		t.Fatal(err)
	}
	document := `{"issuer":"https://id.example.test","authorization_endpoint":"https://login.example.test/auth","token_endpoint":"https://login.example.test/token","jwks_uri":"https://keys.example.test/keys","userinfo_endpoint":"https://keys.example.test/userinfo"}`
	if _, err := decodeOIDCProviderConfig([]byte(document), config.Issuer, trusted); err != nil {
		t.Fatalf("explicit split-host discovery rejected: %v", err)
	}
}

func TestOIDCRoundTripperBlocksUnapprovedAuthorityBeforeNetwork(t *testing.T) {
	called := false
	transport := oidcRestrictedTransport{
		base:        roundTripperFunc(func(*http.Request) (*http.Response, error) { called = true; return nil, nil }),
		authorities: map[string]struct{}{"id.example.test:443": {}},
	}
	request := httptest.NewRequest(http.MethodGet, "https://127.0.0.1:8443/jwks", nil)
	if _, err := transport.RoundTrip(request); err == nil {
		t.Fatal("unapproved endpoint request was allowed")
	}
	if called {
		t.Fatal("unapproved endpoint reached the network transport")
	}
}

func TestOIDCHTTPClientDoesNotFollowDiscoveryTokenOrJWKSRedirects(t *testing.T) {
	finalHits := map[string]int{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "-final") {
			finalHits[r.URL.Path]++
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, r.URL.Path+"-final", http.StatusFound)
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	authorities := map[string]struct{}{oidcAuthority(parsed): {}}
	client := newOIDCHTTPClientWithResolver(server.Client().Transport, authorities, func(_ context.Context, host string) ([]net.IPAddr, error) {
		if host != parsed.Hostname() {
			return nil, fmt.Errorf("unexpected lookup host %q", host)
		}
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}, func(ip net.IP) bool { return ip.IsLoopback() })
	for _, path := range []string{"/discovery", "/token", "/jwks"} {
		response, err := client.Get(server.URL + path)
		if err != nil {
			t.Fatalf("request %s: %v", path, err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusFound {
			t.Errorf("request %s status=%d, want redirect response", path, response.StatusCode)
		}
	}
	if len(finalHits) != 0 {
		t.Fatalf("redirect targets were contacted: %#v", finalHits)
	}
}

func TestOIDCRestrictedTransportPinsResolvedAddressAndRejectsPrivateDNS(t *testing.T) {
	var lookedUp string
	lookup := func(_ context.Context, host string) ([]net.IPAddr, error) {
		lookedUp = host
		return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}, nil
	}
	addresses, port, err := resolveOIDCAddresses(context.Background(), "id.example.test:443", lookup, oidcPublicAddress)
	if err != nil {
		t.Fatal(err)
	}
	if lookedUp != "id.example.test" || port != "443" {
		t.Fatalf("DNS lookup host=%q port=%q", lookedUp, port)
	}
	if got := net.JoinHostPort(addresses[0].IP.String(), port); got != "1.1.1.1:443" {
		t.Fatalf("pinned dial target = %q, want resolved IP and original port", got)
	}

	for _, privateIP := range []string{"127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.0.1", "2001:db8::1"} {
		_, _, err := resolveOIDCAddresses(context.Background(), "id.example.test:443", func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP(privateIP)}}, nil
		}, oidcPublicAddress)
		if err == nil || !strings.Contains(err.Error(), "outside the public network") {
			t.Errorf("private DNS answer %s error = %v, want public-network rejection", privateIP, err)
		}
	}
}

func TestOIDCTransportFailsClosedWhenItCannotPinDNS(t *testing.T) {
	client := newOIDCHTTPClient(roundTripperFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("un-pinned transport was reached")
		return nil, nil
	}), map[string]struct{}{"id.example.test:443": {}})
	if _, err := client.Get("https://id.example.test/jwks"); err == nil || !strings.Contains(err.Error(), "cannot pin DNS") {
		t.Fatalf("client error = %v, want fail-closed pinning error", err)
	}
}

func TestOIDCAuthorizedPartyMatchesAudienceRules(t *testing.T) {
	for _, test := range []struct {
		name     string
		audience []string
		azp      string
		want     bool
	}{
		{name: "single audience without azp", audience: []string{"client"}, want: true},
		{name: "multi audience without azp", audience: []string{"client", "other"}, want: false},
		{name: "multi audience matching azp", audience: []string{"client", "other"}, azp: "client", want: true},
		{name: "multi audience mismatched azp", audience: []string{"client", "other"}, azp: "other", want: false},
		{name: "single audience mismatched azp", audience: []string{"client"}, azp: "other", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := validOIDCAuthorizedParty(test.audience, test.azp, "client"); got != test.want {
				t.Fatalf("validOIDCAuthorizedParty() = %t, want %t", got, test.want)
			}
		})
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestSafeOIDCReturnToRejectsExternalAndProtocolRelativeTargets(t *testing.T) {
	for _, value := range []string{"https://evil.test", "//evil.test/path", "/%2f%2fevil.test", "/\\evil.test", "/path#fragment", "javascript:alert(1)"} {
		if got := safeOIDCReturnTo(value); got != "/" {
			t.Errorf("safeOIDCReturnTo(%q) = %q, want /", value, got)
		}
	}
	if got := safeOIDCReturnTo("/settings?tab=security"); got != "/settings?tab=security" {
		t.Fatalf("safe relative return path changed: %q", got)
	}
}
