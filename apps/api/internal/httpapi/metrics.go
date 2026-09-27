package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/metrics"
)

const MetricsReadAudience = "go.metrics.read"

type MetricsReader interface {
	ForOrg(context.Context, string) (metrics.Payload, error)
}

type GoMetricsHandler struct {
	secret string
	reader MetricsReader
	logger *slog.Logger
}

func NewGoMetricsHandler(secret string, reader MetricsReader, logger *slog.Logger) http.Handler {
	return &GoMetricsHandler{secret: secret, reader: reader, logger: logger}
}

func (h *GoMetricsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "metrics service unavailable"})
		return
	}

	claims, err := authbridge.Verify(h.secret, r.Header.Get(sessionAssertionHeader), MetricsReadAudience, time.Now())
	if err != nil || !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ExpiresAt-claims.IssuedAt > 30 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if orgIDs, present := r.URL.Query()["org_id"]; present && (len(orgIDs) != 1 || orgIDs[0] != claims.OrganizationID) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	payload, err := h.reader.ForOrg(r.Context(), claims.OrganizationID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go metrics read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, payload)
}
