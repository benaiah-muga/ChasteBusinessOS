package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const documentsParseJobType = "documents.parseDocument"

var errDocumentsParseDocumentNotFound = errors.New("documents parse document not found")

type documentsParseEnqueuer interface {
	EnqueueDocumentParse(ctx context.Context, orgID, actorID, documentID string) error
}

type pgDocumentsParseEnqueuer struct {
	pool *pgxpool.Pool
}

func (e pgDocumentsParseEnqueuer) EnqueueDocumentParse(ctx context.Context, orgID, actorID, documentID string) error {
	if e.pool == nil {
		return errors.New("documents database unavailable")
	}
	_, err := dbx.WithOrgTx(ctx, e.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		var ownedID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM documents
			WHERE org_id = $1::uuid AND id = $2::uuid
			FOR UPDATE`, orgID, documentID).Scan(&ownedID)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, errDocumentsParseDocumentNotFound
		}
		if err != nil {
			return struct{}{}, err
		}
		payload, err := json.Marshal(map[string]string{"documentId": documentID})
		if err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO jobs (org_id, type, payload, created_by_actor_type, created_by_actor_id)
			VALUES ($1::uuid, $2, $3::jsonb, 'human', $4::uuid)`,
			orgID, documentsParseJobType, string(payload), actorID); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE documents
			SET status = 'queued', parse_error = NULL,
			    updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
			WHERE org_id = $1::uuid AND id = $2::uuid`, orgID, documentID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

type documentsIngestHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	enqueuer          documentsParseEnqueuer
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewDocumentsIngestHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return newDocumentsIngestHandler(pgDocumentsParseEnqueuer{pool: pool}, resolver, executor, logger, trusted)
}

func newDocumentsIngestHandler(enqueuer documentsParseEnqueuer, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trusted []*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &documentsIngestHandler{resolver: resolver, executor: executor, enqueuer: enqueuer, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *documentsIngestHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if h == nil || h.resolver == nil || h.executor == nil || h.enqueuer == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "documents service unavailable"})
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		h.getIngestedDocuments(w, r, resolved)
	case http.MethodPost:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		if !documentsWriteOriginAllowed(r, h.trustedProxyCIDRs) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.postIngestedDocuments(w, r, resolved)
	default:
		writeDocumentsMethodNotAllowed(w, "GET, POST")
	}
}

func (h *documentsIngestHandler) getIngestedDocuments(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	query := r.URL.Query()
	if documentID := strings.TrimSpace(query.Get("id")); documentID != "" {
		fields := map[string]json.RawMessage{"id": documentsRawString(documentID)}
		if query.Get("preview") == "1" {
			fields["preview"] = json.RawMessage("true")
		}
		input, err := json.Marshal(fields)
		if err != nil {
			h.fail(w, "encode ingested document read input", err)
			return
		}
		result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.listIngestedDocuments", input, "")
		if !ok {
			return
		}
		if !result.OK {
			if result.Error == "ingested document not found" {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
				return
			}
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
			return
		}
		writeDocumentsCapabilityData(w, result.Data, `{"document":null}`)
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.listIngestedDocuments", json.RawMessage(`{}`), "")
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeDocumentsCapabilityData(w, result.Data, `{"documents":[],"vendors":[]}`)
}

func (h *documentsIngestHandler) postIngestedDocuments(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	fields, ok := readDocumentsJSONBody(w, r, documentsUploadBodyLimit)
	if !ok {
		return
	}
	action, ok := documentsAction(fields)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
		return
	}
	intentID, ok := documentsIntentID(fields)
	if !ok {
		writeDocumentsInvalidBody(w)
		return
	}
	switch action {
	case "create":
		h.createIngestedDocument(w, r, resolved, fields, intentID)
	case "parse":
		h.parseIngestedDocument(w, r, resolved, fields, intentID)
	case "suggest":
		h.suggestIngestedDocument(w, r, resolved, fields, intentID)
	case "delete":
		h.deleteIngestedDocument(w, r, resolved, fields, intentID)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
	}
}

func (h *documentsIngestHandler) createIngestedDocument(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage, intentID string) {
	input := map[string]json.RawMessage{}
	if raw, present := fields["title"]; present {
		input["title"] = raw
	} else {
		input["title"] = documentsRawString("")
	}
	if folder, present, valid := documentsStringField(fields, "folder"); !valid {
		writeDocumentsInvalidBody(w)
		return
	} else if present && strings.TrimSpace(folder) != "" {
		input["folder"] = documentsRawString(strings.TrimSpace(folder))
	}
	fileBase64, present, valid := documentsStringField(fields, "fileBase64")
	if !valid {
		writeDocumentsInvalidBody(w)
		return
	}
	if present && fileBase64 != "" {
		input["fileBase64"] = documentsRawString(fileBase64)
		if mimeType, mimePresent, mimeValid := documentsStringField(fields, "mimeType"); !mimeValid {
			writeDocumentsInvalidBody(w)
			return
		} else if mimePresent {
			input["mimeType"] = documentsRawString(mimeType)
		}
	} else {
		if text, textPresent, textValid := documentsStringField(fields, "text"); !textValid {
			writeDocumentsInvalidBody(w)
			return
		} else if textPresent {
			input["text"] = documentsRawString(text)
		}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		h.fail(w, "encode ingested document input", err)
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.createDocument", raw, intentID)
	if !ok {
		return
	}
	writeIngestedCapabilityResult(w, result)
}

func (h *documentsIngestHandler) parseIngestedDocument(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage, intentID string) {
	documentID, present, valid := documentsStringField(fields, "documentId")
	if !valid {
		writeDocumentsInvalidBody(w)
		return
	}
	if !present || documentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "documentId required"})
		return
	}
	if !isUUID(documentID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid documentId"})
		return
	}
	syncRequested := false
	if raw, present := fields["sync"]; present {
		if json.Unmarshal(raw, &syncRequested) != nil {
			writeDocumentsInvalidBody(w)
			return
		}
	}
	if !syncRequested {
		if !resolved.HasPermission("documents.write") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		if documentsModuleDisabled(resolved) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "documents module is disabled"})
			return
		}
		err := h.enqueuer.EnqueueDocumentParse(r.Context(), *resolved.OrgID, resolved.UserID, documentID)
		if errors.Is(err, errDocumentsParseDocumentNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		if err != nil {
			h.fail(w, "enqueue document parse", err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			OK         bool   `json:"ok"`
			Queued     bool   `json:"queued"`
			DocumentID string `json:"documentId"`
		}{OK: true, Queued: true, DocumentID: documentID})
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.parseDocument", documentsDocumentIDInput(documentID), intentID)
	if !ok {
		return
	}
	writeIngestedCapabilityResult(w, result)
}

func (h *documentsIngestHandler) suggestIngestedDocument(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage, intentID string) {
	documentID, present, valid := documentsStringField(fields, "documentId")
	if !valid {
		writeDocumentsInvalidBody(w)
		return
	}
	if !present || documentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "documentId required"})
		return
	}
	input := map[string]json.RawMessage{"documentId": documentsRawString(documentID)}
	if rawLines, present := fields["lines"]; present {
		var entries []map[string]json.RawMessage
		if json.Unmarshal(rawLines, &entries) != nil || entries == nil {
			input["lines"] = rawLines
		} else if len(entries) > 0 {
			mapped := make([]map[string]json.RawMessage, 0, len(entries))
			for _, entry := range entries {
				line := map[string]json.RawMessage{}
				if description, present := entry["description"]; present {
					line["description"] = description
				}
				if quantity, present := entry["quantityThousandths"]; present {
					line["quantityThousandths"] = quantity
				} else {
					line["quantityThousandths"] = json.RawMessage("1000")
				}
				if price, present := entry["unitPriceMinor"]; present {
					line["unitPriceMinor"] = price
				} else {
					line["unitPriceMinor"] = json.RawMessage("0")
				}
				mapped = append(mapped, line)
			}
			encoded, err := json.Marshal(mapped)
			if err != nil {
				h.fail(w, "encode document suggestion lines", err)
				return
			}
			input["lines"] = encoded
		}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		h.fail(w, "encode document suggestion input", err)
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.suggestCoding", raw, intentID)
	if !ok {
		return
	}
	writeIngestedCapabilityResult(w, result)
}

func (h *documentsIngestHandler) deleteIngestedDocument(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage, intentID string) {
	documentID, present, valid := documentsStringField(fields, "documentId")
	if !valid {
		writeDocumentsInvalidBody(w)
		return
	}
	if !present || documentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "documentId required"})
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.deleteDocument", documentsDocumentIDInput(documentID), intentID)
	if !ok {
		return
	}
	writeIngestedCapabilityResult(w, result)
}

func (h *documentsIngestHandler) fail(w http.ResponseWriter, operation string, err error) {
	h.logger.Error("Go documents route failed", "operation", operation, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func writeIngestedCapabilityResult(w http.ResponseWriter, result capability.Result) {
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}{OK: false, Error: result.Error})
		return
	}
	data := result.Data
	if len(data) == 0 || !json.Valid(data) {
		data = nil
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data,omitempty"`
	}{OK: true, Data: data})
}

func documentsStringField(fields map[string]json.RawMessage, key string) (string, bool, bool) {
	raw, present := fields[key]
	if !present {
		return "", false, true
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", true, false
	}
	return value, true, true
}

func documentsModuleDisabled(resolved *session.ResolvedUser) bool {
	return resolved != nil && resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "documents")
}

// MountGoDocumentsIngestRoute owns the legacy ingested-documents collection
// while the Vite client keeps reading through the capability endpoint.
func MountGoDocumentsIngestRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/documents", route)
	mux.Handle("POST /api/documents", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoLegacyDocumentContentRoute owns GET /api/documents/{id}/content by
// reusing the governed content download handler.
func MountGoLegacyDocumentContentRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/documents/{id}/content", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
