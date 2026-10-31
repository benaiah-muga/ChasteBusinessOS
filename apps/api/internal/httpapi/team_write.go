package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract"
	businesscontract "github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract/business"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const teamWriteBodyLimit = 64 << 10

var teamRoleKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
var teamEmailPattern = regexp.MustCompile(`^[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$`)

type TeamWriteHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewTeamWriteHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &TeamWriteHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *TeamWriteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "team service unavailable"})
		return
	}

	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, teamWriteBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var body businesscontract.TeamWriteRequest
	if decoder.Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, capabilityID, input, valid := parseTeamWrite(body)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	claims := projectsSessionClaims(resolved, intentID, input)
	claims.CapabilityID = capabilityID
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		h.writeExecutionError(w, err)
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, businesscontract.TeamWritePending{
			Ok:              businesscontract.TeamWritePendingOkFalse,
			PendingApproval: businesscontract.TeamWritePendingPendingApprovalTrue,
			Reason:          reason,
		})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, businesscontract.TeamWriteFailure{
			Ok: businesscontract.TeamWriteFailureOkFalse, Error: result.Error,
		})
		return
	}
	if !validTeamWriteOutput(capabilityID, result.Data) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "team service unavailable; check team status before retrying"})
		return
	}
	writeJSON(w, http.StatusOK, businesscontract.TeamWriteSuccess{
		Ok: businesscontract.TeamWriteSuccessOkTrue, Data: apicontract.RawJSON(result.Data),
	})
}

func (h *TeamWriteHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err == nil
}

func (h *TeamWriteHandler) writeExecutionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		var domainError capability.IAMDomainError
		if errors.As(err, &domainError) {
			writeJSON(w, http.StatusUnprocessableEntity, businesscontract.TeamWriteFailure{
				Ok: businesscontract.TeamWriteFailureOkFalse, Error: domainError.Error(),
			})
			return
		}
		h.logger.Error("Go team capability execution failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func parseTeamWrite(body businesscontract.TeamWriteRequest) (intentID, capabilityID string, input json.RawMessage, valid bool) {
	action := body.Action
	if action == "" {
		return "", "", nil, false
	}
	intentID = body.IntentId
	if !validTeamIntentID(intentID) {
		return "", "", nil, false
	}
	var payload any
	switch action {
	case "createRole":
		var key, name string
		if !readTeamString(teamRawValue(body.Key), &key) || !teamRoleKeyPattern.MatchString(key) || !readTeamString(teamRawValue(body.Name), &name) || len(utf16.Encode([]rune(name))) > 60 {
			return "", "", nil, false
		}
		payload = struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		}{key, name}
		capabilityID = "iam.createRole"
	case "setPermissions":
		var roleID string
		var permissions []string
		if !readTeamString(teamRawValue(body.RoleId), &roleID) || !readTeamStringArray(teamRawValue(body.Permissions), &permissions) || len(permissions) > 200 {
			return "", "", nil, false
		}
		for _, permission := range permissions {
			if permission == "" {
				return "", "", nil, false
			}
		}
		payload = struct {
			RoleID      string   `json:"roleId"`
			Permissions []string `json:"permissions"`
		}{roleID, permissions}
		capabilityID = "iam.updateRolePermissions"
	case "assignRole":
		var userID, roleID string
		if !readTeamString(teamRawValue(body.UserId), &userID) || !readTeamString(teamRawValue(body.RoleId), &roleID) {
			return "", "", nil, false
		}
		payload = struct {
			UserID string `json:"userId"`
			RoleID string `json:"roleId"`
		}{userID, roleID}
		capabilityID = "iam.assignRole"
	case "invite":
		var email, roleID string
		if !readTeamString(teamRawValue(body.Email), &email) || !validTeamEmail(email) || !readTeamString(teamRawValue(body.RoleId), &roleID) {
			return "", "", nil, false
		}
		payload = struct {
			Email  string `json:"email"`
			RoleID string `json:"roleId"`
		}{email, roleID}
		capabilityID = "iam.inviteMember"
	default:
		return "", "", nil, false
	}
	input, err := json.Marshal(payload)
	if err != nil {
		return "", "", nil, false
	}
	return intentID, capabilityID, input, true
}

func teamRawValue(raw *json.RawMessage) json.RawMessage {
	if raw == nil {
		return nil
	}
	return *raw
}

func validTeamIntentID(value string) bool {
	return strings.TrimFunc(value, isECMAScriptWhitespace) != "" && len(utf16.Encode([]rune(value))) <= 200 && !strings.ContainsAny(value, "\r\n\x00")
}

func isECMAScriptWhitespace(value rune) bool {
	switch {
	case value >= '\u0009' && value <= '\u000D':
		return true
	case value == '\u0020' || value == '\u00A0' || value == '\u1680' || value == '\u2028' || value == '\u2029' || value == '\u202F' || value == '\u205F' || value == '\u3000' || value == '\uFEFF':
		return true
	case value >= '\u2000' && value <= '\u200A':
		return true
	default:
		return false
	}
}

func readTeamString(raw json.RawMessage, destination *string) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, destination) != nil {
		return false
	}
	return *destination != ""
}

func readTeamStringArray(raw json.RawMessage, destination *[]string) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && raw[0] == '[' && json.Unmarshal(raw, destination) == nil
}

func validTeamEmail(value string) bool {
	local, _, found := strings.Cut(value, "@")
	return found && local != "" && !strings.HasPrefix(local, ".") && !strings.Contains(local, "..") && teamEmailPattern.MatchString(value)
}

func validTeamWriteOutput(capabilityID string, raw json.RawMessage) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	switch capabilityID {
	case "iam.createRole":
		var output struct {
			RoleID string `json:"roleId"`
		}
		return decoder.Decode(&output) == nil && isUUID(output.RoleID) && decoder.Decode(new(any)) == io.EOF
	case "iam.updateRolePermissions":
		var output struct {
			PermissionCount *int `json:"permissionCount"`
		}
		return decoder.Decode(&output) == nil && output.PermissionCount != nil && *output.PermissionCount >= 0 && decoder.Decode(new(any)) == io.EOF
	case "iam.assignRole":
		var output struct {
			Assigned *bool `json:"assigned"`
		}
		return decoder.Decode(&output) == nil && output.Assigned != nil && decoder.Decode(new(any)) == io.EOF
	case "iam.inviteMember":
		var output struct {
			InvitationID string `json:"invitationId"`
			Token        string `json:"token"`
			ExpiresAt    string `json:"expiresAt"`
		}
		if decoder.Decode(&output) != nil || !isUUID(output.InvitationID) || output.Token == "" || decoder.Decode(new(any)) != io.EOF {
			return false
		}
		_, err := time.Parse(time.RFC3339, output.ExpiresAt)
		return err == nil
	default:
		return false
	}
}
