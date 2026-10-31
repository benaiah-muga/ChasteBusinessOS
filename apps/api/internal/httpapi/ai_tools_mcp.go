package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const aiToolsMCPBodyLimit = 64 << 10

// The bridge advertises a tiny, stable surface instead of every governed
// capability. Each tool definition is sent on every model request, so a catalog
// of hundreds would spend the context the coding agent needs for the work.
const (
	aiToolsDiscoverToolName = "chaste_discover"
	aiToolsDescribeToolName = "chaste_describe"
	aiToolsDispatchToolName = "chaste_dispatch"

	aiToolsDiscoverDefaultLimit = 8
	aiToolsDiscoverMaxLimit     = 20
	aiToolsDiscoverMaxQuery     = 200
	aiToolsDescribeMaxID        = 120
)

type aiToolsMCPStore interface {
	ActiveConnection(context.Context, string, string, string) (bool, error)
	Member(context.Context, string, string) (bool, error)
	SessionExists(context.Context, string, string, string) (bool, error)
	EnsureSession(context.Context, string, string, string) error
	EffectivePermissions(context.Context, string, string) (map[string]bool, error)
	ActiveAuthSession(context.Context, string, string) (string, bool, error)
	AppendSessionEvent(context.Context, string, string, string, any) error
}

type aiToolsMCPHandler struct {
	store    aiToolsMCPStore
	executor CapabilityExecutor
	logger   *slog.Logger
	limiter  *aiToolsRateLimiter
}

// NewAIToolsMCPHandler builds the coding-agent MCP tool bridge. Mount it at
// POST /api/ai-tools/mcp behind the Go API router.
func NewAIToolsMCPHandler(pool *pgxpool.Pool, executor CapabilityExecutor, logger *slog.Logger) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("AI tools handler requires a database pool")
	}
	if executor == nil {
		return nil, errors.New("AI tools handler requires a capability executor")
	}
	return newAIToolsMCPHandler(newPgAIToolsMCPStore(pool), executor, logger, newAIToolsRateLimiter()), nil
}

// newAIToolsMCPHandler is the test seam for exercising the bridge with a fake
// store and executor.
func newAIToolsMCPHandler(store aiToolsMCPStore, executor CapabilityExecutor, logger *slog.Logger, limiter *aiToolsRateLimiter) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	if limiter == nil {
		limiter = newAIToolsRateLimiter()
	}
	return &aiToolsMCPHandler{store: store, executor: executor, logger: logger, limiter: limiter}
}

