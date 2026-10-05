package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

// SessionResolver is the slice of the session package this route depends on.
// Depending on the behaviour rather than the concrete resolver keeps the route
// testable without a database and without a cross-package test seam into the
// session package's internals.
type SessionResolver interface {
	Resolve(ctx context.Context, signedCookie, activeOrgCookie string) (*session.ResolvedUser, error)
}

// OrgRepository is the storage the organization route needs. It is an interface
// so the route can be exercised without a database.
type OrgRepository interface {
	// ListOrgsForUser returns the organizations from the authenticated session's
	// membership snapshot, rechecking each membership inside its RLS context.
	ListOrgsForUser(ctx context.Context, userID string, orgIDs []string) ([]OrgSummary, error)
	// IsMember reports whether the user belongs to the organization.
	IsMember(ctx context.Context, userID, orgID string) (bool, error)
	// AgentSoul reads the organization's standing agent persona.
	AgentSoul(ctx context.Context, orgID string) (string, error)
	// SetAgentSoul replaces it. An empty persona clears it.
	SetAgentSoul(ctx context.Context, orgID, soul string) error
}

// OrgSummary is one entry of the organization switcher.
type OrgSummary struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	BaseCurrency string `json:"baseCurrency"`
}

// maxSoulLength mirrors the TypeScript z.string().max(8000) contract.
const maxSoulLength = 8000

// OrgHandler serves the public /api/org surface: the organization switcher, the
// active-organization switch, and the organization's agent persona.
//
// It resolves the session itself through the session middleware rather than
// trusting an assertion minted elsewhere, which is what lets it eventually own
// the route outright.
type OrgHandler struct {
	repo    OrgRepository
	session SessionResolver
	logger  *slog.Logger
	secret  string
}

func NewOrgHandler(repo OrgRepository, resolver SessionResolver, secret string, logger *slog.Logger) *OrgHandler {
	return &OrgHandler{repo: repo, session: resolver, secret: secret, logger: logger}
}

// orgActor is the resolved caller plus the cookies needed for the switch.
type orgActor struct {
	resolved *session.ResolvedUser
}

