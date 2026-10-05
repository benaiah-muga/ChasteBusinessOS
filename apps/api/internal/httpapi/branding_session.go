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
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const brandingSessionBodyLimit = 400 << 10

type BrandingSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type BrandingRead struct {
	LogoDataURL   *string `json:"logoDataUrl"`
	AccentColor   *string `json:"accentColor"`
	InvoiceFooter *string `json:"invoiceFooter"`
	Layout        string  `json:"layout"`
}

type BrandingReader interface {
	ReadBranding(context.Context, string) (*BrandingRead, error)
}

type PGXBrandingReader struct {
	pool *pgxpool.Pool
}

func NewPGXBrandingReader(pool *pgxpool.Pool) *PGXBrandingReader {
	return &PGXBrandingReader{pool: pool}
}

func (r *PGXBrandingReader) ReadBranding(ctx context.Context, orgID string) (*BrandingRead, error) {
	if r == nil || r.pool == nil || !isUUID(orgID) {
		return nil, errors.New("branding database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (*BrandingRead, error) {
		var row BrandingRead
		err := tx.QueryRow(ctx, `
			SELECT logo_data_url, accent_color, invoice_footer, layout
			FROM org_branding
			WHERE org_id = $1::uuid
			LIMIT 1`, orgID).Scan(&row.LogoDataURL, &row.AccentColor, &row.InvoiceFooter, &row.Layout)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &row, nil
	})
}

type BrandingSessionHandler struct {
	resolver          BrandingSessionResolver
	executor          CapabilityExecutor
	reader            BrandingReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewBrandingSessionHandler(resolver BrandingSessionResolver, executor CapabilityExecutor, reader BrandingReader, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &BrandingSessionHandler{resolver: resolver, executor: executor, reader: reader, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *BrandingSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h.resolver == nil || h.reader == nil || (r.Method == http.MethodPost && h.executor == nil) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "branding service unavailable"})
		return
	}
	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
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

func (h *BrandingSessionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
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

func (h *BrandingSessionHandler) serveRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	branding, err := h.reader.ReadBranding(r.Context(), *resolved.OrgID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go branding read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Branding *BrandingRead `json:"branding"`
		CanEdit  bool          `json:"canEdit"`
	}{Branding: branding, CanEdit: resolved.HasPermission("iam.admin") || resolved.HasPermission("*")})
}

func (h *BrandingSessionHandler) serveWrite(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, brandingSessionBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var rawBody json.RawMessage
	if decoder.Decode(&rawBody) != nil {
		writeBrandingInvalidBody(w)
		return
	}
	rawBody = bytes.TrimSpace(rawBody)
	if len(rawBody) == 0 || rawBody[0] != '{' {
		writeBrandingInvalidBody(w)
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeBrandingInvalidBody(w)
		return
	}
	decoder = json.NewDecoder(bytes.NewReader(rawBody))
	var body map[string]json.RawMessage
	if decoder.Decode(&body) != nil || body == nil {
		writeBrandingInvalidBody(w)
		return
	}
	intentID := ""
	if intentIDValue := body["intentId"]; len(intentIDValue) > 0 {
		if string(intentIDValue) == "null" || json.Unmarshal(intentIDValue, &intentID) != nil || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
			writeBrandingInvalidBody(w)
			return
		}
	}
	inputFields := map[string]json.RawMessage{}
	for key, value := range map[string]json.RawMessage{
		"logoDataUrl": body["logoDataUrl"], "accentColor": body["accentColor"],
		"invoiceFooter": body["invoiceFooter"], "layout": body["layout"],
	} {
		if len(value) == 0 {
			continue
		}
		if string(value) == "null" {
			writeBrandingInvalidBody(w)
			return
		}
		inputFields[key] = value
	}
	input, err := json.Marshal(inputFields)
	if err != nil {
		writeBrandingInvalidBody(w)
		return
	}
	if _, err := capability.ParseIAMSetOrgBrandingInput(input); err != nil {
		writeBrandingInvalidBody(w)
		return
	}
	claims := brandingSessionClaims(resolved, intentID, input)
	const capabilityID = "iam.setOrgBranding"
	claims.CapabilityID = capabilityID
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go branding capability execution failed", "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if result.PendingApproval {
		writeJSON(w, http.StatusAccepted, struct {
			PendingApproval bool   `json:"pendingApproval"`
			Hint            string `json:"hint"`
		}{PendingApproval: true, Hint: "Branding changes proposed by the workmate wait for approval in the Approvals inbox."})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func brandingSessionClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
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

func writeBrandingInvalidBody(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
}
