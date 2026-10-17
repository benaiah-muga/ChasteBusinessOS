package httpapi

import (
	"errors"
	"log/slog"
	"net"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

// scimCollectionDeleteHandler refuses collection-level SCIM user deletion with
// the SCIM error envelope. SCIM 2.0 defines DELETE only for a user resource;
// the legacy collection route happened to look up a user whose id was literally
// "Users", so Go answers 405 and names the methods the collection does support.
type scimCollectionDeleteHandler struct {
	read *scimReadHandler
}

// NewSCIMCollectionDeleteHandler builds the collection-level refusal with its
// own SCIM auth attempt budget.
func NewSCIMCollectionDeleteHandler(pool *pgxpool.Pool, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	return NewSCIMCollectionDeleteHandlerWithLimiter(pool, trustedProxyCIDRs, logger, NewSCIMRateLimiter())
}

// NewSCIMCollectionDeleteHandlerWithLimiter shares the SCIM attempt budget and
// bearer-token resolution with the mounted read and write handlers.
func NewSCIMCollectionDeleteHandlerWithLimiter(pool *pgxpool.Pool, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger, limiter *SCIMRateLimiter) (http.Handler, error) {
	readHandler, err := NewSCIMReadHandlerWithLimiter(pool, trustedProxyCIDRs, logger, limiter)
	if err != nil {
		return nil, err
	}
	read, ok := readHandler.(*scimReadHandler)
	if !ok {
		return nil, errors.New("SCIM read handler has an unexpected implementation")
	}
	return &scimCollectionDeleteHandler{read: read}, nil
}

func (h *scimCollectionDeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/scim+json; charset=utf-8")
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", http.MethodDelete)
		h.read.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !h.read.allow(requestClientIP(r, h.read.trustedProxyCIDRs)) {
		h.read.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return
	}
	if _, ok := h.read.resolveOrg(r.Context(), r.Header.Get("Authorization")); !ok {
		h.read.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return
	}
	w.Header().Set("Allow", "GET, POST")
	h.read.writeError(w, http.StatusMethodNotAllowed, "the SCIM user collection cannot be deleted; delete individual users instead")
}

// MountGoSCIMCollectionDeleteRoute owns DELETE on the user collection only;
// item deletes and every other SCIM method or path fall through to the base
// handler.
func MountGoSCIMCollectionDeleteRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("DELETE /api/scim/v2/Users", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