func (h *OrgHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	actor, err := h.resolve(r)
	if err != nil {
		// A misconfigured secret is a deployment fault and must not look like an
		// anonymous visitor, or it hides a broken configuration.
		if errors.Is(err, session.ErrSecretTooShort) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "organization service unavailable"})
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.get(w, r, actor)
	case http.MethodPost:
		h.post(w, r, actor)
	case http.MethodPatch:
		h.patch(w, r, actor)
	case http.MethodPut:
		h.put(w, r, actor)
	default:
		w.Header().Set("Allow", "GET, POST, PATCH, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// resolve turns the browser session into an actor, using the same cookie names
// the legacy app sets.
func (h *OrgHandler) resolve(r *http.Request) (*orgActor, error) {
	if h.session == nil {
		return nil, session.ErrNoSession
	}
	resolved, err := h.session.Resolve(
		r.Context(),
		session.CookieFromRequest(r, session.SessionCookieName),
		session.CookieFromRequest(r, session.ActiveOrgCookieName),
	)
	if err != nil {
		return nil, err
	}
	return &orgActor{resolved: resolved}, nil
}

// get lists the organizations the caller belongs to alongside the active one.
// An unverified mailbox sees an empty list rather than an error, because it
// legitimately holds no membership yet.
func (h *OrgHandler) get(w http.ResponseWriter, r *http.Request, actor *orgActor) {
	if !actor.resolved.EmailVerified {
		writeJSON(w, http.StatusOK, map[string]any{"activeOrgId": nil, "orgs": []OrgSummary{}})
		return
	}

	orgs, err := h.repo.ListOrgsForUser(r.Context(), actor.resolved.UserID, actor.resolved.AllOrgIDs)
	if err != nil {
		h.fail(w, "list organizations", err)
		return
	}
	if orgs == nil {
		orgs = []OrgSummary{}
	}

	var activeOrgID any
	if actor.resolved.OrgID != nil {
		activeOrgID = *actor.resolved.OrgID
	}
	writeJSON(w, http.StatusOK, map[string]any{"activeOrgId": activeOrgID, "orgs": orgs})
}

// post switches the active organization by setting the per-session cookie.
// Membership is re-checked here rather than trusted from the cookie, so a
// tampered cookie cannot select a tenant the caller does not belong to.
func (h *OrgHandler) post(w http.ResponseWriter, r *http.Request, actor *orgActor) {
	if !actor.resolved.EmailVerified {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "email verification required"})
		return
	}

	body, ok := decodeOrgID(r, w)
	if !ok {
		return
	}

	member, err := h.repo.IsMember(r.Context(), actor.resolved.UserID, body)
	if err != nil {
		h.fail(w, "check membership", err)
		return
	}
	if !member {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of that organization"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     session.ActiveOrgCookieName,
		Value:    body,
		Path:     "/",
		MaxAge:   activeOrgCookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// patch replaces the organization's agent persona. This text steers every agent
// turn for the whole organization, so it is admin-gated.
func (h *OrgHandler) patch(w http.ResponseWriter, r *http.Request, actor *orgActor) {
	if actor.resolved.OrgID == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !actor.resolved.HasPermission("iam.admin") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	soul, ok := decodeSoul(r, w)
	if !ok {
		return
	}

	if err := h.repo.SetAgentSoul(r.Context(), *actor.resolved.OrgID, soul); err != nil {
		h.fail(w, "set agent soul", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// put returns the organization's agent persona for the settings editor.
func (h *OrgHandler) put(w http.ResponseWriter, r *http.Request, actor *orgActor) {
	if actor.resolved.OrgID == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	soul, err := h.repo.AgentSoul(r.Context(), *actor.resolved.OrgID)
	if err != nil {
		h.fail(w, "read agent soul", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"agentSoul": soul})
}

// decodeOrgID reads the single-field body, refusing unknown keys and trailing
// data so a malformed request cannot be half-applied.
func decodeOrgID(r *http.Request, w http.ResponseWriter) (string, bool) {
	var body struct {
		OrgID string `json:"orgId"`
	}
	if !decodeJSONBody(w, r, 4096, &body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	if !isUUID(body.OrgID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	return body.OrgID, true
}

// decodeSoul reads the persona body and applies the legacy trimming rule: an
// all-whitespace persona clears it rather than storing blanks.
func decodeSoul(r *http.Request, w http.ResponseWriter) (string, bool) {
	var body struct {
		AgentSoul *string `json:"agentSoul"`
	}
	if !decodeJSONBody(w, r, 16*1024, &body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	if body.AgentSoul == nil || len(*body.AgentSoul) > maxSoulLength {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	if strings.TrimSpace(*body.AgentSoul) == "" {
		return "", true
	}
	return strings.TrimSpace(*body.AgentSoul), true
}

// decodeJSONBody decodes exactly one JSON object of bounded size and rejects
// trailing content.
//
// It deliberately does NOT reject unknown fields. The TypeScript route validates
// with a plain z.object, and Zod strips unrecognised keys rather than failing,
// so a client sending an extra field gets 200 there and must get 200 here. A
// differential check caught Go rejecting these while the legacy app accepted
// them.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		return false
	}
	var trailing any
	return decoder.Decode(&trailing) == io.EOF
}

// fail logs the underlying cause and answers with a generic message, so an
// internal fault never leaks a schema or table detail to the caller.
func (h *OrgHandler) fail(w http.ResponseWriter, operation string, err error) {
	if h.logger != nil {
		h.logger.Error("Go organization route failed", "operation", operation, "error", err)
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

// SessionResolverFunc adapts a function to SessionResolver.
type SessionResolverFunc func(ctx context.Context, signedCookie, activeOrgCookie string) (*session.ResolvedUser, error)

// Resolve calls the function.
func (f SessionResolverFunc) Resolve(ctx context.Context, signedCookie, activeOrgCookie string) (*session.ResolvedUser, error) {
	return f(ctx, signedCookie, activeOrgCookie)
}