func (h *aiToolsMCPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	authorization := r.Header.Get("Authorization")
	token := ""
	if strings.HasPrefix(authorization, "Bearer ") {
		token = strings.TrimPrefix(authorization, "Bearer ")
	}
	claims, valid := verifyAIToolAccessToken(token, time.Now())
	if !valid {
		aiToolsRPCError(w, nil, -32001, "Coding-agent access token is invalid or expired.", http.StatusUnauthorized)
		return
	}
	fields, ok := aiToolsDecodeRequest(w, r)
	if !ok {
		return
	}
	id := aiToolsRequestID(fields)
	var version string
	if raw, present := fields["jsonrpc"]; !present || json.Unmarshal(raw, &version) != nil || version != "2.0" {
		aiToolsRPCError(w, nil, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return
	}
	var method string
	if raw, present := fields["method"]; !present {
		aiToolsRPCError(w, id, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return
	} else if json.Unmarshal(raw, &method) != nil || utf8.RuneCountInString(method) < 1 || utf8.RuneCountInString(method) > 100 {
		aiToolsRPCError(w, id, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return
	}
	params, paramsValid := aiToolsRequestParams(fields)
	if !paramsValid {
		aiToolsRPCError(w, id, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return
	}
	if method == "notifications/initialized" || method == "notifications/cancelled" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if method == "ping" {
		aiToolsRPCResult(w, id, map[string]any{})
		return
	}
	if method == "initialize" {
		w.Header().Set("MCP-Protocol-Version", "2025-11-25")
		aiToolsRPCResult(w, id, map[string]any{
			"protocolVersion": "2025-11-25",
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "chaste-businessos", "version": "1.0.0"},
			"instructions":    "These tools are governed ChasteBusinessOS capabilities. Start with " + aiToolsDiscoverToolName + " to find the right capability, call " + aiToolsDescribeToolName + " for its contract, then " + aiToolsDispatchToolName + " to run it. Organization data is scoped to the connected user; permission, policy, approval, ledger, and reversibility controls remain active.",
		})
		return
	}
	h.call(w, r, claims, id, method, params)
}

func aiToolsDecodeRequest(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	if r.Body == nil {
		aiToolsRPCError(w, nil, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, aiToolsMCPBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		aiToolsRPCError(w, nil, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		aiToolsRPCError(w, nil, -32700, "Invalid JSON-RPC request.", http.StatusBadRequest)
		return nil, false
	}
	return fields, true
}

func (h *aiToolsMCPHandler) call(w http.ResponseWriter, r *http.Request, claims *aiToolAccessClaims, id json.RawMessage, method string, params map[string]json.RawMessage) {
	ctx := r.Context()
	if h.store == nil || h.executor == nil {
		aiToolsRPCError(w, id, -32603, "The business-tool bridge is unavailable.", http.StatusInternalServerError)
		return
	}
	connection, err := h.store.ActiveConnection(ctx, claims.ConnectionID, claims.OrgID, claims.UserID)
	if err != nil {
		h.failBridge(w, id, err)
		return
	}
	if !connection {
		aiToolsRPCError(w, id, -32001, "This coding-agent connection has been revoked.", http.StatusUnauthorized)
		return
	}
	member, err := h.store.Member(ctx, claims.OrgID, claims.UserID)
	if err != nil {
		h.failBridge(w, id, err)
		return
	}
	if !member {
		aiToolsRPCError(w, id, -32001, "The connected user no longer belongs to this workspace.", http.StatusUnauthorized)
		return
	}
	if claims.SessionID != "" {
		exists, err := h.store.SessionExists(ctx, claims.SessionID, claims.OrgID, claims.UserID)
		if err != nil {
			h.failBridge(w, id, err)
			return
		}
		if !exists {
			aiToolsRPCError(w, id, -32001, "The assistant session is no longer available.", http.StatusUnauthorized)
			return
		}
	}
	permissions, err := h.store.EffectivePermissions(ctx, claims.OrgID, claims.UserID)
	if err != nil {
		h.failBridge(w, id, err)
		return
	}
	authSession, found, err := h.store.ActiveAuthSession(ctx, claims.OrgID, claims.UserID)
	if err != nil {
		h.failBridge(w, id, err)
		return
	}
	if !found {
		aiToolsRPCError(w, id, -32001, "The connected user is not available.", http.StatusUnauthorized)
		return
	}
	executionSessionID := claims.SessionID
	if executionSessionID == "" {
		executionSessionID = aiToolsSessionUUID(claims.ConnectionID)
		if err := h.store.EnsureSession(ctx, executionSessionID, claims.OrgID, claims.UserID); err != nil {
			h.failBridge(w, id, err)
			return
		}
	}
	tools := capability.AgentTools(permissions)
	names := map[string]string{}
	advertised := make([]capability.AgentToolSpec, 0, len(tools))
	for _, tool := range tools {
		name := aiToolsToolName(tool.ID)
		if aiToolsIsMetaTool(name) {
			aiToolsRPCError(w, id, -32603, "Business tool names are ambiguous. Contact your workspace administrator.", http.StatusOK)
			return
		}
		if !aiToolsAllowed(claims.AllowedTools, name) {
			continue
		}
		if existing, present := names[name]; present && existing != tool.ID {
			aiToolsRPCError(w, id, -32603, "Business tool names are ambiguous. Contact your workspace administrator.", http.StatusOK)
			return
		}
		names[name] = tool.ID
		advertised = append(advertised, tool)
	}
	switch method {
	case "tools/list":
		list := aiToolsMetaToolSpecs()
		for _, tool := range advertised {
			list = append(list, map[string]any{
				"name":        aiToolsToolName(tool.ID),
				"description": tool.Description,
				"inputSchema": json.RawMessage(tool.InputSchema),
			})
		}
		aiToolsRPCResult(w, id, map[string]any{"tools": list})
	case "tools/call":
		h.callTool(w, ctx, claims, id, params, names, permissions, authSession, executionSessionID)
	default:
		aiToolsRPCError(w, id, -32601, "This Chaste tool bridge does not support that method.", http.StatusOK)
	}
}

// aiToolsMetaToolSpecs is the discover, describe, dispatch surface. Direct
// capability tools are only added when a connection explicitly pins them.
func aiToolsMetaToolSpecs() []map[string]any {
	return []map[string]any{
		{
			"name": aiToolsDiscoverToolName,
			"description": "Search the governed ChasteBusinessOS capability catalog by what you want to do. Returns short matches with id, title, intent, module, and risk, never the full schemas. Follow with " +
				aiToolsDescribeToolName + " for the contract, then " + aiToolsDispatchToolName + " to run it.",
			"inputSchema": json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":2,"maxLength":200,"description":"Plain-language description of the job."},"limit":{"type":"integer","minimum":1,"maximum":20,"default":8}},"required":["query"],"additionalProperties":false}`),
		},
		{
			"name":        aiToolsDescribeToolName,
			"description": "Read one governed capability's contract: title, intent, module, permission, risk, closed input schema, and the advisory skills that include it. Call this before dispatch when the input fields are not obvious.",
			"inputSchema": json.RawMessage(`{"type":"object","properties":{"capabilityId":{"type":"string","minLength":3,"maxLength":120,"description":"Capability id returned by ` + aiToolsDiscoverToolName + `."}},"required":["capabilityId"],"additionalProperties":false}`),
		},
		{
			"name":        aiToolsDispatchToolName,
			"description": "Run one governed capability by id with schema-valid input. Permissions, policy, approvals, audit, and reversibility apply exactly as they do for a person. A pendingApproval result means nothing has changed yet.",
			"inputSchema": json.RawMessage(`{"type":"object","properties":{"capabilityId":{"type":"string","minLength":3,"maxLength":120},"input":{"type":"object","description":"Capability input matching the schema from ` + aiToolsDescribeToolName + `."}},"required":["capabilityId"],"additionalProperties":false}`),
		},
	}
}

func aiToolsIsMetaTool(name string) bool {
	switch name {
	case aiToolsDiscoverToolName, aiToolsDescribeToolName, aiToolsDispatchToolName:
		return true
	default:
		return false
	}
}

func (h *aiToolsMCPHandler) callTool(w http.ResponseWriter, ctx context.Context, claims *aiToolAccessClaims, id json.RawMessage, params map[string]json.RawMessage, names map[string]string, permissions map[string]bool, authSession, executionSessionID string) {
	if !h.limiter.Allow("coding-tools:"+claims.UserID+":"+claims.ConnectionID, 180, time.Minute, time.Now()) {
		aiToolsRPCError(w, id, -32029, "Too many business-tool requests. Try again shortly.", http.StatusTooManyRequests)
		return
	}
	var name string
	if raw, present := params["name"]; !present || json.Unmarshal(raw, &name) != nil {
		aiToolsRPCError(w, id, -32602, "A tool name is required.", http.StatusOK)
		return
	}
	arguments := json.RawMessage(`{}`)
	if raw, present := params["arguments"]; present && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		arguments = raw
	}
	switch name {
	case aiToolsDiscoverToolName:
		h.discoverTool(w, id, arguments, permissions)
		return
	case aiToolsDescribeToolName:
		h.describeTool(w, id, arguments, permissions)
		return
	case aiToolsDispatchToolName:
		h.dispatchTool(w, ctx, claims, id, arguments, permissions, authSession, executionSessionID)
		return
	}
	capabilityID, known := names[name]
	if !known {
		aiToolsToolResult(w, id, true, "That business action is not available to this user.")
		return
	}
	if claims.SessionID != "" {
		if err := h.store.AppendSessionEvent(ctx, claims.OrgID, claims.SessionID, "tool_call", map[string]any{
			"name": capabilityID, "args": arguments,
		}); err != nil {
			h.logger.Error("append MCP tool_call event", "error", err)
		}
	}
	output, executionError, ok, pending := h.executeTool(ctx, claims, capabilityID, arguments, permissions, authSession, executionSessionID)
	if claims.SessionID != "" {
		event := map[string]any{"name": capabilityID, "ok": ok, "pendingApproval": pending, "error": executionError}
		if err := h.store.AppendSessionEvent(ctx, claims.OrgID, claims.SessionID, "tool_result", event); err != nil {
			h.logger.Error("append MCP tool_result event", "error", err)
		}
	}
	aiToolsToolResult(w, id, !ok && !pending, aiToolsJSONText(output))
}

func (h *aiToolsMCPHandler) discoverTool(w http.ResponseWriter, id json.RawMessage, arguments json.RawMessage, permissions map[string]bool) {
	var input struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(arguments, &input); err != nil {
		aiToolsRPCError(w, id, -32602, "discover needs a plain-language query.", http.StatusOK)
		return
	}
	query := strings.TrimSpace(input.Query)
	if len([]rune(query)) < 2 || len([]rune(query)) > aiToolsDiscoverMaxQuery {
		aiToolsRPCError(w, id, -32602, "The discovery query must be between 2 and 200 characters.", http.StatusOK)
		return
	}
	limit := input.Limit
	if limit < 1 {
		limit = aiToolsDiscoverDefaultLimit
	}
	if limit > aiToolsDiscoverMaxLimit {
		limit = aiToolsDiscoverMaxLimit
	}
	found := capability.SearchAgentCapabilities(permissions, query, limit)
	type discovered struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Intent string `json:"intent"`
		Module string `json:"module"`
		Risk   string `json:"risk"`
	}
	candidates := make([]discovered, 0, len(found))
	for _, row := range found {
		candidates = append(candidates, discovered{ID: row.ID, Title: row.Title, Intent: row.Intent, Module: row.Module, Risk: row.Risk})
	}
	aiToolsToolResult(w, id, false, aiToolsJSONText(map[string]any{
		"count":        len(candidates),
		"capabilities": candidates,
		"next":         "Call " + aiToolsDescribeToolName + " with the id you want, then " + aiToolsDispatchToolName + ".",
	}))
}

func (h *aiToolsMCPHandler) describeTool(w http.ResponseWriter, id json.RawMessage, arguments json.RawMessage, permissions map[string]bool) {
	var input struct {
		CapabilityID string `json:"capabilityId"`
	}
	if err := json.Unmarshal(arguments, &input); err != nil || strings.TrimSpace(input.CapabilityID) == "" || len(input.CapabilityID) > aiToolsDescribeMaxID {
		aiToolsRPCError(w, id, -32602, "describe needs a capability id from "+aiToolsDiscoverToolName+".", http.StatusOK)
		return
	}
	spec, available := capability.AgentCapabilityByID(permissions, input.CapabilityID)
	if !available {
		aiToolsToolResult(w, id, true, "That capability is not available to this user.")
		return
	}
	schema := spec.InputSchema
	if len(bytes.TrimSpace(schema)) == 0 {
		schema = json.RawMessage(`{"type":"object","properties":{}}`)
	}
	aiToolsToolResult(w, id, false, aiToolsJSONText(map[string]any{
		"id":          spec.ID,
		"title":       spec.Title,
		"intent":      spec.Intent,
		"module":      spec.Module,
		"permission":  spec.Permission,
		"risk":        spec.Risk,
		"inputSchema": json.RawMessage(schema),
		"skills":      capability.SkillsForCapability(spec.ID),
	}))
}

func (h *aiToolsMCPHandler) dispatchTool(w http.ResponseWriter, ctx context.Context, claims *aiToolAccessClaims, id json.RawMessage, arguments json.RawMessage, permissions map[string]bool, authSession, executionSessionID string) {
	var input struct {
		CapabilityID string          `json:"capabilityId"`
		Input        json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(arguments, &input); err != nil || strings.TrimSpace(input.CapabilityID) == "" {
		aiToolsRPCError(w, id, -32602, "dispatch needs a capabilityId and its input.", http.StatusOK)
		return
	}
	capabilityID := strings.TrimSpace(input.CapabilityID)
	if _, available := capability.AgentCapabilityByID(permissions, capabilityID); !available {
		aiToolsToolResult(w, id, true, "That capability is not available to this user.")
		return
	}
	capabilityInput := bytes.TrimSpace(input.Input)
	if len(capabilityInput) == 0 || bytes.Equal(capabilityInput, []byte("null")) {
		capabilityInput = []byte(`{}`)
	}
	if capabilityInput[0] != '{' || !json.Valid(capabilityInput) {
		aiToolsRPCError(w, id, -32602, "Capability input must be a JSON object.", http.StatusOK)
		return
	}
	if claims.SessionID != "" {
		if err := h.store.AppendSessionEvent(ctx, claims.OrgID, claims.SessionID, "tool_call", map[string]any{
			"name": capabilityID, "args": json.RawMessage(capabilityInput),
		}); err != nil {
			h.logger.Error("append MCP tool_call event", "error", err)
		}
	}
	output, executionError, ok, pending := h.executeTool(ctx, claims, capabilityID, json.RawMessage(capabilityInput), permissions, authSession, executionSessionID)
	if claims.SessionID != "" {
		event := map[string]any{"name": capabilityID, "ok": ok, "pendingApproval": pending, "error": executionError}
		if err := h.store.AppendSessionEvent(ctx, claims.OrgID, claims.SessionID, "tool_result", event); err != nil {
			h.logger.Error("append MCP tool_result event", "error", err)
		}
	}
	aiToolsToolResult(w, id, !ok && !pending, aiToolsJSONText(output))
}

func (h *aiToolsMCPHandler) executeTool(ctx context.Context, claims *aiToolAccessClaims, capabilityID string, arguments json.RawMessage, permissions map[string]bool, authSession, executionSessionID string) (any, string, bool, bool) {
	inputHash, err := capability.InputHash(arguments)
	if err != nil {
		return map[string]any{"ok": false, "error": "invalid capability arguments"}, "invalid capability arguments", false, false
	}
	permissionList := make([]string, 0, len(permissions))
	for permission, granted := range permissions {
		if granted {
			permissionList = append(permissionList, permission)
		}
	}
	sort.Strings(permissionList)
	actorID := claims.UserID
	now := time.Now().UTC()
	intent, err := newAIUUID()
	if err != nil {
		return map[string]any{"ok": false, "error": "capability execution failed"}, "capability execution failed", false, false
	}
	executionClaims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: claims.UserID, OrganizationID: claims.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID, ActorType: "agent",
		Permissions: permissionList, AuthSessionID: authSession, AgentSessionID: executionSessionID,
		IntentID: intent, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	result, err := h.executor.Execute(ctx, executionClaims, capabilityID, arguments)
	if err != nil {
		message := "capability execution failed"
		return map[string]any{"ok": false, "error": message}, message, false, false
	}
	if result.OK {
		return json.RawMessage(result.Data), "", true, false
	}
	output := map[string]any{"ok": false, "error": result.Error, "pendingApproval": result.PendingApproval}
	return output, result.Error, false, result.PendingApproval
}

func (h *aiToolsMCPHandler) failBridge(w http.ResponseWriter, id json.RawMessage, err error) {
	h.logger.Error("AI tools bridge failed", "error", err)
	aiToolsRPCError(w, id, -32603, "The business-tool bridge is unavailable.", http.StatusInternalServerError)
}

func aiToolsRPCResult(w http.ResponseWriter, id json.RawMessage, result any) {
	writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": aiToolsResponseID(id), "result": result})
}

func aiToolsRPCError(w http.ResponseWriter, id json.RawMessage, code int, message string, status int) {
	writeJSON(w, status, map[string]any{
		"jsonrpc": "2.0", "id": aiToolsResponseID(id),
		"error": map[string]any{"code": code, "message": message},
	})
}

func aiToolsResponseID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func aiToolsToolResult(w http.ResponseWriter, id json.RawMessage, isError bool, text string) {
	aiToolsRPCResult(w, id, map[string]any{
		"isError": isError,
		"content": []map[string]any{{"type": "text", "text": text}},
	})
}

func aiToolsRequestID(fields map[string]json.RawMessage) json.RawMessage {
	raw, present := fields["id"]
	if !present || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	switch trimmed[0] {
	case '"':
		var value string
		if json.Unmarshal(trimmed, &value) != nil {
			return nil
		}
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		var value float64
		if json.Unmarshal(trimmed, &value) != nil {
			return nil
		}
	default:
		return nil
	}
	return trimmed
}

func aiToolsRequestParams(fields map[string]json.RawMessage) (map[string]json.RawMessage, bool) {
	raw, present := fields["params"]
	if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return map[string]json.RawMessage{}, true
	}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return nil, false
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(raw, &params) != nil || params == nil {
		return nil, false
	}
	return params, true
}

func aiToolsToolName(capabilityID string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			return r
		default:
			return '_'
		}
	}, capabilityID)
}

