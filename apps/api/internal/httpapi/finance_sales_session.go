package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const financeSalesBodyLimit = 64 << 10

const financeSalesMaxSafeInteger int64 = 9_007_199_254_740_991

// financeSalesResolveSession enforces the shared identity rules for the ported
// finance and sales routes: verified session cookie or bearer token, a valid
// organization selector, and a user whose resolved organization matches it.
func financeSalesResolveSession(w http.ResponseWriter, r *http.Request, resolver DirectCapabilitySessionResolver) (*session.ResolvedUser, bool) {
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return nil, false
	}
	resolved, err := resolveDirectCapabilitySession(r, resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return nil, false
	}
	return resolved, true
}

// financeSalesAuthorize pre-checks the module and permission before the
// capability kernel runs, so a denied request never reaches the executor.
func financeSalesAuthorize(resolved *session.ResolvedUser, module, permission string) (int, string) {
	if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
		return http.StatusForbidden, "forbidden: missing " + permission
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, module) {
		return http.StatusForbidden, module + " module is disabled"
	}
	return 0, ""
}

func financeSalesDecodeFields(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, financeSalesBodyLimit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	if decoder.Decode(&fields) != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	return fields, true
}

func financeSalesAction(fields map[string]json.RawMessage) (string, bool) {
	var action string
	raw, exists := fields["action"]
	if !exists || json.Unmarshal(raw, &action) != nil || strings.TrimSpace(action) == "" {
		return "", false
	}
	return action, true
}

// financeSalesIntentID keeps the legacy contract where intentId is optional:
// when a client omits it, a fresh UUID is generated so the write still lands a
// governed receipt instead of an ungoverned one.
func financeSalesIntentID(fields map[string]json.RawMessage) (string, error) {
	raw, exists := fields["intentId"]
	if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return newFinanceSalesIntentID()
	}
	var intentID string
	if json.Unmarshal(raw, &intentID) != nil || strings.TrimSpace(intentID) == "" ||
		len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		return "", errors.New("invalid intentId")
	}
	return intentID, nil
}

func newFinanceSalesIntentID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func financeSalesRejectUnknownFields(fields map[string]json.RawMessage, allowed ...string) error {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := allowedSet[key]; !ok {
			return fmt.Errorf("unexpected request field %q", key)
		}
	}
	return nil
}

// financeSalesInput copies only the named fields, dropping explicit nulls so
// the capability parsers apply their own defaults for absent optionals.
func financeSalesInput(fields map[string]json.RawMessage, keys ...string) (json.RawMessage, error) {
	input := make(map[string]json.RawMessage, len(keys))
	for _, key := range keys {
		raw, exists := fields[key]
		if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			continue
		}
		input[key] = raw
	}
	return json.Marshal(input)
}

func financeSalesClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (authbridge.CapabilityClaims, error) {
	inputHash, err := capability.InputHash(input)
	if err != nil {
		return authbridge.CapabilityClaims{}, err
	}
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: capabilityID, InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}, nil
}

// financeSalesRun executes one capability and maps only transport-level
// failures. Result-level refusals are returned to the caller so each route can
// apply its own legacy envelope.
func financeSalesRun(w http.ResponseWriter, r *http.Request, executor CapabilityExecutor, logger *slog.Logger, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, bool) {
	claims, err := financeSalesClaims(resolved, capabilityID, input, intentID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return capability.Result{}, false
	}
	result, err := executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if status, ok := capabilityErrorStatus(err); ok {
				writeJSON(w, status, map[string]string{"error": err.Error()})
				return capability.Result{}, false
			}
			if logger != nil {
				logger.Error("Go finance capability execution failed", "capabilityId", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return capability.Result{}, false
	}
	return result, true
}

func financeSalesRefusalStatus(result capability.Result) int {
	if strings.HasPrefix(result.Error, "forbidden: missing permission:") {
		return http.StatusForbidden
	}
	return http.StatusUnprocessableEntity
}

func financeSalesPendingApproval(w http.ResponseWriter, result capability.Result) {
	reason := result.ApprovalRationale
	if reason == "" {
		reason = result.Error
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
}

func financeSalesWriteOK(w http.ResponseWriter, data json.RawMessage) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(data)})
}

func financeSalesInternalError(w http.ResponseWriter, logger *slog.Logger, message string) {
	if logger != nil {
		logger.Error(message)
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func financeSalesDecodeOutput(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing capability output")
	}
	return nil
}

func financeSalesCount(value int64) bool {
	return value >= 0 && value <= financeSalesMaxSafeInteger
}
