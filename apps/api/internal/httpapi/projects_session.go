package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const projectRouteBodyLimit = 64 << 10

var projectRouteUUID = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

type ProjectsSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	collectionReader  ProjectsCollectionReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type projectRouteBody struct {
	Action         string          `json:"action"`
	IntentID       json.RawMessage `json:"intentId"`
	Name           string          `json:"name"`
	DueAt          json.RawMessage `json:"dueAt"`
	ProjectID      string          `json:"projectId"`
	Title          string          `json:"title"`
	ParentTaskID   json.RawMessage `json:"parentTaskId"`
	AssigneeUserID json.RawMessage `json:"assigneeUserId"`
	Priority       json.RawMessage `json:"priority"`
	TaskID         string          `json:"taskId"`
	Status         string          `json:"status"`
	Position       json.RawMessage `json:"position"`
}

func NewProjectsSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, collectionReader ProjectsCollectionReader, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &ProjectsSessionHandler{resolver: resolver, executor: executor, collectionReader: collectionReader, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *ProjectsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h.resolver == nil || h.executor == nil || h.collectionReader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects service unavailable"})
		return
	}
	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if r.Method == http.MethodGet && !resolved.HasPermission("projects.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing projects.read"})
		return
	}
	if r.Method == http.MethodGet {
		h.serveRead(w, r, resolved)
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	h.serveWrite(w, r, resolved)
}

func (h *ProjectsSessionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err == nil
}

func (h *ProjectsSessionHandler) serveRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	query := r.URL.Query()
	projectID := query.Get("projectId")
	claims := projectsSessionClaims(resolved, "", json.RawMessage(`{}`))
	var result capability.Result
	var err error
	if projectID == "" {
		claims.CapabilityID = capability.ProjectCollectionReadOperationID
		result, err = h.collectionReader.ReadProjectCollection(r.Context(), claims, json.RawMessage(`{}`))
	} else {
		input, marshalErr := json.Marshal(struct {
			ProjectID string `json:"projectId"`
		}{ProjectID: projectID})
		if marshalErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		claims.CapabilityID = capability.ProjectBoardReadCapabilityID
		claims.InputSHA256, _ = capability.InputHash(input)
		result, err = h.executor.Execute(r.Context(), claims, claims.CapabilityID, input)
	}
	if err != nil {
		h.writeProjectsExecutionError(w, err)
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(result.Error, "forbidden:") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func (h *ProjectsSessionHandler) serveWrite(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, projectRouteBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var body projectRouteBody
	if decoder.Decode(&body) != nil {
		writeProjectInvalidBody(w)
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeProjectInvalidBody(w)
		return
	}
	capabilityID, input, valid := parseProjectWrite(body)
	if !valid {
		writeProjectInvalidBody(w)
		return
	}
	intentID, valid := parseProjectIntentID(body.IntentID)
	if !valid {
		writeProjectInvalidBody(w)
		return
	}
	claims := projectsSessionClaims(resolved, intentID, input)
	claims.CapabilityID = capabilityID
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		h.writeProjectsExecutionError(w, err)
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, struct {
			OK              bool   `json:"ok"`
			PendingApproval bool   `json:"pendingApproval"`
			Reason          string `json:"reason"`
			ApprovalID      string `json:"approvalId,omitempty"`
		}{OK: false, PendingApproval: true, Reason: reason, ApprovalID: result.ApprovalID})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}{OK: false, Error: result.Error})
		return
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func parseProjectIntentID(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var intentID string
	if err := json.Unmarshal(raw, &intentID); err != nil || strings.TrimSpace(intentID) == "" || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		return "", false
	}
	return intentID, true
}

func projectsSessionClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
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
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		InputSHA256: inputHash, ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func parseProjectWrite(body projectRouteBody) (string, json.RawMessage, bool) {
	input := make(map[string]any)
	capabilityID := ""
	switch body.Action {
	case "createProject":
		dueAt, valid := projectOptionalString(body.DueAt)
		if projectRouteStringLength(body.Name) < 1 || projectRouteStringLength(body.Name) > 120 || !valid || !validOptionalDate(dueAt) {
			return "", nil, false
		}
		capabilityID = "projects.createProject"
		input["name"] = body.Name
		addOptional(input, "dueAt", dueAt)
	case "createTask":
		parentTaskID, parentValid := projectOptionalString(body.ParentTaskID)
		assigneeUserID, assigneeValid := projectOptionalString(body.AssigneeUserID)
		dueAt, dueValid := projectOptionalString(body.DueAt)
		priority, priorityValid := projectOptionalString(body.Priority)
		if !projectRouteUUID.MatchString(body.ProjectID) || projectRouteStringLength(body.Title) < 1 || projectRouteStringLength(body.Title) > 200 || !parentValid || !assigneeValid || !dueValid || !priorityValid || !validOptionalUUID(parentTaskID) || !validOptionalUUID(assigneeUserID) || !validOptionalDate(dueAt) || !validOptionalChoice(priority, "low", "medium", "high") {
			return "", nil, false
		}
		capabilityID = "projects.createTask"
		input["projectId"], input["title"] = body.ProjectID, body.Title
		addOptional(input, "parentTaskId", parentTaskID)
		addOptional(input, "assigneeUserId", assigneeUserID)
		addOptional(input, "dueAt", dueAt)
		addOptional(input, "priority", priority)
	case "assignTask":
		assigneeUserID, valid := projectOptionalString(body.AssigneeUserID)
		if !projectRouteUUID.MatchString(body.TaskID) || !valid || !validOptionalUUID(assigneeUserID) {
			return "", nil, false
		}
		capabilityID = "projects.assignTask"
		input["taskId"] = body.TaskID
		addOptional(input, "assigneeUserId", assigneeUserID)
	case "moveTask":
		if !projectRouteUUID.MatchString(body.TaskID) || !oneOf(body.Status, "todo", "doing", "done") {
			return "", nil, false
		}
		capabilityID = "projects.moveTask"
		input["taskId"], input["status"] = body.TaskID, body.Status
		if len(body.Position) > 0 {
			var position float64
			if strings.TrimSpace(string(body.Position)) == "null" || json.Unmarshal(body.Position, &position) != nil || math.IsNaN(position) || math.IsInf(position, 0) || position < 0 || math.Trunc(position) != position {
				return "", nil, false
			}
			input["position"] = position
		}
	case "archiveProject":
		if !projectRouteUUID.MatchString(body.ProjectID) {
			return "", nil, false
		}
		capabilityID = "projects.archiveProject"
		input["projectId"] = body.ProjectID
	default:
		return "", nil, false
	}
	raw, err := json.Marshal(input)
	return capabilityID, raw, err == nil
}

func projectOptionalString(raw json.RawMessage) (*string, bool) {
	if len(raw) == 0 {
		return nil, true
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return nil, false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return &value, true
}

func projectRouteStringLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func validOptionalUUID(value *string) bool {
	return value == nil || projectRouteUUID.MatchString(*value)
}

func validOptionalDate(value *string) bool {
	if value == nil {
		return true
	}
	if !strings.HasSuffix(*value, "Z") {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		parsed, err = time.Parse("2006-01-02T15:04Z07:00", *value)
	}
	return err == nil && !parsed.IsZero()
}

func addOptional(input map[string]any, key string, value *string) {
	if value != nil {
		input[key] = *value
	}
}

func validOptionalChoice(value *string, allowed ...string) bool {
	return value == nil || oneOf(*value, allowed...)
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func writeProjectInvalidBody(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body", "detail": []any{}})
}

func (h *ProjectsSessionHandler) writeProjectsExecutionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		if h.logger != nil {
			h.logger.Error("Go Projects execution failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}
