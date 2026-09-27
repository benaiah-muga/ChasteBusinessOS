package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
)

const sessionAssertionHeader = "X-Chaste-Session-Assertion"

type PolicyReader interface {
	ForOrg(context.Context, string) (policy.Value, error)
}

type GoPolicyHandler struct {
	secret string
	reader PolicyReader
	logger *slog.Logger
}

func NewGoPolicyHandler(secret string, reader PolicyReader, logger *slog.Logger) http.Handler {
	return &GoPolicyHandler{secret: secret, reader: reader, logger: logger}
}

func (h *GoPolicyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "bridge unavailable"})
		return
	}
	claims, err := authbridge.Verify(h.secret, r.Header.Get(sessionAssertionHeader), authbridge.PolicyReadAudience, time.Now())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	value, err := h.reader.ForOrg(r.Context(), claims.OrganizationID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go policy read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Policy  policy.Value `json:"policy"`
		CanEdit bool         `json:"canEdit"`
	}{Policy: value, CanEdit: claims.CanEdit})
}
