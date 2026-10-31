package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const platformEvolutionBodyLimit = 64 << 10

type platformCreatorEvolutionHandler struct{ platformCollectionHandler }

// NewCreatorEvolutionHandler builds the authenticated creator evolution
// endpoint. Mount it at POST /api/creator/evolution behind the Go API router.
func NewCreatorEvolutionHandler(resolver SessionResolver, executor CapabilityExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if resolver == nil {
		return nil, errors.New("creator evolution handler requires a session resolver")
	}
	if executor == nil {
		return nil, errors.New("creator evolution handler requires a capability executor")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &platformCreatorEvolutionHandler{platformCollectionHandler{
		session: resolver, executor: executor, logger: logger, trustedProxy: trustedProxyCIDRs,
		unavailable: "Creator evolution service unavailable; check release status before retrying",
		forbidden:   "forbidden", refusalOK: true,
	}}, nil
}

func (h *platformCreatorEvolutionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	resolved, bearer, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if !h.requireSameOrigin(w, r, bearer) {
		return
	}
	fields, ok := decodePlatformBody(w, r, platformEvolutionBodyLimit, "invalid body")
	if !ok {
		return
	}
	var action string
	if raw, present := fields["action"]; !present || json.Unmarshal(raw, &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var keys []string
	var capabilityID string
	switch action {
	case "stage":
		capabilityID = "creator.stageCandidate"
		keys = []string{"proposalId", "gapTicketId", "candidateDigest", "artifactRef"}
	case "promote":
		capabilityID = "creator.promoteCandidate"
		keys = []string{"releaseId", "candidateDigest"}
	case "rollback":
		capabilityID = "creator.rollbackCandidate"
		keys = []string{"releaseId", "candidateDigest"}
	case "canary":
		capabilityID = "creator.recordCanaryOutcome"
		keys = []string{"releaseId", "gapTicketId", "candidateDigest", "verdict", "evidenceRef", "metrics"}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intent, err := optionalPlatformIntent(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	body := make(map[string]json.RawMessage, len(keys))
	for _, key := range keys {
		if raw, present := fields[key]; present {
			body[key] = raw
		}
	}
	input, err := json.Marshal(body)
	if err != nil {
		h.fail(w, err)
		return
	}
	canonical, err := platformEvolutionInput(action, input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := h.execute(r, resolved, capabilityID, canonical, intent)
	if !h.writeExecuteFailure(w, result, err, capabilityID) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

func platformEvolutionInput(action string, input json.RawMessage) (json.RawMessage, error) {
	switch action {
	case "stage":
		parsed, err := capability.ParseCreatorStageCandidateInput(input)
		if err != nil {
			return nil, err
		}
		return json.Marshal(parsed)
	case "promote":
		parsed, err := capability.ParseCreatorPromoteCandidateInput(input)
		if err != nil {
			return nil, err
		}
		return json.Marshal(parsed)
	case "rollback":
		parsed, err := capability.ParseCreatorRollbackCandidateInput(input)
		if err != nil {
			return nil, err
		}
		return json.Marshal(parsed)
	default:
		parsed, err := capability.ParseCreatorRecordCanaryOutcomeInput(input)
		if err != nil {
			return nil, err
		}
		return json.Marshal(parsed)
	}
}

// MountGoCreatorRoutes owns the Creator agent detection and candidate
// evolution endpoints.
func MountGoCreatorRoutes(base, agentRoute, evolutionRoute http.Handler) http.Handler {
	if agentRoute == nil {
		agentRoute = http.NotFoundHandler()
	}
	if evolutionRoute == nil {
		evolutionRoute = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/creator/agent", agentRoute)
	mux.Handle("POST /api/creator/evolution", evolutionRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
