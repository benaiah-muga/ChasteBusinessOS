package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const platformMarketplaceBodyLimit = 64 << 10

type platformMarketplaceHandler struct{ platformCollectionHandler }

// NewMarketplaceHandler builds the authenticated creator marketplace endpoint.
// Mount it at GET and POST /api/marketplace behind the Go API router.
func NewMarketplaceHandler(resolver SessionResolver, executor CapabilityExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if resolver == nil {
		return nil, errors.New("marketplace handler requires a session resolver")
	}
	if executor == nil {
		return nil, errors.New("marketplace handler requires a capability executor")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	handler := platformCollectionHandler{
		session: resolver, executor: executor, logger: logger, trustedProxy: trustedProxyCIDRs,
		unavailable: "marketplace service unavailable", forbidden: "forbidden", refusalOK: true,
	}
	handler.refusal422 = func(w http.ResponseWriter, capabilityID, message string) {
		if capabilityID == "creator.verifyPlugin" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"valid": false, "reason": message})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": message})
	}
	return &platformMarketplaceHandler{handler}, nil
}

func (h *platformMarketplaceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch r.Method {
	case http.MethodGet:
		h.list(w, r)
	case http.MethodPost:
		h.action(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *platformMarketplaceHandler) list(w http.ResponseWriter, r *http.Request) {
	resolved, _, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	result, err := h.execute(r, resolved, "creator.listMarketplace", json.RawMessage(`{}`), "")
	if !h.writeExecuteFailure(w, result, err, "creator.listMarketplace") {
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func (h *platformMarketplaceHandler) action(w http.ResponseWriter, r *http.Request) {
	resolved, bearer, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if !h.requireSameOrigin(w, r, bearer) {
		return
	}
	fields, ok := decodePlatformBody(w, r, platformMarketplaceBodyLimit, "invalid body")
	if !ok {
		return
	}
	var action string
	if raw, present := fields["action"]; !present || json.Unmarshal(raw, &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
		return
	}
	intent, err := optionalPlatformIntent(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	switch action {
	case "verify", "publish":
		input, ok := marketplaceManifestInput(w, fields)
		if !ok {
			return
		}
		capabilityID := "creator.verifyPlugin"
		if action == "publish" {
			capabilityID = "creator.publishListing"
		}
		result, err := h.execute(r, resolved, capabilityID, input, intent)
		if !h.writeExecuteFailure(w, result, err, capabilityID) {
			return
		}
		if capabilityID == "creator.verifyPlugin" {
			var verdict capability.CreatorVerifyPluginOutput
			if json.Unmarshal(result.Data, &verdict) != nil {
				h.fail(w, errors.New("capability returned an invalid verification result"))
				return
			}
			if verdict.Valid {
				writeJSON(w, http.StatusOK, map[string]any{"valid": true})
				return
			}
			body := map[string]any{"valid": false}
			if verdict.Reason != nil {
				body["reason"] = *verdict.Reason
			}
			writeJSON(w, http.StatusUnprocessableEntity, body)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
	case "install", "uninstall":
		raw, present := fields["listingId"]
		if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
			return
		}
		input, err := json.Marshal(map[string]json.RawMessage{"listingId": raw})
		if err != nil {
			h.fail(w, err)
			return
		}
		capabilityID := "creator.installListing"
		if action == "uninstall" {
			capabilityID = "creator.uninstallListing"
		}
		result, err := h.execute(r, resolved, capabilityID, input, intent)
		if !h.writeExecuteFailure(w, result, err, capabilityID) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
	}
}

func marketplaceManifestInput(w http.ResponseWriter, fields map[string]json.RawMessage) (json.RawMessage, bool) {
	body := make(map[string]json.RawMessage, 3)
	for _, key := range []string{"manifest", "signatureBase64", "publisherPublicKeyBase64"} {
		raw, present := fields[key]
		if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "manifest, signature and publisher key required"})
			return nil, false
		}
		body[key] = raw
	}
	input, err := json.Marshal(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	return input, true
}

// MountGoMarketplaceRoute owns GET and POST /api/marketplace.
func MountGoMarketplaceRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/marketplace", route)
	mux.Handle("POST /api/marketplace", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
