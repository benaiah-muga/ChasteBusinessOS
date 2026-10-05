package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type myWorkReader interface {
	ForOrg(context.Context, string, bool) (dashboard.MyWorkData, error)
}

type myWorkSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type MyWorkSessionHandler struct {
	resolver myWorkSessionResolver
	reader   myWorkReader
	executor CapabilityExecutor
	logger   *slog.Logger
	now      func() time.Time
}

type MyWorkCard struct {
	Kind         string  `json:"kind"`
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Detail       string  `json:"detail"`
	WhyItMatters string  `json:"whyItMatters"`
	ActionLabel  string  `json:"actionLabel"`
	ActionHref   string  `json:"actionHref"`
	CreatedAt    *string `json:"createdAt"`
	Rank         int     `json:"rank"`
}

func NewMyWorkSessionHandler(resolver myWorkSessionResolver, reader myWorkReader, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &MyWorkSessionHandler{resolver: resolver, reader: reader, executor: executor, logger: logger, now: time.Now}
}

func (h *MyWorkSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "my work service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	data, err := h.reader.ForOrg(r.Context(), *resolved.OrgID, myWorkHasPermission(resolved, "purchasing.read"))
	if err != nil {
		if h.logger != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.logger.Error("Go my work read failed", "organizationId", *resolved.OrgID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	cards := make([]MyWorkCard, 0, len(data.Approvals)+len(data.Remainders))
	for _, approval := range data.Approvals {
		permission, known := capability.PermissionForCapability(approval.CapabilityID)
		if !known || !myWorkHasPermission(resolved, permission) {
			continue
		}
		detail := approval.RiskClass + " action waiting for a decision"
		if approval.Rationale != nil {
			detail = *approval.Rationale
		}
		createdAt := approval.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		cards = append(cards, MyWorkCard{
			Kind: "approval", ID: approval.ID, Title: "Approval needed: " + approval.CapabilityID,
			Detail: detail, WhyItMatters: "Someone or something asked for a gated action; nothing happens until a human decides.",
			ActionLabel: "Review approval", ActionHref: "/approvals", CreatedAt: &createdAt, Rank: 0,
		})
	}
	for _, remainder := range data.Remainders {
		lines := make([]string, 0, len(remainder.Lines))
		for _, line := range remainder.Lines {
			lines = append(lines, "line "+strconv.FormatInt(line.Position, 10)+" \""+line.Description+"\"")
		}
		cards = append(cards, MyWorkCard{
			Kind: "receipt_remainder", ID: remainder.PurchaseOrderID,
			Title:  "PO " + strconv.FormatInt(remainder.Number, 10) + ": " + dashboard.FormatWorkThousandths(remainder.Remaining) + " still outstanding",
			Detail: strings.Join(lines, ", "), WhyItMatters: "The supplier has not delivered everything ordered; the shortfall is visible and can be chased or closed.",
			ActionLabel: "Open receiving desk", ActionHref: "/purchasing/receiving?poNumber=" + strconv.FormatInt(remainder.Number, 10),
			CreatedAt: nil, Rank: 1,
		})
	}
	if myWorkHasPermission(resolved, "signals.read") {
		cards = append(cards, h.signalCards(r, resolved)...)
	}
	sort.SliceStable(cards, func(i, j int) bool { return cards[i].Rank < cards[j].Rank })
	if len(cards) > 30 {
		cards = cards[:30]
	}
	now := time.Now
	if h.now != nil {
		now = h.now
	}
	generatedAt := now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	writeJSON(w, http.StatusOK, struct {
		Cards       []MyWorkCard `json:"cards"`
		GeneratedAt string       `json:"generatedAt"`
	}{Cards: cards, GeneratedAt: generatedAt})
}

func (h *MyWorkSessionHandler) signalCards(r *http.Request, resolved *session.ResolvedUser) []MyWorkCard {
	input := json.RawMessage(`{}`)
	claims := analyticsSessionClaims(resolved, "signals.list", input)
	claims.Audience = authbridge.CapabilityExecuteAudience
	result, err := h.executor.Execute(r.Context(), claims, "signals.list", input)
	if err != nil || !result.OK || len(result.Data) == 0 || strings.TrimSpace(string(result.Data)) == "null" {
		if err != nil && h.logger != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.logger.Warn("Go my work signal read failed", "error", err)
		}
		return []MyWorkCard{myWorkSignalsUnavailable()}
	}
	var output struct {
		Signals []struct {
			ID      string `json:"id"`
			Module  string `json:"module"`
			Subject string `json:"subject"`
			Detail  string `json:"detail"`
		} `json:"signals"`
	}
	if err := json.Unmarshal(result.Data, &output); err != nil {
		return []MyWorkCard{myWorkSignalsUnavailable()}
	}
	cards := make([]MyWorkCard, 0, len(output.Signals))
	for _, signal := range output.Signals {
		cards = append(cards, MyWorkCard{
			Kind: "signal", ID: signal.ID, Title: signal.Module + ": " + signal.Subject, Detail: signal.Detail,
			WhyItMatters: "A module check flagged this condition; it stays visible until the underlying state changes.",
			ActionLabel:  "Open module", ActionHref: "/" + signal.Module, CreatedAt: nil, Rank: 2,
		})
	}
	return cards
}

func myWorkSignalsUnavailable() MyWorkCard {
	return MyWorkCard{
		Kind: "signal", ID: "signals-unavailable", Title: "Signal checks unavailable",
		Detail:       "The signal sweep could not run right now; this is not a report of zero problems.",
		WhyItMatters: "Coverage must be honest: an unavailable check is visible instead of silently passing.",
		ActionLabel:  "Retry later", ActionHref: "/", CreatedAt: nil, Rank: 3,
	}
}

func myWorkHasPermission(resolved *session.ResolvedUser, permission string) bool {
	return resolved != nil && (resolved.HasPermission("*") || resolved.HasPermission(permission))
}

func (h *MyWorkSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
