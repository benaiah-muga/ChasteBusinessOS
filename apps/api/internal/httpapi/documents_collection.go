package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	documentsIntentIDMaxRunes    = 200
	documentsCollectionBodyLimit = documentsUploadBodyLimit
)

type documentsCollectionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewDocumentsCollectionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &documentsCollectionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *documentsCollectionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "documents service unavailable"})
		return
	}
	switch r.URL.Path {
	case "/api/docs":
		h.handleCollection(w, r)
	case "/api/docs/folders":
		h.handleFolders(w, r)
	case "/api/docs/next-number":
		h.handleNextNumber(w, r)
	case "/api/docs/records":
		h.handleRecords(w, r)
	default:
		h.handleDocumentItem(w, r)
	}
}

func (h *documentsCollectionHandler) handleCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		h.listDocuments(w, r, resolved)
	case http.MethodPost:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		if !documentsWriteOriginAllowed(r, h.trustedProxyCIDRs) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.writeCollection(w, r, resolved)
	default:
		writeDocumentsMethodNotAllowed(w, "GET, POST")
	}
}

func (h *documentsCollectionHandler) handleFolders(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.listFolders", json.RawMessage(`{}`), "")
		if !ok {
			return
		}
		if !result.OK {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
			return
		}
		writeDocumentsCapabilityData(w, result.Data, `{"folders":[]}`)
	case http.MethodPost:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		if !documentsWriteOriginAllowed(r, h.trustedProxyCIDRs) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.writeFolders(w, r, resolved)
	default:
		writeDocumentsMethodNotAllowed(w, "GET, POST")
	}
}

func (h *documentsCollectionHandler) handleNextNumber(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeDocumentsMethodNotAllowed(w, "GET")
		return
	}
	resolved, ok := resolveDocumentsSession(w, r, h.resolver)
	if !ok {
		return
	}
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	input, err := json.Marshal(map[string]string{"kind": kind})
	if err != nil {
		h.fail(w, "encode document number input", err)
		return
	}
	if _, err := capability.ParseDocumentsInput("documents.allocateNumber", input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid document kind"})
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.allocateNumber", input, "")
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "number unavailable"})
		return
	}
	writeDocumentsCapabilityData(w, result.Data, `{}`)
}

func (h *documentsCollectionHandler) handleRecords(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeDocumentsMethodNotAllowed(w, "GET")
		return
	}
	resolved, ok := resolveDocumentsSession(w, r, h.resolver)
	if !ok {
		return
	}
	query := r.URL.Query()
	fields := map[string]json.RawMessage{
		"type":  documentsRawString(strings.TrimSpace(query.Get("type"))),
		"query": documentsRawString(query.Get("q")),
	}
	if recordID := strings.TrimSpace(query.Get("id")); recordID != "" {
		fields["id"] = documentsRawString(recordID)
	}
	input, err := json.Marshal(fields)
	if err != nil {
		h.fail(w, "encode record search input", err)
		return
	}
	if _, err := capability.ParseDocumentsInput("documents.searchRecords", input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid record search"})
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.searchRecords", input, "")
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeDocumentsCapabilityData(w, result.Data, `{"records":[]}`)
}

func (h *documentsCollectionHandler) handleDocumentItem(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	if !isUUID(documentID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid document id"})
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		h.getDocument(w, r, resolved, documentID)
	case http.MethodPost:
		resolved, ok := resolveDocumentsSession(w, r, h.resolver)
		if !ok {
			return
		}
		if !documentsWriteOriginAllowed(r, h.trustedProxyCIDRs) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.writeDocumentItem(w, r, resolved, documentID)
	default:
		writeDocumentsMethodNotAllowed(w, "GET, POST")
	}
}