func aiToolsAllowed(allowed []string, name string) bool {
	for _, candidate := range allowed {
		if candidate == name {
			return true
		}
	}
	return false
}

func aiToolsJSONText(value any) string {
	if raw, ok := value.(json.RawMessage); ok {
		if len(bytes.TrimSpace(raw)) == 0 {
			return "null"
		}
		return aiToolsShortenText(string(raw))
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "The capability completed, but its result could not be formatted."
	}
	return aiToolsShortenText(string(encoded))
}

func aiToolsShortenText(text string) string {
	if utf8.RuneCountInString(text) <= 24_000 {
		return text
	}
	runes := []rune(text)
	return string(runes[:23_800]) + "… output shortened"
}

func aiToolsSessionUUID(connectionID string) string {
	digest := sha256.Sum256([]byte("chaste-mcp-session:" + connectionID))
	value := digest[:16]
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

type aiToolsRateWindow struct {
	start time.Time
	count int
}

type aiToolsRateLimiter struct {
	mu      sync.Mutex
	windows map[string]aiToolsRateWindow
}

func newAIToolsRateLimiter() *aiToolsRateLimiter {
	return &aiToolsRateLimiter{windows: map[string]aiToolsRateWindow{}}
}

func (l *aiToolsRateLimiter) Allow(key string, max int, window time.Duration, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.windows[key]
	if entry.start.IsZero() || now.Sub(entry.start) >= window {
		entry = aiToolsRateWindow{start: now}
	}
	entry.count++
	l.windows[key] = entry
	return entry.count <= max
}

// MountGoAIToolsMCPRoute owns POST /api/ai-tools/mcp.
func MountGoAIToolsMCPRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/ai-tools/mcp", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// ── PostgreSQL store ──

type pgAIToolsMCPStore struct{ pool *pgxpool.Pool }

func newPgAIToolsMCPStore(pool *pgxpool.Pool) *pgAIToolsMCPStore {
	return &pgAIToolsMCPStore{pool: pool}
}

func (s *pgAIToolsMCPStore) ActiveConnection(ctx context.Context, connectionID, orgID, userID string) (bool, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (bool, error) {
		var exists bool
		err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM coding_agent_connections
			WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid AND status='connected')`,
			connectionID, orgID, userID).Scan(&exists)
		return exists, err
	})
}

func (s *pgAIToolsMCPStore) Member(ctx context.Context, orgID, userID string) (bool, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (bool, error) {
		var exists bool
		err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid)`, orgID, userID).Scan(&exists)
		return exists, err
	})
}

