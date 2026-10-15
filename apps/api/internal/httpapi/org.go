package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"unicode/utf16"

	businesscontract "github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract/business"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/google/uuid"
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

// maxSoulLength mirrors the TypeScript z.string().max(8000) contract, which
// counts UTF-16 code units rather than UTF-8 bytes.
const maxSoulLength = 8000

// maxSoulBodyBytes allows an 8,000-code-unit string encoded as JSON escapes
// (six bytes per code unit), plus the object wrapper, while keeping the input
// bounded.
const maxSoulBodyBytes = 64 * 1024

// OrgHandler serves the public /api/org surface: the organization switcher, the
// active-organization switch, and the organization's agent persona.
//
// It resolves the session itself through the session middleware rather than
// trusting an assertion minted elsewhere, which is what lets it eventually own
// the route outright.
type OrgHandler struct {
	repo              OrgRepository
	session           SessionResolver
	logger            *slog.Logger
	secret            string
	trustedProxyCIDRs []*net.IPNet
}

func NewOrgHandler(repo OrgRepository, resolver SessionResolver, secret string, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) *OrgHandler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &OrgHandler{repo: repo, session: resolver, secret: secret, logger: logger, trustedProxyCIDRs: trusted}
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
		if errors.Is(err, session.ErrNoSession) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		h.fail(w, "resolve session", err)
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
		writeJSON(w, http.StatusOK, businesscontract.OrganizationListResponse{Orgs: []businesscontract.OrganizationSummary{}})
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

	var activeOrgID *uuid.UUID
	if actor.resolved.OrgID != nil {
		parsed, err := uuid.Parse(*actor.resolved.OrgID)
		if err != nil {
			h.fail(w, "encode active organization", err)
			return
		}
		activeOrgID = &parsed
	}
	responseOrgs := make([]businesscontract.OrganizationSummary, 0, len(orgs))
	for _, org := range orgs {
		id, err := uuid.Parse(org.ID)
		if err != nil {
			h.fail(w, "encode organization membership", err)
			return
		}
		responseOrgs = append(responseOrgs, businesscontract.OrganizationSummary{
			Id:           id,
			Name:         org.Name,
			BaseCurrency: org.BaseCurrency,
		})
	}
	writeJSON(w, http.StatusOK, businesscontract.OrganizationListResponse{ActiveOrgId: activeOrgID, Orgs: responseOrgs})
}

// post switches the active organization by setting the per-session cookie.
// Membership is re-checked here rather than trusted from the cookie, so a
// tampered cookie cannot select a tenant the caller does not belong to.
func (h *OrgHandler) post(w http.ResponseWriter, r *http.Request, actor *orgActor) {
	if !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
	if !actor.resolved.EmailVerified {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "email verification required"})
		return
	}

	var body businesscontract.OrganizationSwitchRequest
	if !decodeJSONBody(w, r, 4096, &body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	orgID := body.OrgId.String()
	if body.OrgId == uuid.Nil || !isUUID(orgID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	member, err := h.repo.IsMember(r.Context(), actor.resolved.UserID, orgID)
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
		Value:    orgID,
		Path:     "/",
		MaxAge:   activeOrgCookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, businesscontract.OrganizationSwitchSuccess{Ok: businesscontract.OrganizationSwitchSuccessOkTrue})
}

// patch replaces the organization's agent persona. This text steers every agent
// turn for the whole organization, so it is admin-gated.
func (h *OrgHandler) patch(w http.ResponseWriter, r *http.Request, actor *orgActor) {
	if !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
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
	writeJSON(w, http.StatusOK, businesscontract.OrganizationWriteSuccess{Ok: businesscontract.OrganizationWriteSuccessOkTrue})
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
	writeJSON(w, http.StatusOK, businesscontract.AgentSoulResponse{AgentSoul: soul})
}

// decodeSoul reads the persona body and applies the legacy trimming rule: an
// all-whitespace persona clears it rather than storing blanks.
func decodeSoul(r *http.Request, w http.ResponseWriter) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSoulBodyBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	agentSoulJSON, ok := fields["agentSoul"]
	if !ok || bytes.Equal(bytes.TrimSpace(agentSoulJSON), []byte("null")) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	var body businesscontract.OrganizationSoulPatchRequest
	if err := json.Unmarshal(data, &body); err != nil || utf16CodeUnits(body.AgentSoul) > maxSoulLength {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	if strings.TrimSpace(body.AgentSoul) == "" {
		return "", true
	}
	return strings.TrimSpace(body.AgentSoul), true
}

func utf16CodeUnits(value string) int {
	length := 0
	for _, r := range value {
		length += utf16.RuneLen(r)
	}
	return length
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
