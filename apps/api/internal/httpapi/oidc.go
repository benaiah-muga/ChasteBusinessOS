package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const oidcStateCookiePrefix = "chaste_oidc_state_"

type OIDCConfig struct {
	Issuer               string
	ClientID             string
	ClientSecret         string
	RedirectURI          string
	NativeRedirectURI    string
	TrustVerifiedEmail   bool
	AllowedEndpointHosts string
}

type oidcSignInHandler struct {
	service           *authn.Service
	secret            string
	secureCookie      bool
	trustedProxyCIDRs []*net.IPNet
	logger            *slog.Logger
	config            OIDCConfig
	provider          *oidc.Provider
	verifier          *oidc.IDTokenVerifier
	oauth             oauth2.Config
	httpClient        *http.Client
}

func NewOIDCSignInHandler(ctx context.Context, service *authn.Service, secret string, secureCookie bool, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet, config OIDCConfig) (http.Handler, error) {
	if service == nil || len([]byte(secret)) < 32 {
		return nil, errors.New("OIDC requires the Go auth service and a 32-byte signing secret")
	}
	if logger == nil {
		logger = slog.Default()
	}
	trustedAuthorities, err := validateOIDCConfig(config, secureCookie)
	if err != nil {
		return nil, err
	}
	baseTransport := http.DefaultTransport.(*http.Transport).Clone()
	providerHTTPClient := newOIDCHTTPClient(baseTransport, trustedAuthorities)
	providerCtx, cancel := context.WithTimeout(oidc.ClientContext(ctx, providerHTTPClient), 8*time.Second)
	defer cancel()
	providerConfig, err := fetchOIDCProviderConfig(providerCtx, providerHTTPClient, config.Issuer, trustedAuthorities)
	if err != nil {
		return nil, fmt.Errorf("discover OIDC issuer: %w", err)
	}
	provider := providerConfig.NewProvider(providerCtx)
	endpoint := provider.Endpoint()
	handler := &oidcSignInHandler{
		service: service, secret: secret, secureCookie: secureCookie, trustedProxyCIDRs: trustedProxyCIDRs,
		logger: logger, config: config, provider: provider,
		verifier:   provider.Verifier(&oidc.Config{ClientID: config.ClientID}),
		oauth:      oauth2.Config{ClientID: config.ClientID, ClientSecret: config.ClientSecret, Endpoint: endpoint, RedirectURL: config.RedirectURI, Scopes: []string{oidc.ScopeOpenID, "email", "profile"}},
		httpClient: providerHTTPClient,
	}
	mux := http.NewServeMux()
	handler.Register(mux)
	return mux, nil
}

func validateOIDCConfig(config OIDCConfig, secureCookie bool) (map[string]struct{}, error) {
	issuer, err := url.Parse(config.Issuer)
	if err != nil || issuer == nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return nil, errors.New("OIDC issuer must be a configured HTTPS URL without credentials, query, or fragment")
	}
	if strings.TrimSpace(config.ClientID) == "" || strings.TrimSpace(config.ClientSecret) == "" {
		return nil, errors.New("OIDC client ID and client secret are required")
	}
	if config.NativeRedirectURI != "" && !validOIDCNativeRedirectURI(config.NativeRedirectURI) {
		return nil, errors.New("OIDC native redirect URI must be a configured custom-scheme callback without query or fragment")
	}
	redirect, err := url.Parse(config.RedirectURI)
	if err != nil || redirect == nil || redirect.Host == "" || redirect.User != nil || redirect.RawQuery != "" || redirect.Fragment != "" || redirect.Path != "/api/auth/callback/oidc" {
		return nil, errors.New("OIDC redirect URI must be an absolute configured /api/auth/callback/oidc URL")
	}
	if redirect.Scheme != "https" && !(redirect.Scheme == "http" && isLoopbackHost(redirect.Hostname()) && !secureCookie) {
		return nil, errors.New("OIDC redirect URI must use HTTPS (HTTP is allowed only on loopback in development)")
	}
	trusted := map[string]struct{}{oidcAuthority(issuer): {}}
	for _, value := range strings.Split(config.AllowedEndpointHosts, ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		allowed, parseErr := url.Parse("//" + value)
		if parseErr != nil || allowed == nil || allowed.Host == "" || allowed.User != nil || allowed.Path != "" || allowed.RawQuery != "" || allowed.Fragment != "" || strings.ContainsAny(value, "*/\\") {
			return nil, errors.New("OIDC allowed endpoint hosts must be exact host[:port] authorities")
		}
		trusted[oidcAuthority(allowed)] = struct{}{}
	}
	return trusted, nil
}

