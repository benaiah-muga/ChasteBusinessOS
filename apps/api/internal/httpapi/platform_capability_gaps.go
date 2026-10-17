package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
)

type platformCapabilityGapsHandler struct{ platformCollectionHandler }

// NewCapabilityGapsHandler builds the authenticated capability gap list
// endpoint. Mount it at GET /api/capability-gaps behind the Go API router.
func NewCapabilityGapsHandler(resolver SessionResolver, executor CapabilityExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if resolver == nil {
		return nil, errors.New("capability gaps handler requires a session resolver")
	}
	if executor == nil {
		return nil, errors.New("capability gaps handler requires a capability executor")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &platformCapabilityGapsHandler{platformCollectionHandler{
		session: resolver, executor: executor, logger: logger, trustedProxy: trustedProxyCIDRs,
		unavailable: "capability gaps unavailable", forbidden: "requires platform.creator permission",
	}}, nil
}

func (h *platformCapabilityGapsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	result, err := h.execute(r, resolved, "creator.listCapabilityGaps", json.RawMessage(`{}`), "")
	if !h.writeExecuteFailure(w, result, err, "creator.listCapabilityGaps") {
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

// MountGoCapabilityGapsRoute owns GET /api/capability-gaps.
func MountGoCapabilityGapsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/capability-gaps", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
