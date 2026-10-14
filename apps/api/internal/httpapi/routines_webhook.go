package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type routinesWebhookEnqueuer interface {
	Enqueue(context.Context, string) (bool, error)
}

type pgRoutinesWebhookEnqueuer struct{ pool *pgxpool.Pool }

func (e pgRoutinesWebhookEnqueuer) Enqueue(ctx context.Context, token string) (bool, error) {
	if e.pool == nil {
		return false, errors.New("routines database unavailable")
	}
	var queued bool
	err := e.pool.QueryRow(ctx, `SELECT jobs_worker.enqueue_routine_webhook($1)`, token).Scan(&queued)
	return queued, err
}

type RoutinesWebhookHandler struct {
	enqueuer          routinesWebhookEnqueuer
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	allowAttempt      func(context.Context, string) (bool, time.Duration, error)
}

func NewRoutinesWebhookHandler(pool *pgxpool.Pool, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &RoutinesWebhookHandler{
		enqueuer:          pgRoutinesWebhookEnqueuer{pool: pool},
		logger:            logger,
		trustedProxyCIDRs: trustedProxyCIDRs,
		allowAttempt: func(ctx context.Context, clientIP string) (bool, time.Duration, error) {
			if pool == nil {
				return false, 0, errors.New("public ingress rate limiter unavailable")
			}
			return allowPublicSupportAttempt(ctx, pool, "ingress", "", clientIP, publicSupportIngressLimit)
		},
	}
}

func (h *RoutinesWebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.enqueuer == nil || h.allowAttempt == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "routines service unavailable"})
		return
	}
	clientIP := requestClientIP(r, h.trustedProxyCIDRs)
	if clientIP == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "routines service unavailable"})
		return
	}
	allowed, retry, err := h.allowAttempt(r.Context(), clientIP)
	if err != nil {
		h.logger.Error("routine webhook ingress rate limit failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "routines service unavailable"})
		return
	}
	if !allowed {
		writePublicSupportRateLimited(w, retry, "slow down")
		return
	}
	token := r.PathValue("token")
	if !isUUID(token) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	queued, err := h.enqueuer.Enqueue(r.Context(), token)
	if err != nil {
		h.logger.Error("routine webhook enqueue failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "routines service unavailable"})
		return
	}
	if !queued {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"accepted": true})
}