func (h *documentsCollectionHandler) listDocuments(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	templateID := strings.TrimSpace(r.URL.Query().Get("template"))
	if templateID != "" {
		if !isUUID(templateID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid template id"})
			return
		}
		input, err := json.Marshal(map[string]string{"templateId": templateID})
		if err != nil {
			h.fail(w, "encode document template input", err)
			return
		}
		result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.getTemplate", input, "")
		if !ok {
			return
		}
		if !result.OK {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": result.Error})
			return
		}
		writeDocumentsCapabilityData(w, result.Data, `{"template":null}`)
		return
	}

	documentsResult, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.listDocs", json.RawMessage(`{}`), "")
	if !ok {
		return
	}
	if !documentsResult.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": documentsResult.Error})
		return
	}
	templatesResult, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.listTemplates", json.RawMessage(`{}`), "")
	if !ok {
		return
	}
	if !templatesResult.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": templatesResult.Error})
		return
	}
	var documentsOutput capability.ListAuthoredDocsOutput
	var templatesOutput capability.ListDocumentTemplatesOutput
	if err := json.Unmarshal(documentsResult.Data, &documentsOutput); err != nil {
		h.fail(w, "decode authored documents", err)
		return
	}
	if err := json.Unmarshal(templatesResult.Data, &templatesOutput); err != nil {
		h.fail(w, "decode document templates", err)
		return
	}
	if documentsOutput.Documents == nil {
		documentsOutput.Documents = []capability.AuthoredDocumentRow{}
	}
	if templatesOutput.Templates == nil {
		templatesOutput.Templates = []capability.DocumentTemplateRow{}
	}
	writeJSON(w, http.StatusOK, struct {
		Documents []capability.AuthoredDocumentRow `json:"documents"`
		Templates []capability.DocumentTemplateRow `json:"templates"`
	}{Documents: documentsOutput.Documents, Templates: templatesOutput.Templates})
}

func (h *documentsCollectionHandler) getDocument(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, documentID string) {
	if versionText := strings.TrimSpace(r.URL.Query().Get("version")); versionText != "" {
		version, err := strconv.ParseInt(versionText, 10, 64)
		if err != nil || version < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid version"})
			return
		}
		input, err := json.Marshal(map[string]any{"documentId": documentID, "version": version})
		if err != nil {
			h.fail(w, "encode document version input", err)
			return
		}
		result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.getDocVersion", input, "")
		if !ok {
			return
		}
		if !result.OK {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": result.Error})
			return
		}
		writeDocumentsCapabilityData(w, result.Data, `{}`)
		return
	}

	documentsResult, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, "documents.getDoc", documentsDocumentIDInput(documentID), "")
	if !ok {
		return
	}
	if !documentsResult.OK {
		status := http.StatusUnprocessableEntity
		if strings.Contains(documentsResult.Error, "document not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": documentsResult.Error})
		return
	}
	versionsInput := documentsDocumentIDInput(documentID)
	versionsResult, versionsErr := h.executor.Execute(r.Context(),
		documentsSessionClaims(resolved, "documents.listDocVersions", versionsInput, ""),
		"documents.listDocVersions", versionsInput)
	var documentOutput capability.GetAuthoredDocumentOutput
	var versionsOutput capability.ListDocumentVersionsOutput
	if err := json.Unmarshal(documentsResult.Data, &documentOutput); err != nil {
		h.fail(w, "decode authored document", err)
		return
	}
	if versionsErr != nil || !versionsResult.OK {
		h.logger.Warn("Go documents route could not list versions", "error", versionsErr, "capabilityError", versionsResult.Error)
	} else if err := json.Unmarshal(versionsResult.Data, &versionsOutput); err != nil {
		h.logger.Warn("Go documents route dropped unreadable version history", "error", err)
	}
	if versionsOutput.Versions == nil {
		versionsOutput.Versions = []capability.DocumentVersionSummary{}
	}
	writeJSON(w, http.StatusOK, struct {
		Document capability.AuthoredDocumentDetail   `json:"document"`
		Versions []capability.DocumentVersionSummary `json:"versions"`
	}{Document: documentOutput.Document, Versions: versionsOutput.Versions})
}

func (h *documentsCollectionHandler) writeCollection(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	write, ok := h.readCollectionWrite(w, r, documentsCollectionWrites, "")
	if !ok {
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, write.capabilityID, write.input, write.intentID)
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeDocumentsCapabilityData(w, result.Data, `{"ok":true}`)
}

func (h *documentsCollectionHandler) writeDocumentItem(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, documentID string) {
	write, ok := h.readCollectionWrite(w, r, documentsItemWrites, documentID)
	if !ok {
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, write.capabilityID, write.input, write.intentID)
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeDocumentsCapabilityData(w, result.Data, `{"ok":true}`)
}

func (h *documentsCollectionHandler) writeFolders(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	write, ok := h.readCollectionWrite(w, r, documentsFolderWrites, "")
	if !ok {
		return
	}
	result, ok := executeDocumentsCapability(w, r, h.executor, h.logger, resolved, write.capabilityID, write.input, write.intentID)
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeDocumentsCapabilityData(w, result.Data, `{"ok":true}`)
}