func oidcAuthority(parsed *url.URL) string {
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	port := parsed.Port()
	if port == "" {
		port = "443"
	}
	return net.JoinHostPort(host, port)
}

func validateOIDCEndpoint(value string, trusted map[string]struct{}) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return false
	}
	_, ok := trusted[oidcAuthority(parsed)]
	return ok
}

type oidcRestrictedTransport struct {
	base        http.RoundTripper
	authorities map[string]struct{}
	pinningErr  error
}

func newOIDCHTTPClient(base http.RoundTripper, authorities map[string]struct{}) *http.Client {
	return newOIDCHTTPClientWithResolver(base, authorities, net.DefaultResolver.LookupIPAddr, oidcPublicAddress)
}

func newOIDCHTTPClientWithResolver(
	base http.RoundTripper,
	authorities map[string]struct{},
	lookup func(context.Context, string) ([]net.IPAddr, error),
	allowIP func(net.IP) bool,
) *http.Client {
	transport, ok := base.(*http.Transport)
	if !ok || lookup == nil || allowIP == nil {
		return &http.Client{
			Transport: oidcRestrictedTransport{base: base, authorities: authorities, pinningErr: errors.New("OIDC transport cannot pin DNS results")},
			Timeout:   8 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	transport = transport.Clone()
	// Proxies and TLS dial hooks can resolve the hostname again, bypassing the
	// address check below, so OIDC connections use the pinned IP directly.
	transport.Proxy = nil
	transport.DialTLSContext = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		addresses, port, err := resolveOIDCAddresses(ctx, address, lookup, allowIP)
		if err != nil {
			return nil, err
		}
		dialer := net.Dialer{}
		var lastErr error
		for _, candidate := range addresses {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
	return &http.Client{
		Transport: oidcRestrictedTransport{base: transport, authorities: authorities},
		Timeout:   8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func resolveOIDCAddresses(
	ctx context.Context,
	address string,
	lookup func(context.Context, string) ([]net.IPAddr, error),
	allowIP func(net.IP) bool,
) ([]net.IPAddr, string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, "", errors.New("OIDC endpoint address is invalid")
	}
	addresses := make([]net.IPAddr, 0, 1)
	if ip := net.ParseIP(host); ip != nil {
		addresses = append(addresses, net.IPAddr{IP: ip})
	} else {
		addresses, err = lookup(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, "", errors.New("OIDC endpoint DNS lookup failed")
		}
	}
	for _, candidate := range addresses {
		if candidate.Zone != "" || !allowIP(candidate.IP) {
			return nil, "", errors.New("OIDC endpoint resolved outside the public network")
		}
	}
	return addresses, port, nil
}

func oidcPublicAddress(ip net.IP) bool {
	return supportPublicIP(ip)
}

func (t oidcRestrictedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL == nil || !validateOIDCEndpoint(request.URL.String(), t.authorities) {
		return nil, errors.New("OIDC request endpoint is outside the configured trust boundary")
	}
	if t.pinningErr != nil {
		return nil, t.pinningErr
	}
	return t.base.RoundTrip(request)
}

func fetchOIDCProviderConfig(ctx context.Context, client *http.Client, issuer string, trusted map[string]struct{}) (*oidc.ProviderConfig, error) {
	discoveryURL := strings.TrimSuffix(issuer, "/") + "/.well-known/openid-configuration"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	if err != nil {
		return nil, errors.New("invalid OIDC discovery URL")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("OIDC discovery request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("OIDC discovery request returned an unsuccessful status")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return nil, errors.New("OIDC discovery document is invalid or too large")
	}
	return decodeOIDCProviderConfig(body, issuer, trusted)
}

func decodeOIDCProviderConfig(body []byte, issuer string, trusted map[string]struct{}) (*oidc.ProviderConfig, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, errors.New("OIDC discovery document is invalid")
	}
	for key, rawValue := range fields {
		if !strings.HasSuffix(key, "_endpoint") && !strings.HasSuffix(key, "_uri") {
			continue
		}
		var value string
		if err := json.Unmarshal(rawValue, &value); err != nil || value == "" || !validateOIDCEndpoint(value, trusted) {
			return nil, errors.New("OIDC discovery contains an endpoint outside the configured HTTPS trust boundary")
		}
	}
	var providerConfig oidc.ProviderConfig
	if err := json.Unmarshal(body, &providerConfig); err != nil || providerConfig.IssuerURL != issuer || providerConfig.AuthURL == "" || providerConfig.TokenURL == "" || providerConfig.JWKSURL == "" {
		return nil, errors.New("OIDC discovery issuer or required endpoints are invalid")
	}
	if !validateOIDCEndpoint(providerConfig.AuthURL, trusted) || !validateOIDCEndpoint(providerConfig.TokenURL, trusted) || !validateOIDCEndpoint(providerConfig.JWKSURL, trusted) {
		return nil, errors.New("OIDC required endpoints are outside the configured HTTPS trust boundary")
	}
	return &providerConfig, nil
}

func isLoopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1"
}

func (h *oidcSignInHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /sign-in/oidc", h.start)
	mux.HandleFunc("GET /callback/oidc", h.callback)
	mux.HandleFunc("POST /native/exchange", h.exchangeNativeCode)
}

func (h *oidcSignInHandler) start(w http.ResponseWriter, r *http.Request) {
	allowed, retry, err := h.service.AllowAuthAttempt(r.Context(), "sign-in/email", requestClientIP(r, h.trustedProxyCIDRs))
	if err != nil {
		h.logger.Error("OIDC sign-in throttle unavailable", "error", err)
		writeAuthError(w, http.StatusServiceUnavailable, "unavailable", "Sign-in is temporarily unavailable")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retry.Seconds()))))
		writeAuthError(w, http.StatusTooManyRequests, "rate_limited", "Too many sign-in attempts")
		return
	}
	state, err := randomOIDCString(32)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be started")
		return
	}
	nonce, err := randomOIDCString(32)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be started")
		return
	}
	verifier, err := randomOIDCString(32)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be started")
		return
	}
	returnTo := safeOIDCReturnTo(r.URL.Query().Get("returnTo"))
	nativeChallenge := r.URL.Query().Get("native_code_challenge")
	nativeState := r.URL.Query().Get("native_state")
	if (nativeChallenge != "" || nativeState != "") && (h.config.NativeRedirectURI == "" || !validOIDCNativeChallenge(nativeChallenge) || !validOIDCNativeState(nativeState)) {
		writeAuthError(w, http.StatusBadRequest, "invalid_native_handoff", "Native sign-in parameters are invalid")
		return
	}
	if err := h.service.CreateOIDCTransaction(r.Context(), state, authn.OIDCTransaction{Nonce: nonce, CodeVerifier: verifier, ReturnTo: returnTo, NativeCodeChallenge: nativeChallenge, NativeState: nativeState}); err != nil {
		h.logger.Error("could not store OIDC transaction", "error", err)
		writeAuthError(w, http.StatusServiceUnavailable, "unavailable", "Sign-in is temporarily unavailable")
		return
	}
	stateCookie, err := session.SignSessionCookie(state, h.secret)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be started")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oidcStateCookiePrefix + oidcStateCookieSuffix(state), Value: stateCookie, Path: "/api/auth/callback/oidc", HttpOnly: true, Secure: h.secureCookie, SameSite: http.SameSiteLaxMode, MaxAge: int(authn.OIDCTransactionLifetime.Seconds())})
	authorizationURL := h.oauth.AuthCodeURL(state, oauth2.SetAuthURLParam("nonce", nonce), oauth2.S256ChallengeOption(verifier))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, authorizationURL, http.StatusFound)
}

