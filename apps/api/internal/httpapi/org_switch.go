package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

const activeOrgCookieName = "chaste_active_org"
const activeOrgCookieMaxAge = 60 * 60 * 24 * 90

type OrgMembershipChecker interface {
	IsMember(context.Context, string, string) (bool, error)
}

type GoOrgSwitchHandler struct {
	secret  string
	checker OrgMembershipChecker
	logger  *slog.Logger
}

func NewGoOrgSwitchHandler(secret string, checker OrgMembershipChecker, logger *slog.Logger) http.Handler {
	return &GoOrgSwitchHandler{secret: secret, checker: checker, logger: logger}
}

func (h *GoOrgSwitchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.checker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "org switch unavailable"})
		return
	}

	claims, err := authbridge.Verify(h.secret, r.Header.Get(sessionAssertionHeader), authbridge.OrgSwitchAudience, time.Now())
	if err != nil || !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		OrgID string `json:"orgId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || !isUUID(body.OrgID) || body.OrgID != claims.OrganizationID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	member, err := h.checker.IsMember(r.Context(), claims.Subject, claims.OrganizationID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go org switch membership check failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !member {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of that organization"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     activeOrgCookieName,
		Value:    claims.OrganizationID,
		Path:     "/",
		MaxAge:   activeOrgCookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{OK: true})
}

func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for i, r := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return false
		}
	}
	return true
}