type documentsCollectionWrite struct {
	capabilityID string
	input        json.RawMessage
	intentID     string
}

func (h *documentsCollectionHandler) readCollectionWrite(w http.ResponseWriter, r *http.Request, writes map[string]documentsCollectionWriteSpec, documentID string) (documentsCollectionWrite, bool) {
	fields, ok := readDocumentsJSONBody(w, r, documentsCollectionBodyLimit)
	if !ok {
		return documentsCollectionWrite{}, false
	}
	action, ok := documentsAction(fields)
	if !ok {
		writeDocumentsInvalidBody(w)
		return documentsCollectionWrite{}, false
	}
	spec, known := writes[action]
	if !known {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
		return documentsCollectionWrite{}, false
	}
	if !documentsRejectUnknownKeys(fields, spec.allowed) {
		writeDocumentsInvalidBody(w)
		return documentsCollectionWrite{}, false
	}
	intentID, ok := documentsIntentID(fields)
	if !ok {
		writeDocumentsInvalidBody(w)
		return documentsCollectionWrite{}, false
	}
	delete(fields, "action")
	delete(fields, "intentId")
	if documentID != "" {
		fields["documentId"] = documentsRawString(documentID)
	}
	input, err := json.Marshal(fields)
	if err != nil {
		h.fail(w, "encode documents capability input", err)
		return documentsCollectionWrite{}, false
	}
	if _, err := capability.ParseDocumentsInput(spec.capabilityID, input); err != nil {
		writeDocumentsInvalidBody(w)
		return documentsCollectionWrite{}, false
	}
	return documentsCollectionWrite{capabilityID: spec.capabilityID, input: input, intentID: intentID}, true
}

type documentsCollectionWriteSpec struct {
	capabilityID string
	allowed      map[string]struct{}
}

var documentsCollectionWrites = map[string]documentsCollectionWriteSpec{
	"create": {
		capabilityID: "documents.createDoc",
		allowed: documentsKeys("action", "title", "content", "html", "templateId", "folder", "documentType",
			"linkedRecordType", "linkedRecordId", "linkedRecordLabel", "pageSettings", "intentId"),
	},
	"createTemplate": {
		capabilityID: "documents.createTemplate",
		allowed:      documentsKeys("action", "name", "description", "content", "intentId"),
	},
	"delete": {
		capabilityID: "documents.deleteDoc",
		allowed:      documentsKeys("action", "documentId", "intentId"),
	},
	"deleteTemplate": {
		capabilityID: "documents.deleteTemplate",
		allowed:      documentsKeys("action", "templateId", "intentId"),
	},
}

var documentsItemWrites = map[string]documentsCollectionWriteSpec{
	"publish": {
		capabilityID: "documents.saveDocVersion",
		allowed:      documentsKeys("action", "title", "content", "html", "note", "pageSettings", "intentId"),
	},
	"restore": {
		capabilityID: "documents.restoreDocVersion",
		allowed:      documentsKeys("action", "sourceVersion", "note", "intentId"),
	},
	"delete": {
		capabilityID: "documents.deleteDoc",
		allowed:      documentsKeys("action", "intentId"),
	},
	"updateMetadata": {
		capabilityID: "documents.updateDocMetadata",
		allowed:      documentsKeys("action", "title", "folder", "linkedRecordType", "linkedRecordId", "linkedRecordLabel", "intentId"),
	},
}

var documentsFolderWrites = map[string]documentsCollectionWriteSpec{
	"create": {
		capabilityID: "documents.createFolder",
		allowed:      documentsKeys("action", "path", "intentId"),
	},
	"rename": {
		capabilityID: "documents.renameFolder",
		allowed:      documentsKeys("action", "path", "newPath", "intentId"),
	},
	"delete": {
		capabilityID: "documents.deleteFolder",
		allowed:      documentsKeys("action", "path", "intentId"),
	},
}

func documentsKeys(keys ...string) map[string]struct{} {
	set := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		set[key] = struct{}{}
	}
	return set
}

func documentsRejectUnknownKeys(fields map[string]json.RawMessage, allowed map[string]struct{}) bool {
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return false
		}
	}
	return true
}

