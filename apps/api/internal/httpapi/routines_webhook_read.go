package httpapi

import (
	"net/http"
)

// RoutinesWebhookReadHandler answers the legacy GET alias on the routine
// webhook path. The legacy route re-ran the trigger on GET, which lets a
// crawler or prefetcher fire a routine; Go refuses with 405 and names the
// supported method in Allow so orchestrators fail loudly instead of silently
// executing work.
type RoutinesWebhookReadHandler struct{}

// NewRoutinesWebhookReadHandler builds the refusal handler for
// GET /api/routines/webhook/{token}.
func NewRoutinesWebhookReadHandler() http.Handler {
	return RoutinesWebhookReadHandler{}
}

func (RoutinesWebhookReadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Allow", http.MethodPost)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

// MountGoRoutinesWebhookReadRoute owns GET (and HEAD) on the webhook path while
// every other method and path keeps falling through to the base handler.
func MountGoRoutinesWebhookReadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/routines/webhook/{token}", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
