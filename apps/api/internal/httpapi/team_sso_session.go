package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const teamSSOBodyLimit = 1 << 20

var ssoDomainLabelPattern = regexp.MustCompile(`(?i)^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

type teamSSOSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type teamSSOConnection struct {
	ID          string    `json:"id"`
	Protocol    string    `json:"protocol"`
	Label       string    `json:"label"`
	IDPEntityID string    `json:"idpEntityId"`
	SSOURL      string    `json:"ssoUrl"`
	Domain      *string   `json:"domain"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"createdAt"`
}

type teamSSORepository interface {
	List(context.Context, string) ([]teamSSOConnection, error)
}

type teamSSOCreateInput struct {
	IntentID       json.RawMessage `json:"intentId"`
	Protocol       string          `json:"protocol"`
	Label          string          `json:"label"`
	IDPEntityID    string          `json:"idpEntityId"`
	SSOURL         string          `json:"ssoUrl"`
	IDPCertificate *string         `json:"idpCertificate"`
	Domain         *string         `json:"domain"`
}

type teamSSODisableInput struct {
	IntentID     json.RawMessage `json:"intentId"`
	ConnectionID string          `json:"connectionId"`
}

type TeamSSOSessionHandler struct {
	resolver          teamSSOSessionResolver
	executor          CapabilityExecutor
	repository        teamSSORepository
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewGoTeamSSOHandler(pool *pgxpool.Pool, resolver teamSSOSessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	if logger == nil {
		logger = slog.Default()
	}
	h := &TeamSSOSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
	if pool != nil {
		h.repository = postgresTeamSSORepository{pool: pool}
	}
	return h
}

func (h *TeamSSOSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.repository == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SSO service unavailable"})
		return
	}
	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !resolved.HasPermission("iam.admin") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "requires iam.admin permission"})
		return
	}
	if r.Method != http.MethodGet && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.list(w, r, *resolved.OrgID)
	case http.MethodPost:
		h.create(w, r, resolved)
	case http.MethodDelete:
		h.disable(w, r, resolved)
	}
}

func (h *TeamSSOSessionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err == nil
}

func (h *TeamSSOSessionHandler) list(w http.ResponseWriter, r *http.Request, orgID string) {
	connections, err := h.repository.List(r.Context(), orgID)
	if err != nil {
		h.unavailable(w, "list SSO connections", err)
		return
	}
	if connections == nil {
		connections = []teamSSOConnection{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": connections})
}

func (h *TeamSSOSessionHandler) create(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, teamSSOBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input teamSSOCreateInput
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := validateTeamSSOCreateInput(input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	intentID, valid := parseProjectIntentID(input.IntentID)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId required"})
		return
	}
	input.Label = strings.TrimSpace(input.Label)
	input.IDPEntityID = strings.TrimSpace(input.IDPEntityID)
	input.SSOURL = strings.TrimSpace(input.SSOURL)
	input.Domain = normalizedSSODomain(input.Domain)
	capabilityInput, err := json.Marshal(struct {
		Protocol       string  `json:"protocol"`
		Label          string  `json:"label"`
		IDPEntityID    string  `json:"idpEntityId"`
		SSOURL         string  `json:"ssoUrl"`
		IDPCertificate *string `json:"idpCertificate"`
		Domain         *string `json:"domain"`
	}{input.Protocol, input.Label, input.IDPEntityID, input.SSOURL, input.IDPCertificate, input.Domain})
	if err != nil {
		h.unavailable(w, "encode SSO capability input", err)
		return
	}
	h.execute(w, r, resolved, intentID, capabilityInput, capability.IAMCreateSSOConnectionCapabilityID)
}

func (h *TeamSSOSessionHandler) disable(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, teamSSOBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body teamSSODisableInput
	if decoder.Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, valid := parseProjectIntentID(body.IntentID)
	if !valid || !isUUID(strings.TrimSpace(body.ConnectionID)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId and connectionId required"})
		return
	}
	input, err := json.Marshal(map[string]string{"connectionId": strings.TrimSpace(body.ConnectionID)})
	if err != nil {
		h.unavailable(w, "encode SSO capability input", err)
		return
	}
	h.execute(w, r, resolved, intentID, input, capability.IAMDisableSSOConnectionCapabilityID)
}

func (h *TeamSSOSessionHandler) execute(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, intentID string, input json.RawMessage, capabilityID string) {
	claims := projectsSessionClaims(resolved, intentID, input)
	claims.CapabilityID = capabilityID
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrNotMember) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		var domainErr capability.IAMDomainError
		if errors.As(err, &domainErr) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": domainErr.Error()})
			return
		}
		h.unavailable(w, "execute SSO capability", err)
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason, "approvalId": result.ApprovalID})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

func (h *TeamSSOSessionHandler) unavailable(w http.ResponseWriter, operation string, err error) {
	h.logger.Error("Go SSO connection management failed", "operation", operation, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func validateTeamSSOCreateInput(input teamSSOCreateInput) error {
	input.Label = strings.TrimSpace(input.Label)
	input.IDPEntityID = strings.TrimSpace(input.IDPEntityID)
	input.SSOURL = strings.TrimSpace(input.SSOURL)
	if input.Protocol != "saml" && input.Protocol != "oidc" {
		return errors.New("protocol must be saml or oidc")
	}
	if input.Label == "" || len(utf16.Encode([]rune(input.Label))) > 200 || strings.ContainsAny(input.Label, "\r\n\x00") ||
		input.IDPEntityID == "" || len(input.IDPEntityID) > 2048 || strings.ContainsAny(input.IDPEntityID, "\r\n\x00") || input.SSOURL == "" {
		return errors.New("label, idpEntityId and ssoUrl required")
	}
	parsed, err := url.ParseRequestURI(input.SSOURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("ssoUrl must be an absolute http or https URL without credentials")
	}
	if input.IDPCertificate != nil {
		certificate := strings.TrimSpace(*input.IDPCertificate)
		if certificate == "" || len(certificate) > 64*1024 {
			return errors.New("idpCertificate must contain at most 65536 characters")
		}
	}
	if input.Domain != nil {
		domain := strings.TrimSpace(*input.Domain)
		if domain != "" && !validSSODomain(domain) {
			return errors.New("domain must be a bare hostname")
		}
	}
	return nil
}

func validSSODomain(domain string) bool {
	if len(domain) > 253 || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if !ssoDomainLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}

type postgresTeamSSORepository struct {
	pool *pgxpool.Pool
}

func (repo postgresTeamSSORepository) List(ctx context.Context, orgID string) ([]teamSSOConnection, error) {
	return dbx.WithOrgTx(ctx, repo.pool, orgID, func(tx pgx.Tx) ([]teamSSOConnection, error) {
		rows, err := tx.Query(ctx, `
			SELECT id::text, protocol, label, idp_entity_id, sso_url, domain, status, created_at
			FROM sso_connections
			WHERE org_id = $1::uuid
			ORDER BY created_at DESC, id`, orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		connections := make([]teamSSOConnection, 0)
		for rows.Next() {
			var connection teamSSOConnection
			if err := rows.Scan(&connection.ID, &connection.Protocol, &connection.Label, &connection.IDPEntityID, &connection.SSOURL, &connection.Domain, &connection.Status, &connection.CreatedAt); err != nil {
				return nil, err
			}
			connections = append(connections, connection)
		}
		return connections, rows.Err()
	})
}

func normalizedSSODomain(domain *string) *string {
	if domain == nil {
		return nil
	}
	value := strings.ToLower(strings.Trim(strings.TrimSpace(*domain), "."))
	if value == "" {
		return nil
	}
	return &value
}
