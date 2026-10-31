package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

type Pinger interface {
	Ping(context.Context) error
}

type HealthHandler struct {
	pinger Pinger
	logger *slog.Logger
	now    func() time.Time
}

func NewHealthHandler(pinger Pinger, logger *slog.Logger) http.Handler {
	return &HealthHandler{
		pinger: pinger,
		logger: logger,
		now:    time.Now,
	}
}

func (h *HealthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	var pingErr error
	if h.pinger == nil {
		pingErr = errors.New("database pinger is not configured")
	} else {
		pingErr = h.pinger.Ping(ctx)
	}
	if pingErr != nil {
		if h.logger != nil {
			h.logger.Warn("health check failed", "error", pingErr)
		}
		writeJSON(w, http.StatusServiceUnavailable, struct {
			Status string `json:"status"`
			DB     string `json:"db"`
		}{
			Status: "degraded",
			DB:     "unavailable",
		})
		return
	}

	writeJSON(w, http.StatusOK, struct {
		Status string `json:"status"`
		DB     string `json:"db"`
		Time   string `json:"time"`
	}{
		Status: "ok",
		DB:     "connected",
		Time:   h.now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