func resolveDocumentsSession(w http.ResponseWriter, r *http.Request, resolver DirectCapabilitySessionResolver) (*session.ResolvedUser, bool) {
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return nil, false
	}
	resolved, err := resolveDirectCapabilitySession(r, resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return nil, false
	}
	return resolved, true
}

func documentsWriteOriginAllowed(r *http.Request, trustedProxyCIDRs []*net.IPNet) bool {
	if strings.TrimSpace(r.Header.Get("Authorization")) != "" {
		return true
	}
	return sameOriginCapabilityRequest(r, trustedProxyCIDRs)
}

func documentsSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	inputHash, _ := capability.InputHash(input)
	actorID := resolved.UserID
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        resolved.UserID,
		OrganizationID: *resolved.OrgID,
		CapabilityID:   capabilityID,
		InputSHA256:    inputHash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    permissions,
		AuthSessionID:  resolved.AuthSessionID,
		IntentID:       intentID,
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(30 * time.Second).Unix(),
	}
}

func executeDocumentsCapability(
	w http.ResponseWriter,
	r *http.Request,
	executor CapabilityExecutor,
	logger *slog.Logger,
	resolved *session.ResolvedUser,
	capabilityID string,
	input json.RawMessage,
	intentID string,
) (capability.Result, bool) {
	claims := documentsSessionClaims(resolved, capabilityID, input, intentID)
	result, err := executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			logger.Error("Go documents capability failed", "capabilityId", capabilityID, "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return capability.Result{}, false
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, struct {
			OK              bool   `json:"ok"`
			PendingApproval bool   `json:"pendingApproval"`
			Reason          string `json:"reason"`
			ApprovalID      string `json:"approvalId,omitempty"`
		}{OK: false, PendingApproval: true, Reason: reason, ApprovalID: result.ApprovalID})
		return capability.Result{}, false
	}
	if !result.OK {
		if strings.HasPrefix(result.Error, "forbidden:") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": result.Error})
			return capability.Result{}, false
		}
		if strings.Contains(result.Error, `module "documents" is disabled`) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "documents module is disabled"})
			return capability.Result{}, false
		}
	}
	return result, true
}

func readDocumentsJSONBody(w http.ResponseWriter, r *http.Request, limit int64) (map[string]json.RawMessage, bool) {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.UseNumber()
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		writeDocumentsInvalidBody(w)
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeDocumentsInvalidBody(w)
		return nil, false
	}
	return fields, true
}

func documentsAction(fields map[string]json.RawMessage) (string, bool) {
	raw, ok := fields["action"]
	if !ok {
		return "", false
	}
	var action string
	if json.Unmarshal(raw, &action) != nil || action == "" {
		return "", false
	}
	return action, true
}

func documentsIntentID(fields map[string]json.RawMessage) (string, bool) {
	raw, ok := fields["intentId"]
	if !ok {
		return "", true
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	if utf8.RuneCountInString(value) > documentsIntentIDMaxRunes || strings.ContainsAny(value, "\r\n\x00") {
		return "", false
	}
	return value, true
}

func documentsDocumentIDInput(documentID string) json.RawMessage {
	input, err := json.Marshal(map[string]string{"documentId": documentID})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return input
}

func documentsRawString(value string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return encoded
}

func writeDocumentsInvalidBody(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
}

func writeDocumentsMethodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func writeDocumentsCapabilityData(w http.ResponseWriter, data json.RawMessage, fallback string) {
	if len(data) == 0 || !json.Valid(data) {
		data = json.RawMessage(fallback)
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *documentsCollectionHandler) fail(w http.ResponseWriter, operation string, err error) {
	h.logger.Error("Go documents route failed", "operation", operation, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

// MountGoDocumentsCollectionRoute owns the authored-documents family: the
// gallery, folders, numbering and record search, while the Vite client keeps
// reading through the capability endpoint. The one-segment assist literal is
// forwarded so the assistant route keeps its own owner.
func MountGoDocumentsCollectionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	if base != nil {
		mux.Handle("POST /api/docs/assist", base)
	}
	mux.Handle("GET /api/docs", route)
	mux.Handle("POST /api/docs", route)
	mux.Handle("GET /api/docs/{id}", route)
	mux.Handle("POST /api/docs/{id}", route)
	mux.Handle("GET /api/docs/folders", route)
	mux.Handle("POST /api/docs/folders", route)
	mux.Handle("GET /api/docs/next-number", route)
	mux.Handle("GET /api/docs/records", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
