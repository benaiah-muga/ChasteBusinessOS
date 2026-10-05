package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const authBodyLimit = 1 << 20

// NewAuthHandler creates the opt-in Go implementation of Better Auth's
// email/password and session endpoints. It does not change production route
// ownership by itself; main only mounts it while GO_AUTH_ROUTE=1.
func NewAuthHandler(service *authn.Service, secret string, secureCookie bool, logger *slog.Logger) http.Handler {
	handler, _ := NewAuthHandlerWithTrustedProxyCIDRs(service, secret, secureCookie, logger, nil)
	return handler
}

func NewAuthHandlerWithTrustedProxyCIDRs(service *authn.Service, secret string, secureCookie bool, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet) (http.Handler, error) {
	return NewAuthHandlerWithOIDCRoutes(service, secret, secureCookie, logger, trustedProxyCIDRs, nil)
}

func NewAuthHandlerWithOIDCRoutes(service *authn.Service, secret string, secureCookie bool, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet, oidcRoutes http.Handler) (http.Handler, error) {
	if logger == nil {
		logger = slog.Default()
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	h := &authHandler{service: service, secret: secret, secureCookie: secureCookie, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sign-up/email", h.signUp)
	mux.HandleFunc("POST /sign-in/email", h.signIn)
	mux.HandleFunc("POST /send-verification-email", h.sendVerification)
	mux.HandleFunc("GET /verify-email", h.verifyEmail)
	mux.HandleFunc("POST /request-password-reset", h.requestPasswordReset)
	mux.HandleFunc("GET /reset-password/{token}", h.resetPasswordCallback)
	mux.HandleFunc("POST /reset-password", h.resetPassword)
	mux.HandleFunc("GET /get-session", h.getSession)
	mux.HandleFunc("POST /get-session", h.getSession)
	mux.HandleFunc("POST /sign-out", h.signOut)
	mux.HandleFunc("POST /revoke-session", h.revokeSession)
	mux.HandleFunc("POST /revoke-sessions", h.revokeSessions)
	if oidcRoutes != nil {
		mux.Handle("GET /sign-in/oidc", oidcRoutes)
		mux.Handle("GET /callback/oidc", oidcRoutes)
		mux.Handle("POST /native/exchange", oidcRoutes)
	}
	return mux, nil
}

func ParseTrustedProxyCIDRs(raw string) ([]*net.IPNet, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var cidrs []*net.IPNet
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, errors.New("trusted proxy CIDR list contains an empty entry")
		}
		_, cidr, err := net.ParseCIDR(item)
		if err != nil {
			return nil, errors.New("trusted proxy CIDR list is invalid")
		}
		cidrs = append(cidrs, cidr)
	}
	return cidrs, nil
}

type authHandler struct {
	service           *authn.Service
	secret            string
	secureCookie      bool
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type authCredentials struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	Name       string `json:"name"`
	Callback   string `json:"callbackURL"`
	RememberMe *bool  `json:"rememberMe"`
}

func (h *authHandler) signUp(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "sign-up/email", true) {
		return
	}
	var body authCredentials
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.Password == "" {
		writeAuthError(w, http.StatusBadRequest, "INVALID_PASSWORD", "Invalid password")
		return
	}
	if body.Callback != "" && !h.validCallback(body.Callback) {
		writeAuthError(w, http.StatusForbidden, "INVALID_CALLBACK_URL", "Invalid callback URL")
		return
	}
	if body.Name == "" {
		body.Name = strings.Split(body.Email, "@")[0]
	}
	user, created, err := h.service.SignUpWithCallback(r.Context(), body.Email, body.Password, body.Name, body.Callback)
	if errors.Is(err, authn.ErrInvalidEmail) {
		writeAuthError(w, http.StatusBadRequest, "INVALID_EMAIL", "Invalid email")
		return
	}
	if errors.Is(err, authn.ErrInvalidPassword) {
		writeAuthError(w, http.StatusBadRequest, "PASSWORD_TOO_SHORT", "Password does not meet the minimum length")
		return
	}
	if errors.Is(err, authn.ErrDeliveryUnavailable) {
		writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication email delivery is unavailable")
		return
	}
	if err != nil {
		h.logger.Error("Go auth sign-up failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	if !created {
		writeAuthJSON(w, http.StatusOK, map[string]any{"token": nil, "user": user})
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{"token": nil, "user": user})
}

