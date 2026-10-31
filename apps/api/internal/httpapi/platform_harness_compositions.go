package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
)

type platformHarnessCompositionsHandler struct{ platformCollectionHandler }

// NewHarnessCompositionsHandler builds the authenticated composition
// inspection endpoint. Mount it at GET /api/harness/compositions behind the
// Go API router.
func NewHarnessCompositionsHandler(resolver SessionResolver, executor CapabilityExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if resolver == nil {
		return nil, errors.New("harness compositions handler requires a session resolver")
	}
	if executor == nil {
		return nil, errors.New("harness compositions handler requires a capability executor")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &platformHarnessCompositionsHandler{platformCollectionHandler{
		session: resolver, executor: executor, logger: logger, trustedProxy: trustedProxyCIDRs,
		unavailable: "harness compositions unavailable", forbidden: "requires harness.approve permission",
	}}, nil
}

func (h *platformHarnessCompositionsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	resolved, _, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	result, err := h.execute(r, resolved, "harness.listCompositions", json.RawMessage(`{}`), "")
	if !h.writeExecuteFailure(w, result, err, "harness.listCompositions") {
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

// MountGoHarnessCompositionsRoute owns GET /api/harness/compositions.
func MountGoHarnessCompositionsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/harness/compositions", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
