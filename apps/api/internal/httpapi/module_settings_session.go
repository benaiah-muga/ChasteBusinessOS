package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const moduleSettingsBodyLimit = 16 << 10

var moduleSettingsIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

type moduleSettingsReader interface {
	ReadModuleSettings(context.Context, string, string) (json.RawMessage, bool, error)
}

type moduleSettingsRow struct {
	settings json.RawMessage
	found    bool
}

type pgModuleSettingsReader struct{ pool *pgxpool.Pool }

func (r pgModuleSettingsReader) ReadModuleSettings(ctx context.Context, orgID, moduleID string) (json.RawMessage, bool, error) {
	if r.pool == nil {
		return nil, false, errors.New("module settings database unavailable")
	}
	row, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (moduleSettingsRow, error) {
		var settings json.RawMessage
		err := tx.QueryRow(ctx, `
			SELECT settings
			FROM module_settings
			WHERE org_id=$1::uuid AND module=$2
			LIMIT 1`, orgID, moduleID).Scan(&settings)
		if errors.Is(err, pgx.ErrNoRows) {
			return moduleSettingsRow{settings: json.RawMessage(`{}`)}, nil
		}
		if err != nil {
			return moduleSettingsRow{}, err
		}
		return moduleSettingsRow{settings: settings, found: true}, nil
	})
	return row.settings, row.found, err
}

type ModuleSettingsSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	reader            moduleSettingsReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewModuleSettingsSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &ModuleSettingsSessionHandler{
		resolver: resolver, executor: executor, reader: pgModuleSettingsReader{pool: pool},
		logger: logger, trustedProxyCIDRs: trusted,
	}
}

func (h *ModuleSettingsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "module settings service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		h.unauthorized(w)
		return
	}
	resolved, bearer, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		h.unauthorized(w)
		return
	}
	if r.Method == http.MethodPost && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.read(w, r, resolved)
		return
	}
	h.write(w, r, resolved)
}

func (h *ModuleSettingsSessionHandler) resolve(r *http.Request, activeOrg string) (*session.ResolvedUser, bool, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err
}

func (h *ModuleSettingsSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	moduleID := r.URL.Query().Get("module")
	if !moduleSettingsIDPattern.MatchString(moduleID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid module"})
		return
	}
	settings, _, err := h.reader.ReadModuleSettings(r.Context(), *resolved.OrgID, moduleID)
	if err != nil {
		h.logger.Error("Go module settings read failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if len(settings) == 0 || string(settings) == "null" {
		settings = json.RawMessage(`{}`)
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(settings, &values); err != nil || values == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	var responseSettings any = values
	if moduleID == "inventory" {
		input, err := json.Marshal(struct {
			Module   string                     `json:"module"`
			Settings map[string]json.RawMessage `json:"settings"`
		}{Module: moduleID, Settings: values})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		parsed, err := capability.ParseIAMSetModuleConfigInput(input)
		if err != nil {
			h.logger.Error("Go module settings row failed its registered schema", "module", moduleID, "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		responseSettings = parsed.Settings
	}
	writeJSON(w, http.StatusOK, map[string]any{"module": moduleID, "settings": responseSettings})
}

func (h *ModuleSettingsSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, moduleSettingsBodyLimit)
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
	var moduleID string
	if json.Unmarshal(fields["module"], &moduleID) != nil || !moduleSettingsIDPattern.MatchString(moduleID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var settings map[string]json.RawMessage
	if json.Unmarshal(fields["settings"], &settings) != nil || settings == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if moduleID != "inventory" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown module: " + moduleID})
		return
	}
	input, err := json.Marshal(struct {
		Module   string                     `json:"module"`
		Settings map[string]json.RawMessage `json:"settings"`
	}{Module: moduleID, Settings: settings})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	parsed, err := capability.ParseIAMSetModuleConfigInput(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid settings: " + err.Error()})
		return
	}
	intentID := ""
	if raw, ok := fields["intentId"]; ok {
		if intentID, ok = parseProjectIntentID(raw); !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	} else {
		intentID, err = newModuleSettingsIntentID()
		if err != nil {
			h.logger.Error("Go module settings intent generation failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	}
	encoded, err := json.Marshal(struct {
		Module   string          `json:"module"`
		Settings json.RawMessage `json:"settings"`
	}{Module: parsed.Module, Settings: parsed.Settings})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	input = json.RawMessage(encoded)
	claims := moduleSettingsSessionClaims(resolved, intentID, input)
	result, err := h.executor.Execute(r.Context(), claims, "iam.setModuleConfig", input)
	if err != nil {
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.logger.Error("Go module settings write failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if result.PendingApproval {
		writeJSON(w, http.StatusAccepted, map[string]any{
			"pendingApproval": true,
			"hint":            "This settings change waits for approval in the Approvals inbox.",
		})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func moduleSettingsSessionClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
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
		OrganizationID: *resolved.OrgID, CapabilityID: "iam.setModuleConfig", InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func newModuleSettingsIntentID() (string, error) {
	var uuid [16]byte
	if _, err := rand.Read(uuid[:]); err != nil {
		return "", err
	}
	uuid[6] = (uuid[6] & 0x0f) | 0x40
	uuid[8] = (uuid[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(uuid[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func (h *ModuleSettingsSessionHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}