func (h *authHandler) signIn(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "sign-in/email", true) {
		return
	}
	var body authCredentials
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.Callback != "" && !h.validCallback(body.Callback) {
		writeAuthError(w, http.StatusForbidden, "INVALID_CALLBACK_URL", "Invalid callback URL")
		return
	}
	rememberMe := body.RememberMe == nil || *body.RememberMe
	identity, err := h.service.SignInWithRememberMeCallback(r.Context(), body.Email, body.Password, body.Callback, rememberMe)
	switch {
	case errors.Is(err, authn.ErrInvalidCredentials):
		writeAuthError(w, http.StatusUnauthorized, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password")
		return
	case errors.Is(err, authn.ErrEmailNotVerified):
		writeAuthError(w, http.StatusForbidden, "EMAIL_NOT_VERIFIED", "Email not verified")
		return
	case errors.Is(err, authn.ErrDeliveryUnavailable):
		writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication email delivery is unavailable")
		return
	case err != nil:
		h.logger.Error("Go auth sign-in failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	if err := h.setSessionCookie(w, identity.Session.Token, identity.Session.ExpiresAt, rememberMe); err != nil {
		h.logger.Error("Go auth session cookie signing failed", "error", err)
		_ = h.service.RevokeSession(r.Context(), identity.Session.Token)
		writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication is unavailable")
		return
	}
	var callback any
	if body.Callback != "" {
		callback = body.Callback
	}
	var token any
	if !requestHasBrowserContext(r) {
		token = identity.Session.Token
	}
	w.Header().Set("Cache-Control", "no-store")
	writeAuthJSON(w, http.StatusOK, map[string]any{"redirect": body.Callback != "", "token": token, "url": callback, "user": identity.User})
}

func (h *authHandler) sendVerification(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "send-verification-email", true) {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Callback string `json:"callbackURL"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.Callback != "" && !h.validCallback(body.Callback) {
		writeAuthError(w, http.StatusForbidden, "INVALID_CALLBACK_URL", "Invalid callback URL")
		return
	}
	if err := h.service.SendVerification(r.Context(), body.Email, body.Callback); err != nil {
		if errors.Is(err, authn.ErrInvalidEmail) {
			writeAuthError(w, http.StatusBadRequest, "INVALID_EMAIL", "Invalid email")
			return
		}
		if errors.Is(err, authn.ErrDeliveryUnavailable) {
			writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication email delivery is unavailable")
			return
		}
		h.logger.Error("Go auth verification request failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]bool{"status": true})
}

func (h *authHandler) verifyEmail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	callback := r.URL.Query().Get("callbackURL")
	if callback != "" && !h.validCallback(callback) {
		writeAuthError(w, http.StatusForbidden, "INVALID_CALLBACK_URL", "Invalid callback URL")
		return
	}
	if err := h.service.VerifyEmail(r.Context(), r.URL.Query().Get("token")); err != nil {
		if errors.Is(err, authn.ErrInvalidToken) {
			writeAuthError(w, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid or expired token")
			return
		}
		h.logger.Error("Go auth email verification failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	if callback != "" {
		http.Redirect(w, r, callback, http.StatusFound)
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{"status": true, "user": nil})
}

func (h *authHandler) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "request-password-reset", true) {
		return
	}
	var body struct {
		Email      string `json:"email"`
		RedirectTo string `json:"redirectTo"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.RedirectTo != "" && !h.validCallback(body.RedirectTo) {
		writeAuthError(w, http.StatusForbidden, "INVALID_REDIRECT_URL", "Invalid redirect URL")
		return
	}
	message, err := h.service.RequestPasswordReset(r.Context(), body.Email, body.RedirectTo)
	if errors.Is(err, authn.ErrInvalidEmail) {
		writeAuthError(w, http.StatusBadRequest, "INVALID_EMAIL", "Invalid email")
		return
	}
	if errors.Is(err, authn.ErrDeliveryUnavailable) {
		writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication email delivery is unavailable")
		return
	}
	if err != nil {
		h.logger.Error("Go auth password recovery request failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{"status": true, "message": message})
}

func (h *authHandler) resetPasswordCallback(w http.ResponseWriter, r *http.Request) {
	callback := r.URL.Query().Get("callbackURL")
	if callback == "" || !h.validCallback(callback) {
		writeAuthError(w, http.StatusBadRequest, "INVALID_CALLBACK_URL", "Invalid callback URL")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	valid, err := h.service.RecoveryTokenValid(r.Context(), r.PathValue("token"))
	if err != nil {
		h.logger.Error("Go auth password recovery token lookup failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	query, err := url.Parse(callback)
	if err != nil {
		writeAuthError(w, http.StatusBadRequest, "INVALID_CALLBACK_URL", "Invalid callback URL")
		return
	}
	values := query.Query()
	if !valid {
		values.Set("error", "INVALID_TOKEN")
	} else {
		values.Set("token", r.PathValue("token"))
	}
	query.RawQuery = values.Encode()
	http.Redirect(w, r, query.String(), http.StatusFound)
}

func (h *authHandler) resetPassword(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "reset-password", true) {
		return
	}
	var body struct {
		NewPassword string `json:"newPassword"`
		Token       string `json:"token"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.Token == "" {
		body.Token = r.URL.Query().Get("token")
	}
	if err := h.service.ResetPassword(r.Context(), body.Token, body.NewPassword); err != nil {
		if errors.Is(err, authn.ErrInvalidToken) {
			writeAuthError(w, http.StatusBadRequest, "INVALID_TOKEN", "Invalid or expired token")
			return
		}
		if errors.Is(err, authn.ErrInvalidPassword) {
			writeAuthError(w, http.StatusBadRequest, "PASSWORD_TOO_SHORT", "Password does not meet the minimum length")
			return
		}
		h.logger.Error("Go auth password reset failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]bool{"status": true})
}

func (h *authHandler) getSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodPost && !h.mutationAllowed(w, r, "get-session", false) {
		return
	}
	token, err := h.requestToken(r)
	if err != nil || token == "" {
		writeAuthJSON(w, http.StatusOK, nil)
		return
	}
	identity, err := h.service.GetSession(r.Context(), token)
	if err != nil {
		writeAuthJSON(w, http.StatusOK, nil)
		return
	}
	if identity.Session.Refreshed && r.Header.Get("Authorization") == "" {
		if err := h.setSessionCookie(w, identity.Session.Token, identity.Session.ExpiresAt, true); err != nil {
			h.logger.Error("Go auth session refresh cookie signing failed", "error", err)
			writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable")
			return
		}
	}
	writeAuthJSON(w, http.StatusOK, identity)
}

func requestHasBrowserContext(r *http.Request) bool {
	for _, header := range []string{"Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"} {
		if strings.TrimSpace(r.Header.Get(header)) != "" {
			return true
		}
	}
	return false
}

func (h *authHandler) signOut(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "sign-out", false) {
		return
	}
	token, _ := h.requestToken(r)
	if token != "" {
		if err := h.service.RevokeSession(r.Context(), token); err != nil {
			h.logger.Error("Go auth sign-out failed", "error", err)
			writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
			return
		}
	}
	h.clearSessionCookie(w)
	writeAuthJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (h *authHandler) revokeSession(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "revoke-session", false) {
		return
	}
	current, ok := h.currentSession(w, r)
	if !ok {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.Token != "" {
		if err := h.service.RevokeSessionForUser(r.Context(), body.Token, current.User.ID); err != nil {
			h.logger.Error("Go auth session revocation failed", "error", err)
			writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
			return
		}
	}
	writeAuthJSON(w, http.StatusOK, map[string]bool{"status": true})
}

func (h *authHandler) revokeSessions(w http.ResponseWriter, r *http.Request) {
	if !h.mutationAllowed(w, r, "revoke-sessions", false) {
		return
	}
	current, ok := h.currentSession(w, r)
	if !ok {
		return
	}
	if err := h.service.RevokeAllSessions(r.Context(), current.User.ID); err != nil {
		h.logger.Error("Go auth session revocation failed", "error", err)
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	h.clearSessionCookie(w)
	writeAuthJSON(w, http.StatusOK, map[string]bool{"status": true})
}

func (h *authHandler) currentSession(w http.ResponseWriter, r *http.Request) (authn.Identity, bool) {
	token, err := h.requestToken(r)
	if err != nil || token == "" {
		writeAuthError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return authn.Identity{}, false
	}
	identity, err := h.service.GetSession(r.Context(), token)
	if err != nil {
		writeAuthError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return authn.Identity{}, false
	}
	return identity, true
}

func (h *authHandler) requestToken(r *http.Request) (string, error) {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" || len(fields[1]) > 512 {
			return "", errors.New("invalid authorization header")
		}
		return fields[1], nil
	}
	signed := session.CookieFromRequest(r, session.SessionCookieName)
	if signed == "" {
		return "", nil
	}
	return session.VerifySignedCookie(signed, h.secret)
}

func (h *authHandler) setSessionCookie(w http.ResponseWriter, token string, expiresAt time.Time, rememberMe bool) error {
	signed, err := session.SignSessionCookie(token, h.secret)
	if err != nil {
		return err
	}
	cookie := &http.Cookie{Name: session.SessionCookieName, Value: signed, Path: "/", HttpOnly: true, Secure: h.secureCookie, SameSite: http.SameSiteLaxMode}
	if rememberMe {
		cookie.Expires = expiresAt.UTC()
		cookie.MaxAge = max(0, int(time.Until(expiresAt).Seconds()))
	}
	http.SetCookie(w, cookie)
	return nil
}

func (h *authHandler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: session.SessionCookieName, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(1, 0).UTC(), HttpOnly: true, Secure: h.secureCookie, SameSite: http.SameSiteLaxMode})
}

func (h *authHandler) mutationAllowed(w http.ResponseWriter, r *http.Request, action string, rateLimit bool) bool {
	if !h.checkCSRF(w, r) {
		return false
	}
	if rateLimit {
		ip := requestClientIP(r, h.trustedProxyCIDRs)
		allowed, retry, err := h.service.AllowAuthAttempt(r.Context(), action, ip)
		if err != nil {
			h.logger.Error("Go auth throttle unavailable", "endpoint", action, "error", err)
			writeAuthError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable")
			return false
		}
		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retry.Seconds()))))
			writeAuthError(w, http.StatusTooManyRequests, "TOO_MANY_REQUESTS", "Too many requests")
			return false
		}
	}
	return true
}

func (h *authHandler) checkCSRF(w http.ResponseWriter, r *http.Request) bool {
	_, hasCookie := r.Header["Cookie"]
	if len(r.Header.Values("Origin")) > 1 || len(r.Header.Values("Referer")) > 1 {
		writeAuthError(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid request origin")
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	referer := strings.TrimSpace(r.Header.Get("Referer"))
	site := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))
	mode := strings.TrimSpace(r.Header.Get("Sec-Fetch-Mode"))
	dest := strings.TrimSpace(r.Header.Get("Sec-Fetch-Dest"))
	if site == "cross-site" && mode == "navigate" {
		writeAuthError(w, http.StatusForbidden, "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED", "Cross-site login request blocked")
		return false
	}
	needsOrigin := hasCookie || origin != "" || referer != "" || site != "" || mode != "" || dest != ""
	if !needsOrigin {
		return true // Native clients use Authorization: Bearer and no ambient cookies.
	}
	if origin == "" {
		if referer == "" {
			writeAuthError(w, http.StatusForbidden, "MISSING_OR_NULL_ORIGIN", "Missing request origin")
			return false
		}
		parsed, err := url.Parse(referer)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			writeAuthError(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid request origin")
			return false
		}
		origin = parsed.Scheme + "://" + parsed.Host
	}
	if origin == "null" || !h.service.ValidateOrigin(origin) {
		writeAuthError(w, http.StatusForbidden, "INVALID_ORIGIN", "Invalid request origin")
		return false
	}
	return true
}

func (h *authHandler) validCallback(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.User != nil || strings.ContainsAny(value, "\\\r\n") {
		return false
	}
	if !parsed.IsAbs() {
		return strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//")
	}
	return h.service.ValidateOrigin(value)
}

func decodeAuthBody(w http.ResponseWriter, r *http.Request, target any) bool {
	if r.Body == nil {
		writeAuthError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return false
	}
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, authBodyLimit))
	if err := decoder.Decode(target); err != nil {
		writeAuthError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeAuthError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return false
	}
	return true
}

func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return ""
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	return ip.String()
}

func requestClientIP(r *http.Request, trustedProxyCIDRs []*net.IPNet) string {
	peerText, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ""
	}
	peer := net.ParseIP(peerText)
	if peer == nil {
		return ""
	}
	if !isTrustedProxy(peer, trustedProxyCIDRs) {
		return peer.String()
	}
	forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if forwarded == "" {
		return peer.String()
	}
	parts := strings.Split(forwarded, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := net.ParseIP(strings.TrimSpace(parts[i]))
		if candidate == nil {
			return ""
		}
		if !isTrustedProxy(candidate, trustedProxyCIDRs) {
			return candidate.String()
		}
	}
	return peer.String()
}

func isTrustedProxy(ip net.IP, trustedProxyCIDRs []*net.IPNet) bool {
	for _, cidr := range trustedProxyCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}

func writeAuthJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeAuthError(w http.ResponseWriter, status int, code, message string) {
	writeAuthJSON(w, status, map[string]string{"code": code, "message": message})
}