func (h *oidcSignInHandler) callback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	state := r.URL.Query().Get("state")
	cookieName := oidcStateCookiePrefix + oidcStateCookieSuffix(state)
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	defer http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/api/auth/callback/oidc", HttpOnly: true, Secure: h.secureCookie, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0).UTC()})
	cookieState, err := session.VerifySignedCookie(cookie.Value, h.secret)
	if err != nil || subtle.ConstantTimeCompare([]byte(cookieState), []byte(state)) != 1 {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	transaction, err := h.service.ConsumeOIDCTransaction(r.Context(), state)
	if err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	if r.URL.Query().Get("error") != "" {
		if transaction.NativeCodeChallenge != "" {
			if redirect, redirectErr := nativeOIDCRedirect(h.config.NativeRedirectURI, "", transaction.NativeState, "access_denied"); redirectErr == nil {
				http.Redirect(w, r, redirect, http.StatusSeeOther)
				return
			}
		}
		http.Redirect(w, r, transaction.ReturnTo, http.StatusSeeOther)
		return
	}
	if r.URL.Query().Get("code") == "" {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	providerCtx, cancel := context.WithTimeout(oidc.ClientContext(r.Context(), h.httpClient), 8*time.Second)
	defer cancel()
	token, err := h.oauth.Exchange(providerCtx, r.URL.Query().Get("code"), oauth2.VerifierOption(transaction.CodeVerifier))
	if err != nil {
		h.logger.Warn("OIDC code exchange failed")
		writeAuthError(w, http.StatusUnauthorized, "oidc_sign_in_failed", "Sign-in could not be completed")
		return
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		writeAuthError(w, http.StatusUnauthorized, "oidc_sign_in_failed", "Sign-in could not be completed")
		return
	}
	idToken, err := h.verifier.Verify(providerCtx, rawIDToken)
	if err != nil {
		h.logger.Warn("OIDC token validation failed")
		writeAuthError(w, http.StatusUnauthorized, "oidc_sign_in_failed", "Sign-in could not be completed")
		return
	}
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(transaction.Nonce)) != 1 {
		writeAuthError(w, http.StatusUnauthorized, "oidc_sign_in_failed", "Sign-in could not be completed")
		return
	}
	var claims struct {
		Subject         string `json:"sub"`
		Email           string `json:"email"`
		EmailVerified   bool   `json:"email_verified"`
		Name            string `json:"name"`
		AuthorizedParty string `json:"azp"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Subject == "" || !claims.EmailVerified || !validOIDCAuthorizedParty(idToken.Audience, claims.AuthorizedParty, h.config.ClientID) {
		writeAuthError(w, http.StatusUnauthorized, "oidc_sign_in_failed", "Sign-in could not be completed")
		return
	}
	identity, err := h.service.SignInOIDC(r.Context(), h.config.Issuer, claims.Subject, claims.Email, claims.Name, claims.EmailVerified, h.config.TrustVerifiedEmail)
	if err != nil {
		h.logger.Warn("OIDC identity resolution failed", "error", err)
		writeAuthError(w, http.StatusUnauthorized, "oidc_sign_in_failed", "Sign-in could not be completed")
		return
	}
	nativeCode := ""
	if transaction.NativeCodeChallenge != "" {
		nativeCode, err = h.service.CreateOIDCNativeHandoff(r.Context(), transaction.NativeCodeChallenge, identity.Session.ID)
		if err != nil {
			h.logger.Error("could not create native OIDC handoff")
			writeAuthError(w, http.StatusServiceUnavailable, "unavailable", "Sign-in could not be completed")
			return
		}
	}
	signedSession, err := session.SignSessionCookie(identity.Session.Token, h.secret)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be completed")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: session.SessionCookieName, Value: signedSession, Path: "/", HttpOnly: true, Secure: h.secureCookie, SameSite: http.SameSiteLaxMode, Expires: identity.Session.ExpiresAt.UTC(), MaxAge: max(0, int(time.Until(identity.Session.ExpiresAt).Seconds()))})
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if nativeCode != "" {
		redirect, redirectErr := nativeOIDCRedirect(h.config.NativeRedirectURI, nativeCode, transaction.NativeState, "")
		if redirectErr != nil {
			writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be completed")
			return
		}
		http.Redirect(w, r, redirect, http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, transaction.ReturnTo, http.StatusSeeOther)
}

func (h *oidcSignInHandler) exchangeNativeCode(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.config.NativeRedirectURI == "" {
		writeAuthError(w, http.StatusNotFound, "not_found", "Native sign-in is not enabled")
		return
	}
	mediaType, _, mediaTypeErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaTypeErr != nil || mediaType != "application/json" {
		writeAuthError(w, http.StatusUnsupportedMediaType, "invalid_request", "Native sign-in request is invalid")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"code_verifier"`
	}
	if err := decoder.Decode(&body); err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid_request", "Native sign-in request is invalid")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeAuthError(w, http.StatusBadRequest, "invalid_request", "Native sign-in request is invalid")
		return
	}
	token, err := h.service.ConsumeOIDCNativeHandoff(r.Context(), body.Code, body.CodeVerifier)
	if errors.Is(err, authn.ErrInvalidOIDCNativeHandoff) {
		writeAuthError(w, http.StatusUnauthorized, "invalid_grant", "Native sign-in code is invalid or expired")
		return
	}
	if err != nil {
		h.logger.Error("native OIDC handoff exchange failed", "error", err)
		writeAuthError(w, http.StatusServiceUnavailable, "unavailable", "Native sign-in is temporarily unavailable")
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]string{"access_token": token, "token_type": "Bearer"})
}

