package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const ProjectsReadAudience = "go.projects.read"

type goProjectsReadAssertionClaims struct {
	Audience       string   `json:"aud"`
	Subject        string   `json:"sub"`
	OrganizationID string   `json:"org_id"`
	CapabilityID   string   `json:"capability_id"`
	InputSHA256    string   `json:"input_sha256"`
	ActorID        *string  `json:"actor_id"`
	ActorType      string   `json:"actor_type"`
	Permissions    []string `json:"permissions"`
	AuthSessionID  string   `json:"auth_session_id"`
	IssuedAt       int64    `json:"iat"`
	ExpiresAt      int64    `json:"exp"`
}

type ProjectsCollectionReader interface {
	ReadProjectCollection(context.Context, authbridge.CapabilityClaims, json.RawMessage) (capability.Result, error)
}

type GoProjectsReadHandler struct {
	secret   string
	executor CapabilityExecutor
	logger   *slog.Logger
}

func NewGoProjectsReadHandler(secret string, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &GoProjectsReadHandler{secret: secret, executor: executor, logger: logger}
}

func (h *GoProjectsReadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects service unavailable"})
		return
	}

	capabilityID, input, err := projectsReadRequest(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	claims, err := verifyProjectsReadAssertion(h.secret, r.Header.Get(sessionAssertionHeader), time.Now())
	if err != nil || claims.CapabilityID != capabilityID {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	inputHash, err := capability.InputHash(input)
	if err != nil || inputHash != claims.InputSHA256 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	capabilityClaims := authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        claims.Subject,
		OrganizationID: claims.OrganizationID,
		CapabilityID:   claims.CapabilityID,
		InputSHA256:    claims.InputSHA256,
		ActorID:        claims.ActorID,
		ActorType:      claims.ActorType,
		Permissions:    claims.Permissions,
		AuthSessionID:  claims.AuthSessionID,
		IssuedAt:       claims.IssuedAt,
		ExpiresAt:      claims.ExpiresAt,
	}

	var result capability.Result
	if capabilityID == capability.ProjectCollectionReadOperationID {
		reader, ok := h.executor.(ProjectsCollectionReader)
		if !ok {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects service unavailable"})
			return
		}
		result, err = reader.ReadProjectCollection(r.Context(), capabilityClaims, input)
	} else {
		result, err = h.executor.Execute(r.Context(), capabilityClaims, capabilityID, input)
	}
	if err != nil {
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		if h.logger != nil {
			h.logger.Error("Go Projects read failed", "operation", capabilityID, "error", err)
		}
		if capabilityID == capability.ProjectCollectionReadOperationID {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		} else {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		}
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(result.Error, "forbidden: missing permission:") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		if h.logger != nil {
			h.logger.Error("Go Projects read returned invalid JSON", "operation", capabilityID)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func projectsReadRequest(query url.Values) (string, json.RawMessage, error) {
	for key := range query {
		if key != "projectId" {
			return "", nil, errors.New("unsupported query")
		}
	}
	projectIDs, present := query["projectId"]
	if !present || (len(projectIDs) == 1 && projectIDs[0] == "") {
		return capability.ProjectCollectionReadOperationID, json.RawMessage(`{}`), nil
	}
	if len(projectIDs) != 1 {
		return "", nil, errors.New("ambiguous project id")
	}
	input, err := json.Marshal(struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: projectIDs[0]})
	return capability.ProjectBoardReadCapabilityID, input, err
}

func verifyProjectsReadAssertion(secret, token string, now time.Time) (goProjectsReadAssertionClaims, error) {
	var claims goProjectsReadAssertionClaims
	verified, err := authbridge.Verify(secret, token, ProjectsReadAudience, now)
	if err != nil {
		return claims, err
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, authbridge.ErrInvalidAssertion
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return goProjectsReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	if claims.Audience != verified.Audience || claims.Subject != verified.Subject || claims.OrganizationID != verified.OrganizationID ||
		!isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil ||
		!isUUID(*claims.ActorID) || *claims.ActorID != claims.Subject || claims.ActorType != "human" ||
		strings.TrimSpace(claims.AuthSessionID) == "" || claims.ExpiresAt-claims.IssuedAt > 30 ||
		(claims.CapabilityID != capability.ProjectBoardReadCapabilityID && claims.CapabilityID != capability.ProjectCollectionReadOperationID) {
		return goProjectsReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	if claims.Permissions == nil || !sort.StringsAreSorted(claims.Permissions) {
		return goProjectsReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	for i, permission := range claims.Permissions {
		if strings.TrimSpace(permission) == "" || (i > 0 && claims.Permissions[i-1] == permission) {
			return goProjectsReadAssertionClaims{}, authbridge.ErrInvalidAssertion
		}
	}
	digest, err := hex.DecodeString(claims.InputSHA256)
	if err != nil || len(digest) != 32 || strings.ToLower(claims.InputSHA256) != claims.InputSHA256 {
		return goProjectsReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	return claims, nil
}
