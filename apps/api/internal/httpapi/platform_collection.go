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
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

// errPlatformUnavailable marks a platform route whose executor or identity
// dependencies were never wired. Each route answers with its own unavailable
// message so a deployment gap is distinguishable from a denial.
var errPlatformUnavailable = errors.New("platform capability execution unavailable")

// platformCollectionHandler carries the session resolution, capability
// execution and refusal mapping shared by the ported platform routes:
// capability gaps, harness compositions, marketplace, proposals and creator
// evolution.
type platformCollectionHandler struct {
	session      SessionResolver
	executor     CapabilityExecutor
	logger       *slog.Logger
	trustedProxy []*net.IPNet
	unavailable  string
	forbidden    string
	refusalOK    bool
	// refusal422 overrides the shared 422 envelope for routes whose contract
	// differs by capability, such as the marketplace verify verdict.
	refusal422 func(w http.ResponseWriter, capabilityID, message string)
}

func (h *platformCollectionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, error) {
	if h.session == nil {
		return nil, false, session.ErrNoSession
	}
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, session.ErrNoSession
	}
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, session.ErrNoSession
		}
		resolver, ok := h.session.(interface {
			ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
		})
		if !ok {
			return nil, true, session.ErrNoSession
		}
		resolved, err := resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err
	}
	resolved, err := h.session.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err
}

// authenticate resolves the signed-in user or writes the denial response. The
// second result is true only when the caller may proceed.
func (h *platformCollectionHandler) authenticate(w http.ResponseWriter, r *http.Request) (*session.ResolvedUser, bool, bool) {
	resolved, bearer, err := h.resolve(r)
	if err != nil || resolved == nil {
		if errors.Is(err, session.ErrSecretTooShort) {
			h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		} else {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		}
		return nil, false, false
	}
	if resolved.OrgID == nil || !resolved.EmailVerified || !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false, false
	}
	return resolved, bearer, true
}

func (h *platformCollectionHandler) requireSameOrigin(w http.ResponseWriter, r *http.Request, bearer bool) bool {
	if r.Method == http.MethodPost && !bearer && !sameOriginRequest(r, h.trustedProxy) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin check failed"})
		return false
	}
	return true
}

func (h *platformCollectionHandler) execute(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
	if h.executor == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || resolved.OrgID == nil || !isUUID(*resolved.OrgID) {
		return capability.Result{}, errPlatformUnavailable
	}
	claims := platformCapabilityClaims(resolved, capabilityID, intentID, input)
	return h.executor.Execute(r.Context(), claims, capabilityID, input)
}

// writeExecuteFailure maps an executor error or refusal to the platform
// response contract and reports whether the caller may continue.
func (h *platformCollectionHandler) writeExecuteFailure(w http.ResponseWriter, result capability.Result, err error, capabilityID string) bool {
	if err != nil {
		switch {
		case errors.Is(err, errPlatformUnavailable):
			h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			h.refusal(w, http.StatusForbidden, h.forbidden)
		default:
			h.fail(w, err)
		}
		return false
	}
	if result.PendingApproval {
		body := map[string]any{"ok": false, "pendingApproval": true, "reason": "Approval required."}
		if result.Error != "" {
			body["reason"] = result.Error
		}
		if result.ApprovalID != "" {
			body["approvalId"] = result.ApprovalID
		}
		writeJSON(w, http.StatusAccepted, body)
		return false
	}
	if !result.OK {
		switch {
		case strings.HasPrefix(result.Error, "forbidden:"):
			h.refusal(w, http.StatusForbidden, h.forbidden)
		case strings.Contains(result.Error, "is disabled for this organization"):
			h.refusal(w, http.StatusNotFound, "not found")
		default:
			if h.refusal422 != nil {
				h.refusal422(w, capabilityID, result.Error)
			} else {
				h.refusal(w, http.StatusUnprocessableEntity, result.Error)
			}
		}
		return false
	}
	return true
}

// refusal writes the platform error body, adding ok:false for the routes whose
// legacy contract used the marketplace and evolution envelope.
func (h *platformCollectionHandler) refusal(w http.ResponseWriter, status int, message string) {
	body := map[string]any{"error": message}
	if h.refusalOK {
		body["ok"] = false
	}
	writeJSON(w, status, body)
}

func (h *platformCollectionHandler) fail(w http.ResponseWriter, err error) {
	h.logger.Error("platform route failed", "route", h.unavailable, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func platformCapabilityClaims(resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: capabilityID, InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

// decodePlatformBody reads one bounded JSON object, matching the legacy zod
// objects that strip unknown keys rather than rejecting them. The caller
// supplies the refusal message because the ai-connections contract names the
// request while the platform routes say "invalid body".
func decodePlatformBody(w http.ResponseWriter, r *http.Request, limit int64, invalidMessage string) (map[string]json.RawMessage, bool) {
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": invalidMessage})
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": invalidMessage})
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": invalidMessage})
		return nil, false
	}
	return fields, true
}

// optionalPlatformIntent extracts the optional intentId the marketplace and
// evolution schemas accepted, returning an empty string when absent.
func optionalPlatformIntent(fields map[string]json.RawMessage) (string, error) {
	raw, ok := fields["intentId"]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var intent string
	if err := json.Unmarshal(raw, &intent); err != nil {
		return "", errors.New("invalid intentId")
	}
	intent = strings.TrimSpace(intent)
	if intent == "" || utf8.RuneCountInString(intent) > 200 || strings.ContainsAny(intent, "\r\n\x00") {
		return "", errors.New("invalid intentId")
	}
	return intent, nil
}
