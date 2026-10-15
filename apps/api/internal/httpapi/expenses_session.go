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
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const expensesRouteBodyLimit = 64 << 10

type ExpensesSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewExpensesSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &ExpensesSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *ExpensesSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "expenses service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method == http.MethodPost && strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.read(w, r, resolved)
		return
	}
	h.write(w, r, resolved)
}

func (h *ExpensesSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	status := r.URL.Query().Get("status")
	input := json.RawMessage(`{}`)
	if slices.Contains([]string{"submitted", "approved", "rejected", "paid"}, status) {
		input = json.RawMessage(`{"status":"` + status + `"}`)
	}
	claimsResult, err := h.execute(r.Context(), resolved, "accounting.listExpenseClaims", input, "")
	if h.writeExecutionError(w, "accounting.listExpenseClaims", claimsResult, err) {
		return
	}
	policiesResult, err := h.execute(r.Context(), resolved, "accounting.listExpensePolicies", json.RawMessage(`{}`), "")
	if h.writeExecutionError(w, "accounting.listExpensePolicies", policiesResult, err) {
		return
	}
	var claims capability.ListExpenseClaimsOutput
	var policies capability.ListExpensePoliciesOutput
	if !json.Valid(claimsResult.Data) || json.Unmarshal(claimsResult.Data, &claims) != nil || claims.Claims == nil ||
		!json.Valid(policiesResult.Data) || json.Unmarshal(policiesResult.Data, &policies) != nil || policies.Policies == nil {
		h.logInvalidOutput("expenses read")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"claims": claims.Claims, "policies": policies.Policies})
}

func (h *ExpensesSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, expensesRouteBodyLimit))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	if decoder.Decode(&fields) != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	action, actionOK := expensesJSONString(fields["action"])
	intentID, intentOK := expensesJSONString(fields["intentId"])
	if !actionOK || !intentOK || strings.TrimSpace(intentID) == "" || len(intentID) > 160 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	var capabilityID string
	var allowed []string
	switch action {
	case "submit":
		capabilityID = "accounting.submitExpenseClaim"
		allowed = []string{"action", "intentId", "amountMinor", "memo", "accountCode"}
	case "decide":
		capabilityID = "accounting.decideExpenseClaim"
		allowed = []string{"action", "intentId", "claimId", "decision", "reason"}
	case "pay":
		capabilityID = "accounting.payExpenseClaim"
		allowed = []string{"action", "intentId", "claimId", "amountMinor"}
	case "setPolicy":
		capabilityID = "accounting.setExpensePolicy"
		allowed = []string{"action", "intentId", "category", "limitMinor"}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := allowedSet[key]; !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	}
	inputFields := make(map[string]json.RawMessage, len(allowed)-2)
	for _, key := range allowed[2:] {
		if raw, ok := fields[key]; ok {
			inputFields[key] = raw
		}
	}
	input, err := json.Marshal(inputFields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if _, err := parseExpenseInput(capabilityID, input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := h.execute(r.Context(), resolved, capabilityID, input, intentID)
	if h.writeExecutionError(w, capabilityID, result, err) {
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"error": reason, "pendingApproval": true})
		return
	}
	if !validExpenseOutput(action, result.Data) {
		h.logInvalidOutput(capabilityID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

func parseExpenseInput(capabilityID string, input json.RawMessage) (any, error) {
	switch capabilityID {
	case "accounting.submitExpenseClaim":
		return capability.ParseSubmitExpenseClaimInput(input)
	case "accounting.decideExpenseClaim":
		return capability.ParseDecideExpenseClaimInput(input)
	case "accounting.payExpenseClaim":
		return capability.ParsePayExpenseClaimInput(input)
	case "accounting.setExpensePolicy":
		return capability.ParseSetExpensePolicyInput(input)
	default:
		return nil, errors.New("unsupported expense action")
	}
}

func validExpenseOutput(action string, raw json.RawMessage) bool {
	switch action {
	case "submit":
		var output capability.SubmitExpenseClaimOutput
		return decodeExactExpenseOutput(raw, &output, []string{"claimId", "status", "category", "overPolicyLimit", "policyLimitMinor"}, []string{"policyLimitMinor"}) == nil &&
			isUUID(output.ClaimID) && output.Status == "submitted" && output.Category != "" &&
			(output.PolicyLimitMinor == nil || (*output.PolicyLimitMinor >= 0 && *output.PolicyLimitMinor <= posMaxSafeInteger))
	case "decide":
		var output capability.DecideExpenseClaimOutput
		return decodeExactExpenseOutput(raw, &output, []string{"claimId", "status"}, nil) == nil &&
			isUUID(output.ClaimID) && (output.Status == "approved" || output.Status == "rejected")
	case "pay":
		var output capability.PayExpenseClaimOutput
		return decodeExactExpenseOutput(raw, &output, []string{"claimId", "entryId", "paidMinor"}, nil) == nil &&
			isUUID(output.ClaimID) && isUUID(output.EntryID) && output.PaidMinor > 0 && output.PaidMinor <= posMaxSafeInteger
	case "setPolicy":
		var output capability.SetExpensePolicyOutput
		return decodeExactExpenseOutput(raw, &output, []string{"set", "category", "limitMinor"}, nil) == nil &&
			output.Set && output.Category != "" && output.LimitMinor >= 0 && output.LimitMinor <= posMaxSafeInteger
	default:
		return false
	}
}

func decodeExactExpenseOutput(raw json.RawMessage, target any, required, nullable []string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil || len(fields) != len(required) {
		return errors.New("invalid expense output fields")
	}
	nullableFields := make(map[string]struct{}, len(nullable))
	for _, key := range nullable {
		nullableFields[key] = struct{}{}
	}
	for _, key := range required {
		value, ok := fields[key]
		if !ok {
			return errors.New("missing expense output field")
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			if _, ok := nullableFields[key]; !ok {
				return errors.New("null expense output field")
			}
		}
	}
	for key := range fields {
		found := false
		for _, requiredKey := range required {
			if key == requiredKey {
				found = true
				break
			}
		}
		if !found {
			return errors.New("unexpected expense output field")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing expense output")
	}
	return nil
}

func expensesJSONString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func (h *ExpensesSessionHandler) execute(ctx context.Context, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
	inputHash, err := capability.InputHash(input)
	if err != nil {
		return capability.Result{}, err
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
	claims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID,
		ActorType: "human", Permissions: permissions, AuthSessionID: resolved.AuthSessionID,
		IntentID: intentID, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	return h.executor.Execute(ctx, claims, capabilityID, input)
}

func (h *ExpensesSessionHandler) writeExecutionError(w http.ResponseWriter, capabilityID string, result capability.Result, err error) bool {
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go expenses capability failed", "capabilityId", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return true
	}
	if !result.OK && !result.PendingApproval {
		message := result.Error
		if message == "" {
			message = "capability execution failed"
		}
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(message, "forbidden: missing permission:") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": message})
		return true
	}
	return false
}

func (h *ExpensesSessionHandler) logInvalidOutput(capabilityID string) {
	if h.logger != nil {
		h.logger.Error("Go expenses capability returned invalid data", "capabilityId", capabilityID)
	}
}
