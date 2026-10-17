package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const platformProposalsBodyLimit = 64 << 10

type platformProposalsHandler struct{ platformCollectionHandler }

// NewProposalsHandler builds the authenticated creator proposal collection
// endpoint. Mount it at GET and POST /api/proposals behind the Go API router.
func NewProposalsHandler(resolver SessionResolver, executor CapabilityExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if resolver == nil {
		return nil, errors.New("proposals handler requires a session resolver")
	}
	if executor == nil {
		return nil, errors.New("proposals handler requires a capability executor")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &platformProposalsHandler{platformCollectionHandler{
		session: resolver, executor: executor, logger: logger, trustedProxy: trustedProxyCIDRs,
		unavailable: "proposals unavailable", forbidden: "requires platform.creator permission",
	}}, nil
}

func (h *platformProposalsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch r.Method {
	case http.MethodGet:
		h.list(w, r)
	case http.MethodPost:
		h.review(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *platformProposalsHandler) list(w http.ResponseWriter, r *http.Request) {
	resolved, _, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	input := json.RawMessage(`{}`)
	if values, present := r.URL.Query()["status"]; present && len(values) > 0 && values[0] != "" {
		candidate, err := json.Marshal(map[string]string{"status": values[0]})
		if err != nil {
			h.fail(w, err)
			return
		}
		if _, err := capability.ParseCreatorListProposalsInput(candidate); err != nil {
			// Matching the legacy contract: an unknown status was a filter that
			// matched nothing, not a validation failure.
			writeJSON(w, http.StatusOK, map[string]any{"proposals": []any{}})
			return
		}
		input = candidate
	}
	result, err := h.execute(r, resolved, "creator.listProposals", input, "")
	if !h.writeExecuteFailure(w, result, err, "creator.listProposals") {
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func (h *platformProposalsHandler) review(w http.ResponseWriter, r *http.Request) {
	resolved, bearer, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if !h.requireSameOrigin(w, r, bearer) {
		return
	}
	fields, ok := decodePlatformBody(w, r, platformProposalsBodyLimit, "invalid body")
	if !ok {
		return
	}
	body := make(map[string]json.RawMessage, 3)
	for _, key := range []string{"proposalId", "decision", "comment"} {
		if raw, present := fields[key]; present {
			body[key] = raw
		}
	}
	input, err := json.Marshal(body)
	if err != nil {
		h.fail(w, err)
		return
	}
	parsed, err := capability.ParseCreatorReviewProposalInput(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	canonical, err := json.Marshal(parsed)
	if err != nil {
		h.fail(w, err)
		return
	}
	result, err := h.execute(r, resolved, "creator.reviewProposal", canonical, "")
	if err != nil {
		var domain capability.CreatorDomainError
		if errors.As(err, &domain) {
			switch {
			case strings.HasPrefix(domain.Error(), "conflict:"):
				writeJSON(w, http.StatusConflict, map[string]string{"error": domain.Error()})
			case strings.Contains(domain.Error(), "not found for organization"):
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			default:
				h.refusal(w, http.StatusUnprocessableEntity, domain.Error())
			}
			return
		}
	}
	if !h.writeExecuteFailure(w, result, err, "creator.reviewProposal") {
		return
	}
	var output capability.CreatorReviewProposalOutput
	if json.Unmarshal(result.Data, &output) != nil || output.Note == "" {
		h.fail(w, errors.New("capability returned an invalid review result"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": output.Note})
}

// MountGoProposalsRoute owns GET and POST /api/proposals.
func MountGoProposalsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/proposals", route)
	mux.Handle("POST /api/proposals", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