func (s *pgAIToolsMCPStore) SessionExists(ctx context.Context, sessionID, orgID, userID string) (bool, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (bool, error) {
		var exists bool
		err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM agent_sessions WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid)`,
			sessionID, orgID, userID).Scan(&exists)
		return exists, err
	})
}

func (s *pgAIToolsMCPStore) EnsureSession(ctx context.Context, sessionID, orgID, userID string) error {
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `INSERT INTO agent_sessions(id,org_id,user_id,title,mode)
			VALUES($1::uuid,$2::uuid,$3::uuid,'MCP tool bridge','assist') ON CONFLICT(id) DO NOTHING`,
			sessionID, orgID, userID)
		return struct{}{}, err
	})
	return err
}

func (s *pgAIToolsMCPStore) EffectivePermissions(ctx context.Context, orgID, userID string) (map[string]bool, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (map[string]bool, error) {
		rows, err := tx.Query(ctx, `SELECT DISTINCT rp.permission_key
			FROM user_roles ur
			JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.org_id=ur.org_id
			WHERE ur.org_id=$1::uuid AND ur.user_id=$2::uuid`, orgID, userID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		permissions := map[string]bool{}
		for rows.Next() {
			var permission string
			if err := rows.Scan(&permission); err != nil {
				return nil, err
			}
			permissions[permission] = true
		}
		return permissions, rows.Err()
	})
}

func (s *pgAIToolsMCPStore) ActiveAuthSession(ctx context.Context, orgID, userID string) (string, bool, error) {
	type sessionResult struct {
		sessionID string
		found     bool
	}
	result, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (sessionResult, error) {
		var sessionID string
		err := tx.QueryRow(ctx, `
			SELECT s.id FROM auth_session s
			JOIN auth_user au ON au.id = s.user_id
			JOIN users u ON lower(u.email) = lower(au.email)
			WHERE u.id=$1::uuid AND au.email_verified = true AND s.expires_at > now()
			ORDER BY s.expires_at DESC LIMIT 1`, userID).Scan(&sessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionResult{}, nil
		}
		if err != nil {
			return sessionResult{}, err
		}
		return sessionResult{sessionID: sessionID, found: true}, nil
	})
	return result.sessionID, result.found, err
}

func (s *pgAIToolsMCPStore) AppendSessionEvent(ctx context.Context, orgID, sessionID, role string, content any) error {
	encoded, err := json.Marshal(content)
	if err != nil {
		return err
	}
	_, err = dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `INSERT INTO session_events(session_id,seq,role,content)
			SELECT $1::uuid,COALESCE(MAX(seq),0)+1,$2,$3::jsonb FROM session_events WHERE session_id=$1::uuid`,
			sessionID, role, string(encoded))
		return struct{}{}, err
	})
	return err
}