func validOIDCNativeRedirectURI(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "javascript", "data", "file":
		return false
	}
	first := parsed.Scheme[0]
	if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')) {
		return false
	}
	for _, char := range parsed.Scheme[1:] {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '+' || char == '.' || char == '-') {
			return false
		}
	}
	return true
}

func validOIDCNativeChallenge(value string) bool {
	if len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func validOIDCNativeState(value string) bool {
	if len(value) < 16 || len(value) > 256 {
		return false
	}
	for _, char := range value {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '.' || char == '_' || char == '~') {
			return false
		}
	}
	return true
}

func nativeOIDCRedirect(redirectURI, code, state, failure string) (string, error) {
	if !validOIDCNativeRedirectURI(redirectURI) {
		return "", errors.New("invalid native OIDC redirect URI")
	}
	parsed, _ := url.Parse(redirectURI)
	query := parsed.Query()
	if failure != "" {
		query.Set("error", failure)
	} else if code != "" {
		query.Set("code", code)
	} else {
		return "", errors.New("native OIDC redirect requires a result")
	}
	query.Set("state", state)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func validOIDCAuthorizedParty(audience []string, authorizedParty, clientID string) bool {
	if len(audience) == 0 || clientID == "" {
		return false
	}
	if len(audience) > 1 && authorizedParty == "" {
		return false
	}
	return authorizedParty == "" || subtle.ConstantTimeCompare([]byte(authorizedParty), []byte(clientID)) == 1
}

func safeOIDCReturnTo(value string) string {
	if value == "" {
		return "/"
	}
	parsed, err := url.Parse(value)
	if err != nil || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.ContainsAny(parsed.Path, "\\\r\n") || strings.HasPrefix(parsed.Path, "//") || parsed.IsAbs() || parsed.Host != "" || parsed.Fragment != "" {
		return "/"
	}
	return value
}

func randomOIDCString(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
func oidcStateCookieSuffix(state string) string {
	sum := sha256.Sum256([]byte(state))
	return base64.RawURLEncoding.EncodeToString(sum[:12])
}
