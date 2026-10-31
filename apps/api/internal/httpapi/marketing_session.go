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
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const marketingSessionBodyLimit = 32 << 10

type MarketingSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewMarketingSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &MarketingSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *MarketingSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "marketing service unavailable"})
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

func (h *MarketingSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if !resolved.HasPermission("marketing.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing permission: marketing.read"})
		return
	}
	intentID, err := newEmailIntentID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	result, err := h.execute(r.Context(), resolved, "marketing.overviewSnapshot", json.RawMessage(`{}`), intentID)
	if h.writeExecutionError(w, "marketing.overviewSnapshot", result, err) {
		return
	}
	var output capability.MarketingOverviewSnapshotOutput
	if !validMarketingSnapshot(result.Data, &output) {
		h.logInvalidOutput("marketing.overviewSnapshot")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, output)
}

func (h *MarketingSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, marketingSessionBodyLimit)
	decoder := json.NewDecoder(r.Body)
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
	action, actionOK := marketingJSONString(fields["action"])
	intentID, intentOK := marketingJSONString(fields["intentId"])
	if !actionOK || !intentOK || strings.TrimSpace(intentID) == "" || len(utf16.Encode([]rune(intentID))) > 160 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	capabilityID, allowed, permission, err := marketingAction(action)
	if err != nil {
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
	if _, err := parseMarketingInput(capabilityID, input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing permission: " + permission})
		return
	}
	result, err := h.execute(r.Context(), resolved, capabilityID, input, intentID)
	if err != nil {
		h.writeExecutionError(w, capabilityID, result, err)
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return
	}
	if h.writeExecutionError(w, capabilityID, result, nil) {
		return
	}
	if !validMarketingOutput(action, result.Data) {
		h.logInvalidOutput(capabilityID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

func marketingAction(action string) (string, []string, string, error) {
	switch action {
	case "createSegment":
		return "marketing.createSegment", []string{"action", "intentId", "name", "minSpendMinor"}, "marketing.write", nil
	case "createCampaign":
		return "marketing.createCampaign", []string{"action", "intentId", "segmentId", "name", "subject", "body"}, "marketing.write", nil
	case "sendCampaign":
		return "marketing.sendCampaign", []string{"action", "intentId", "campaignId"}, "marketing.write", nil
	case "campaignAnalytics":
		return "marketing.campaignAnalytics", []string{"action", "intentId", "campaignId"}, "marketing.read", nil
	default:
		return "", nil, "", errors.New("unsupported marketing action")
	}
}

func parseMarketingInput(capabilityID string, input json.RawMessage) (any, error) {
	switch capabilityID {
	case "marketing.createSegment":
		return capability.ParseMarketingCreateSegmentInput(input)
	case "marketing.createCampaign":
		return capability.ParseMarketingCreateCampaignInput(input)
	case "marketing.sendCampaign":
		return capability.ParseMarketingSendCampaignInput(input)
	case "marketing.campaignAnalytics":
		return capability.ParseMarketingCampaignAnalyticsInput(input)
	default:
		return nil, errors.New("unsupported marketing capability")
	}
}

func validMarketingOutput(action string, raw json.RawMessage) bool {
	if !json.Valid(raw) {
		return false
	}
	switch action {
	case "createSegment":
		var output capability.MarketingCreateSegmentOutput
		return marketingExactObject(raw, "segmentId") && json.Unmarshal(raw, &output) == nil && isUUID(output.SegmentID)
	case "createCampaign":
		var output capability.MarketingCreateCampaignOutput
		return marketingExactObject(raw, "campaignId") && json.Unmarshal(raw, &output) == nil && isUUID(output.CampaignID)
	case "sendCampaign":
		var output capability.MarketingSendCampaignOutput
		return marketingExactObject(raw, "recipients", "skippedOptOut", "skippedNoAddress", "alreadySent") && json.Unmarshal(raw, &output) == nil &&
			marketingSafeCount(output.Recipients) && marketingSafeCount(output.SkippedOptOut) && marketingSafeCount(output.SkippedNoAddress) && marketingSafeCount(output.AlreadySent)
	case "campaignAnalytics":
		var output capability.MarketingCampaignAnalyticsOutput
		return marketingExactObject(raw, "campaignName", "sentCount", "queuedAt") && json.Unmarshal(raw, &output) == nil && output.CampaignName != "" && marketingSafeCount(output.SentCount) && marketingNullableTimestamp(output.QueuedAt)
	default:
		return false
	}
}

func validMarketingSnapshot(raw json.RawMessage, output *capability.MarketingOverviewSnapshotOutput) bool {
	if !marketingExactObject(raw, "segments", "campaigns", "sendCounts", "recentSends") || json.Unmarshal(raw, output) != nil ||
		output.Segments == nil || output.Campaigns == nil || output.SendCounts == nil || output.RecentSends == nil ||
		len(output.Segments) > 100 || len(output.Campaigns) > 100 || len(output.RecentSends) > 50 {
		return false
	}
	segments, ok := marketingSnapshotRows(raw, "segments")
	if !ok || len(segments) != len(output.Segments) {
		return false
	}
	for i, row := range output.Segments {
		encoded := segments[i]
		if !marketingExactObject(encoded, "id", "name", "minSpendMinor", "createdAt") || !isUUID(row.ID) || strings.TrimSpace(row.Name) == "" || !marketingSafeCount(row.MinSpendMinor) || !marketingTimestamp(row.CreatedAt) {
			return false
		}
	}
	campaigns, ok := marketingSnapshotRows(raw, "campaigns")
	if !ok || len(campaigns) != len(output.Campaigns) {
		return false
	}
	for i, row := range output.Campaigns {
		encoded := campaigns[i]
		if !marketingExactObject(encoded, "id", "segmentId", "name", "subject", "body", "queuedAt", "createdAt") || !isUUID(row.ID) || !isUUID(row.SegmentID) ||
			strings.TrimSpace(row.Name) == "" || strings.TrimSpace(row.Subject) == "" || strings.TrimSpace(row.Body) == "" || !marketingNullableTimestamp(row.QueuedAt) || !marketingTimestamp(row.CreatedAt) {
			return false
		}
	}
	sendCounts, ok := marketingSnapshotRows(raw, "sendCounts")
	if !ok || len(sendCounts) != len(output.SendCounts) {
		return false
	}
	for i, row := range output.SendCounts {
		encoded := sendCounts[i]
		if !marketingExactObject(encoded, "campaignId", "count") || !isUUID(row.CampaignID) || !marketingSafeCount(row.Count) {
			return false
		}
	}
	recentSends, ok := marketingSnapshotRows(raw, "recentSends")
	if !ok || len(recentSends) != len(output.RecentSends) {
		return false
	}
	for i, row := range output.RecentSends {
		encoded := recentSends[i]
		if !marketingExactObject(encoded, "id", "campaignId", "customerName", "customerEmail", "queuedAt", "status", "sentAt") || !isUUID(row.ID) || !isUUID(row.CampaignID) ||
			strings.TrimSpace(row.CustomerName) == "" || !marketingTimestamp(row.QueuedAt) || !marketingNullableTimestamp(row.SentAt) || row.Status == "" {
			return false
		}
	}
	return true
}

func marketingSnapshotRows(raw json.RawMessage, key string) ([]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return nil, false
	}
	var rows []json.RawMessage
	if json.Unmarshal(object[key], &rows) != nil || rows == nil {
		return nil, false
	}
	return rows, true
}

func marketingExactObject(raw json.RawMessage, wanted ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != len(wanted) {
		return false
	}
	for _, key := range wanted {
		value, ok := fields[key]
		if !ok || len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null")) && key != "queuedAt" && key != "customerEmail" && key != "sentAt" {
			return false
		}
	}
	return true
}

func marketingSafeCount(value int64) bool {
	return value >= 0 && value <= 1<<53-1
}

func marketingTimestamp(value string) bool {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && parsed.Location() == time.UTC && value != ""
}

func marketingNullableTimestamp(value *string) bool {
	return value == nil || marketingTimestamp(*value)
}

func marketingJSONString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func (h *MarketingSessionHandler) execute(ctx context.Context, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
	if resolved == nil || resolved.OrgID == nil || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || strings.TrimSpace(intentID) == "" {
		return capability.Result{}, errors.New("invalid capability identity")
	}
	digest, err := capability.InputHash(input)
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
		CapabilityID: capabilityID, InputSHA256: digest, ActorID: &actorID, ActorType: "human",
		Permissions: permissions, AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	return h.executor.Execute(ctx, claims, capabilityID, input)
}

func (h *MarketingSessionHandler) writeExecutionError(w http.ResponseWriter, capabilityID string, result capability.Result, err error) bool {
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go marketing capability failed", "capability", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return true
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return true
	}
	return false
}

func (h *MarketingSessionHandler) logInvalidOutput(capabilityID string) {
	if h.logger != nil {
		h.logger.Error("Go marketing capability returned invalid data", "capability", capabilityID)
	}
}

var _ DirectCapabilitySessionResolver = (*session.Resolver)(nil)
