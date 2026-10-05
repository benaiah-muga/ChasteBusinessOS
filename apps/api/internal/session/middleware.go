package session

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

type contextKey struct{}

// ErrUnauthenticated and ErrForbidden are the two outcomes the middleware
// distinguishes. Everything that is not a resolvable session is
// unauthenticated, including a tampered cookie, an expired session, and a
// revoked one: they must be indistinguishable to a caller probing for which
// failure occurred.
var (
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrForbidden       = errors.New("forbidden")
)

// Middleware resolves the caller for each request and attaches the result to
// the request context.
type Middleware struct {
	resolver *Resolver
}

// NewMiddleware wraps a resolver for use as HTTP middleware.
func NewMiddleware(resolver *Resolver) *Middleware {
	return &Middleware{resolver: resolver}
}

// ResolveRequest is the handler shape for a route that requires a session.
// Returning an error lets the caller distinguish "no session" from "session
// without the required permission".
type ResolveRequest func(r *http.Request, resolved *ResolvedUser) error

// Handler adapts the middleware to net/http. On success the resolved actor is
// in the request context; on failure it writes a JSON error and does not call
// the wrapped handler.
func (m *Middleware) Handler(next ResolveRequest) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var resolved *ResolvedUser
		var err error
		activeOrg := CookieFromRequest(r, ActiveOrgCookieName)
		authorization := strings.TrimSpace(r.Header.Get("Authorization"))
		if authorization != "" {
			fields := strings.Fields(authorization)
			if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
				resolved, err = nil, ErrNoSession
			} else {
				resolved, err = m.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
			}
		} else {
			resolved, err = m.resolver.Resolve(
				r.Context(),
				CookieFromRequest(r, SessionCookieName),
				activeOrg,
			)
		}
		if err != nil {
			// A short secret is a deployment fault, not an anonymous visitor,
			// and must not be reported as "sign in" or it hides a broken config.
			if errors.Is(err, ErrSecretTooShort) {
				http.Error(w, `{"error":"session resolution unavailable"}`, http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSONError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if err := next(r.WithContext(WithResolvedUser(r.Context(), resolved)), resolved); err != nil {
			switch {
			case errors.Is(err, ErrForbidden):
				writeJSONError(w, http.StatusForbidden, "forbidden")
			case errors.Is(err, ErrUnauthenticated):
				w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
				writeJSONError(w, http.StatusUnauthorized, "unauthorized")
			default:
				writeJSONError(w, http.StatusInternalServerError, "internal error")
			}
			return
		}
	})
}

// WithResolvedUser attaches a resolved actor to a context.
func WithResolvedUser(ctx context.Context, resolved *ResolvedUser) context.Context {
	return context.WithValue(ctx, contextKey{}, resolved)
}

// FromContext returns the resolved actor, or nil when the request was not
// resolved. Route handlers behind the middleware always get a non-nil value.
func FromContext(ctx context.Context) *ResolvedUser {
	resolved, _ := ctx.Value(contextKey{}).(*ResolvedUser)
	return resolved
}

// RequirePermission returns a ResolveRequest guard that refuses a caller
// without the named permission in their active organization. It refuses a
// missing organization too, because an actor with no tenant can never hold a
// permission.
func RequirePermission(permission string) func(*ResolvedUser) error {
	return func(resolved *ResolvedUser) error {
		if resolved == nil || resolved.OrgID == nil {
			return ErrForbidden
		}
		if !resolved.HasPermission(permission) {
			return ErrForbidden
		}
		return nil
	}
}

// RequireActiveOrg returns a guard that additionally insists the resolved
// actor has an organization, for routes that cannot act without a tenant.
func RequireActiveOrg(resolved *ResolvedUser) error {
	if resolved == nil || resolved.OrgID == nil {
		return ErrForbidden
	}
	return nil
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":` + quoteJSON(message) + `}`))
}

// quoteJSON escapes a fixed set of internal messages without pulling in an
// encoder for a constant string set.
func quoteJSON(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + replacer.Replace(value) + `"`
}
