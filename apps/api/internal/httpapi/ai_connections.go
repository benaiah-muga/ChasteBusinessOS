package httpapi

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	aiConnectionsBodyLimit         = 16 << 10
	aiConnectionsMaxRemoteBytes    = 1_000_000
	aiConnectionTokenDaySeconds    = 86_400
	aiConnectionStatusConnected    = "connected"
	aiConnectionStatusDisconnected = "disconnected"
	aiConnectionStatusAttention    = "needs_attention"
	aiConnectionProviderCodex      = "codex"
	aiConnectionProviderOpenCode   = "opencode"
	aiConnectionsInvalidBodyError  = "invalid coding-agent connection request"
)

// errAIChooseDefault reports a default-selection request for a connection that
// is missing, not owned by the caller, or not currently connected.
var errAIChooseDefault = errors.New("Choose a connected account that belongs to you.")

type aiConnectionRecord struct {
	ID           string
	Provider     string
	Endpoint     *string
	ModelID      *string
	Status       string
	IsDefault    bool
	RunCount     int64
	InputTokens  int64
	OutputTokens int64
	LastUsedAt   *time.Time
	ConnectedAt  time.Time
}

type aiConnectionPublic struct {
	ID           string  `json:"id"`
	Provider     string  `json:"provider"`
	Endpoint     *string `json:"endpoint"`
	ModelID      *string `json:"modelId"`
	Status       string  `json:"status"`
	IsDefault    bool    `json:"isDefault"`
	RunCount     int64   `json:"runCount"`
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	LastUsedAt   *string `json:"lastUsedAt"`
	ConnectedAt  string  `json:"connectedAt"`
}

type aiOpenCodeCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type aiToolAccessClaims struct {
	Audience     string   `json:"aud"`
	OrgID        string   `json:"orgId"`
	UserID       string   `json:"userId"`
	ConnectionID string   `json:"connectionId"`
	SessionID    string   `json:"sessionId,omitempty"`
	AllowedTools []string `json:"allowedTools"`
	IssuedAt     int64    `json:"iat"`
	ExpiresAt    int64    `json:"exp"`
}

type aiCodexLoginState struct {
	VerificationURL *string
	UserCode        *string
}

type aiCodexPollResponse struct {
	Connected       bool                `json:"connected"`
	Message         string              `json:"message"`
	VerificationURL *string             `json:"verificationUrl"`
	UserCode        *string             `json:"userCode"`
	Connection      *aiConnectionPublic `json:"connection,omitempty"`
}

type aiCodexStartResponse struct {
	VerificationURL  *string `json:"verificationUrl"`
	UserCode         *string `json:"userCode"`
	WaitingForPrompt bool    `json:"waitingForPrompt"`
}

func formatAIConnectionTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func aiConnectionPublicFromRecord(row aiConnectionRecord) aiConnectionPublic {
	var lastUsed *string
	if row.LastUsedAt != nil {
		formatted := formatAIConnectionTime(*row.LastUsedAt)
		lastUsed = &formatted
	}
	return aiConnectionPublic{
		ID: row.ID, Provider: row.Provider, Endpoint: row.Endpoint, ModelID: row.ModelID,
		Status: row.Status, IsDefault: row.IsDefault,
		RunCount: row.RunCount, InputTokens: row.InputTokens, OutputTokens: row.OutputTokens,
		LastUsedAt: lastUsed, ConnectedAt: formatAIConnectionTime(row.ConnectedAt),
	}
}

func aiConnectionPublicList(rows []aiConnectionRecord) []aiConnectionPublic {
	list := make([]aiConnectionPublic, 0, len(rows))
	for _, row := range rows {
		list = append(list, aiConnectionPublicFromRecord(row))
	}
	return list
}

type aiConnectionStore interface {
	List(context.Context, string, string) ([]aiConnectionRecord, error)
	UpsertOpenCode(context.Context, string, string, string, string, *string, *bool) (aiConnectionRecord, error)
	MarkAttention(context.Context, string, string) error
	UpsertCodex(context.Context, string, string, *bool) (aiConnectionRecord, error)
	ChooseDefault(context.Context, string, string, *string) error
	Lookup(context.Context, string, string, string) (aiConnectionRecord, bool, error)
	MarkDisconnected(context.Context, string, string) error
}

type aiOpenCodeClient interface {
	Connect(context.Context, string, string, string) (string, error)
	ConfigureMCP(context.Context, string, string, string, string, string, string) error
}

type aiCodexRuntime interface {
	Probe() (bool, *string)
	Start(context.Context, string, string) (aiCodexLoginState, error)
	Poll(context.Context, string, string) (bool, aiCodexLoginState, error)
	Stop(context.Context, string, string)
}

type aiConnectionsHandler struct {
	platformCollectionHandler
	store    aiConnectionStore
	opencode aiOpenCodeClient
	codex    aiCodexRuntime
}

// NewAIConnectionsHandler builds the coding-agent connection endpoint. Mount
// it at GET and POST /api/ai-connections behind the Go API router.
func NewAIConnectionsHandler(pool *pgxpool.Pool, resolver SessionResolver, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("AI connections handler requires a database pool")
	}
	if resolver == nil {
		return nil, errors.New("AI connections handler requires a session resolver")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	return newAIConnectionsHandler(newPgAIConnectionStore(pool), newHTTPAIOpenCodeClient(), newLocalAICodexRuntime(), resolver, trustedProxyCIDRs, logger), nil
}

// newAIConnectionsHandler is the test seam for exercising the HTTP behavior
// with fake stores, OpenCode servers and Codex runtimes.
func newAIConnectionsHandler(store aiConnectionStore, opencode aiOpenCodeClient, codex aiCodexRuntime, resolver SessionResolver, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &aiConnectionsHandler{
		platformCollectionHandler: platformCollectionHandler{
			session: resolver, logger: logger, trustedProxy: trustedProxyCIDRs,
			unavailable: "AI connections unavailable", forbidden: "forbidden",
		},
		store: store, opencode: opencode, codex: codex,
	}
}

func (h *aiConnectionsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	switch r.Method {
	case http.MethodGet:
		h.get(w, r)
	case http.MethodPost:
		h.post(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *aiConnectionsHandler) get(w http.ResponseWriter, r *http.Request) {
	resolved, _, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if h.store == nil {
		h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		return
	}
	connections, err := h.store.List(r.Context(), *resolved.OrgID, resolved.UserID)
	if err != nil {
		h.fail(w, err)
		return
	}
	available := false
	var version *string
	if h.codex != nil {
		available, version = h.codex.Probe()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connections": aiConnectionPublicList(connections),
		"codexRuntime": map[string]any{
			"available": available,
			"version":   version,
		},
	})
}

func (h *aiConnectionsHandler) post(w http.ResponseWriter, r *http.Request) {
	resolved, bearer, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if !h.requireSameOrigin(w, r, bearer) {
		return
	}
	if h.store == nil {
		h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		return
	}
	fields, ok := decodePlatformBody(w, r, aiConnectionsBodyLimit, aiConnectionsInvalidBodyError)
	if !ok {
		return
	}
	var action string
	if raw, present := fields["action"]; !present || json.Unmarshal(raw, &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": aiConnectionsInvalidBodyError})
		return
	}
	switch action {
	case "connect_opencode":
		h.connectOpenCode(w, r, resolved, fields)
	case "start_codex_login":
		h.startCodexLogin(w, r, resolved)
	case "poll_codex_login":
		h.pollCodexLogin(w, r, resolved, fields)
	case "set_default":
		h.setDefault(w, r, resolved, fields)
	case "disconnect":
		h.disconnect(w, r, resolved, fields)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": aiConnectionsInvalidBodyError})
	}
}

func (h *aiConnectionsHandler) connectOpenCode(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage) {
	endpoint, ok := aiConnectionStringField(fields, "endpoint", 1, 500)
	if !ok {
		h.invalidBody(w)
		return
	}
	username, ok := aiConnectionOptionalStringField(fields, "username", 100)
	if !ok {
		h.invalidBody(w)
		return
	}
	password, ok := aiConnectionStringField(fields, "password", 1, 1000)
	if !ok {
		h.invalidBody(w)
		return
	}
	modelID, ok := aiConnectionOptionalStringField(fields, "modelId", 200)
	if !ok {
		h.invalidBody(w)
		return
	}
	makeDefault, ok := aiConnectionOptionalBoolField(fields, "makeDefault")
	if !ok {
		h.invalidBody(w)
		return
	}
	if h.opencode == nil {
		h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		return
	}
	normalized, err := h.opencode.Connect(r.Context(), endpoint, derefAIConnectionString(username), password)
	if err != nil {
		h.unprocessable(w, err)
		return
	}
	credential := aiOpenCodeCredential{Username: derefAIConnectionString(username), Password: password}
	if credential.Username == "" {
		credential.Username = "opencode"
	}
	plain, err := json.Marshal(credential)
	if err != nil {
		h.fail(w, err)
		return
	}
	encrypted, err := encryptCodingAgentSecret(string(plain))
	if err != nil {
		h.fail(w, err)
		return
	}
	var normalizedModel *string
	if modelID != nil && *modelID != "" {
		normalizedModel = modelID
	}
	record, err := h.store.UpsertOpenCode(r.Context(), *resolved.OrgID, resolved.UserID, normalized, encrypted, normalizedModel, makeDefault)
	if err != nil {
		h.fail(w, err)
		return
	}
	if err := h.opencode.ConfigureMCP(r.Context(), normalized, credential.Username, credential.Password, record.ID, *resolved.OrgID, resolved.UserID); err != nil {
		if markErr := h.store.MarkAttention(r.Context(), *resolved.OrgID, record.ID); markErr != nil {
			h.fail(w, markErr)
			return
		}
		h.unprocessable(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "connection": aiConnectionPublicFromRecord(record)})
}

func (h *aiConnectionsHandler) startCodexLogin(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if h.codex == nil {
		h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		return
	}
	state, err := h.codex.Start(r.Context(), *resolved.OrgID, resolved.UserID)
	if err != nil {
		h.unprocessable(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"login": aiCodexStartResponse{
			VerificationURL: state.VerificationURL, UserCode: state.UserCode,
			WaitingForPrompt: state.VerificationURL == nil || state.UserCode == nil,
		},
	})
}

func (h *aiConnectionsHandler) pollCodexLogin(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage) {
	makeDefault, ok := aiConnectionOptionalBoolField(fields, "makeDefault")
	if !ok {
		h.invalidBody(w)
		return
	}
	if h.codex == nil {
		h.refusal(w, http.StatusServiceUnavailable, h.unavailable)
		return
	}
	connected, state, err := h.codex.Poll(r.Context(), *resolved.OrgID, resolved.UserID)
	if err != nil {
		h.unprocessable(w, err)
		return
	}
	if !connected {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"login": aiCodexPollResponse{
				Connected: false, Message: "Waiting for you to finish sign-in in the browser.",
				VerificationURL: state.VerificationURL, UserCode: state.UserCode,
			},
		})
		return
	}
	record, err := h.store.UpsertCodex(r.Context(), *resolved.OrgID, resolved.UserID, makeDefault)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"login": aiCodexPollResponse{
				Connected: false,
				Message:   "Codex signed in, but its workspace connection could not be saved.",
			},
		})
		return
	}
	connection := aiConnectionPublicFromRecord(record)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"login": aiCodexPollResponse{
			Connected: true, Message: "Codex plan connected.", Connection: &connection,
		},
	})
}

func (h *aiConnectionsHandler) setDefault(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage) {
	raw, present := fields["connectionId"]
	if !present {
		h.invalidBody(w)
		return
	}
	var connectionID *string
	if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var value string
		if json.Unmarshal(raw, &value) != nil || !isUUID(value) {
			h.invalidBody(w)
			return
		}
		connectionID = &value
	}
	if err := h.store.ChooseDefault(r.Context(), *resolved.OrgID, resolved.UserID, connectionID); err != nil {
		if errors.Is(err, errAIChooseDefault) {
			h.unprocessable(w, err)
			return
		}
		h.fail(w, err)
		return
	}
	h.respondWithConnections(w, r, resolved)
}

func (h *aiConnectionsHandler) disconnect(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage) {
	provider, ok := aiConnectionStringField(fields, "provider", 1, 0)
	if !ok || (provider != aiConnectionProviderCodex && provider != aiConnectionProviderOpenCode) {
		h.invalidBody(w)
		return
	}
	record, found, err := h.store.Lookup(r.Context(), *resolved.OrgID, resolved.UserID, provider)
	if err != nil {
		h.fail(w, err)
		return
	}
	if found {
		if provider == aiConnectionProviderCodex && h.codex != nil {
			h.codex.Stop(r.Context(), *resolved.OrgID, resolved.UserID)
		}
		if err := h.store.MarkDisconnected(r.Context(), *resolved.OrgID, record.ID); err != nil {
			h.unprocessable(w, err)
			return
		}
	}
	h.respondWithConnections(w, r, resolved)
}

func (h *aiConnectionsHandler) respondWithConnections(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	connections, err := h.store.List(r.Context(), *resolved.OrgID, resolved.UserID)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "connections": aiConnectionPublicList(connections)})
}

func (h *aiConnectionsHandler) invalidBody(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": aiConnectionsInvalidBodyError})
}

func (h *aiConnectionsHandler) unprocessable(w http.ResponseWriter, err error) {
	message := truncateAIConnectionMessage(err.Error(), 500)
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": message})
}

func truncateAIConnectionMessage(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func derefAIConnectionString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func aiConnectionStringField(fields map[string]json.RawMessage, key string, min, max int) (string, bool) {
	raw, present := fields[key]
	if !present {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	length := utf8.RuneCountInString(value)
	if length < min || (max > 0 && length > max) {
		return "", false
	}
	return value, true
}

func aiConnectionOptionalStringField(fields map[string]json.RawMessage, key string, max int) (*string, bool) {
	raw, present := fields[key]
	if !present {
		return nil, true
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	value = strings.TrimSpace(value)
	if max > 0 && utf8.RuneCountInString(value) > max {
		return nil, false
	}
	return &value, true
}

func aiConnectionOptionalBoolField(fields map[string]json.RawMessage, key string) (*bool, bool) {
	raw, present := fields[key]
	if !present {
		return nil, true
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	return &value, true
}

// MountGoAIConnectionsRoute owns GET and POST /api/ai-connections.
func MountGoAIConnectionsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/ai-connections", route)
	mux.Handle("POST /api/ai-connections", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

func aiConnectionSecret() string {
	if value := os.Getenv("AI_CONFIG_ENCRYPTION_KEY"); value != "" {
		return value
	}
	return os.Getenv("BETTER_AUTH_SECRET")
}

// encryptCodingAgentSecret mirrors the legacy provider-key envelope, including
// the random nonce; the deterministic AI config encryptor is unsafe here.
func encryptCodingAgentSecret(plain string) (string, error) {
	secret := aiConnectionSecret()
	if secret == "" {
		return "", errors.New("AI_CONFIG_ENCRYPTION_KEY or BETTER_AUTH_SECRET is required")
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]
	return "v1:" + base64.RawURLEncoding.EncodeToString(iv) +
		":" + base64.RawURLEncoding.EncodeToString(tag) +
		":" + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func newAIUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func signAIToolAccessToken(claims aiToolAccessClaims, now time.Time) (string, error) {
	secret := aiConnectionSecret()
	if secret == "" {
		return "", errors.New("Coding agent access tokens require the AI encryption secret.")
	}
	issuedAt := (now.Unix() / aiConnectionTokenDaySeconds) * aiConnectionTokenDaySeconds
	claims.Audience = "chaste-mcp"
	claims.IssuedAt = issuedAt
	claims.ExpiresAt = issuedAt + aiConnectionTokenDaySeconds*2
	if claims.AllowedTools == nil {
		claims.AllowedTools = []string{}
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func verifyAIToolAccessToken(token string, now time.Time) (*aiToolAccessClaims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, false
	}
	secret := aiConnectionSecret()
	if secret == "" {
		return nil, false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0]))
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, false
	}
	var claims aiToolAccessClaims
	if json.Unmarshal(payload, &claims) != nil {
		return nil, false
	}
	if claims.Audience != "chaste-mcp" || claims.ExpiresAt <= now.Unix() ||
		claims.OrgID == "" || claims.UserID == "" || claims.ConnectionID == "" || claims.AllowedTools == nil {
		return nil, false
	}
	return &claims, true
}

// ── OpenCode HTTP client ──

type httpAIOpenCodeClient struct {
	production bool
}

func newHTTPAIOpenCodeClient() *httpAIOpenCodeClient {
	return &httpAIOpenCodeClient{production: aiProductionRuntime()}
}

func aiProductionRuntime() bool {
	for _, key := range []string{"NODE_ENV", "GO_ENV", "APP_ENV"} {
		if strings.EqualFold(strings.TrimSpace(os.Getenv(key)), "production") {
			return true
		}
	}
	return false
}

func aiPublicAppURL() string {
	for _, key := range []string{"GO_PUBLIC_APP_URL", "CHASTE_PUBLIC_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_URL"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return "http://localhost:3000"
}

type aiOpenCodeResponse struct {
	status int
	body   any
}

func (c *httpAIOpenCodeClient) Connect(ctx context.Context, endpoint, username, password string) (string, error) {
	normalized, err := normalizeAIOpenCodeEndpoint(endpoint, c.production)
	if err != nil {
		return "", err
	}
	credential := aiOpenCodeCredential{Username: strings.TrimSpace(username), Password: password}
	if credential.Username == "" {
		credential.Username = "opencode"
	}
	health, err := c.request(ctx, normalized, credential, "/global/health", http.MethodGet, nil)
	if err != nil {
		return "", err
	}
	healthy, _ := health.body.(map[string]any)
	healthyFlag, _ := healthy["healthy"].(bool)
	if health.status < 200 || health.status >= 300 || !healthyFlag {
		if health.status == 401 {
			return "", errors.New("OpenCode rejected the server password.")
		}
		return "", errors.New("This address did not respond as a healthy OpenCode server.")
	}
	providers, err := c.request(ctx, normalized, credential, "/provider", http.MethodGet, nil)
	if err != nil {
		return "", err
	}
	if providers.status < 200 || providers.status >= 300 {
		return "", errors.New("OpenCode could not read its connected providers.")
	}
	providerData, _ := providers.body.(map[string]any)
	connected, _ := providerData["connected"].([]any)
	if len(connected) == 0 {
		return "", errors.New("Sign in to a model provider in OpenCode before connecting it to Chaste.")
	}
	return normalized, nil
}

func (c *httpAIOpenCodeClient) ConfigureMCP(ctx context.Context, endpoint, username, password, connectionID, orgID, userID string) error {
	credential := aiOpenCodeCredential{Username: strings.TrimSpace(username), Password: password}
	if credential.Username == "" {
		credential.Username = "opencode"
	}
	identifier := strings.ReplaceAll(connectionID, "-", "")
	if len(identifier) > 12 {
		identifier = identifier[:12]
	}
	accessToken, err := signAIToolAccessToken(aiToolAccessClaims{
		OrgID: orgID, UserID: userID, ConnectionID: connectionID, AllowedTools: []string{},
	}, time.Now())
	if err != nil {
		return err
	}
	result, err := c.request(ctx, endpoint, credential, "/mcp", http.MethodPost, map[string]any{
		"name": "chaste_" + identifier,
		"config": map[string]any{
			"type": "remote", "url": strings.TrimRight(aiPublicAppURL(), "/") + "/api/ai-tools/mcp",
			"oauth": false, "disabled": false, "codemode": false,
			"headers": map[string]string{"Authorization": "Bearer " + accessToken},
		},
	})
	if err != nil {
		return err
	}
	data, _ := result.body.(map[string]any)
	if result.status < 200 || result.status >= 300 || aiConnectionString(data["status"]) == "failed" {
		message := ""
		if errorBody, ok := data["error"].(map[string]any); ok {
			message = aiConnectionString(errorBody["message"])
		}
		if message == "" {
			message = "OpenCode could not connect to Chaste tools."
		}
		return errors.New(message)
	}
	return nil
}

func aiConnectionString(value any) string {
	text, _ := value.(string)
	return text
}

func (c *httpAIOpenCodeClient) request(ctx context.Context, endpoint string, credential aiOpenCodeCredential, pathname, method string, body any) (aiOpenCodeResponse, error) {
	parsed, err := url.Parse(endpoint + pathname)
	if err != nil {
		return aiOpenCodeResponse{}, errors.New("The OpenCode server address is invalid.")
	}
	addresses, err := resolveAIOpenCodeAddresses(ctx, parsed.Hostname(), c.production)
	if err != nil {
		return aiOpenCodeResponse{}, err
	}
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "http" {
			port = "80"
		} else {
			port = "443"
		}
	}
	var payload []byte
	var reader io.Reader
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return aiOpenCodeResponse{}, err
		}
		reader = bytes.NewReader(payload)
	}
	requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, method, parsed.String(), reader)
	if err != nil {
		return aiOpenCodeResponse{}, errors.New("The OpenCode server address is invalid.")
	}
	request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(credential.Username+":"+credential.Password)))
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Host = parsed.Host
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	transport := &http.Transport{
		DialContext: func(dialCtx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(dialCtx, network, net.JoinHostPort(addresses[0], port))
		},
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		DisableKeepAlives: true,
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			return aiOpenCodeResponse{}, errors.New("OpenCode server timed out.")
		}
		return aiOpenCodeResponse{}, errors.New("The OpenCode server could not be reached.")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, aiConnectionsMaxRemoteBytes+1))
	if err != nil {
		return aiOpenCodeResponse{}, errors.New("The OpenCode server response could not be read.")
	}
	if len(raw) > aiConnectionsMaxRemoteBytes {
		return aiOpenCodeResponse{}, errors.New("OpenCode response exceeded the size limit.")
	}
	var decoded any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			decoded = string(raw)
		}
	}
	return aiOpenCodeResponse{status: response.StatusCode, body: decoded}, nil
}

func normalizeAIOpenCodeEndpoint(value string, production bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" {
		return "", errors.New("Use a public HTTPS OpenCode server address. Local servers are allowed in development only.")
	}
	if !aiEndpointProtocolAllowed(parsed, production) {
		return "", errors.New("Use a public HTTPS OpenCode server address. Local servers are allowed in development only.")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func aiEndpointProtocolAllowed(parsed *url.URL, production bool) bool {
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	if host == "" {
		return false
	}
	if host == "localhost" || host == "127.0.0.1" || host == "::1" ||
		strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return !production
	}
	if parsed.Scheme != "https" {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		if ipv4 := ip.To4(); ipv4 != nil {
			return !aiPrivateIPv4(ipv4)
		}
		return !aiPrivateIPv6(ip)
	}
	return strings.Contains(host, ".") && !strings.HasSuffix(host, ".internal")
}

func resolveAIOpenCodeAddresses(ctx context.Context, hostname string, production bool) ([]string, error) {
	host := strings.Trim(hostname, "[]")
	localDev := !production && (host == "localhost" || host == "127.0.0.1" || host == "::1")
	var addresses []string
	if ip := net.ParseIP(host); ip != nil {
		addresses = []string{ip.String()}
	} else {
		records, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, errors.New("The OpenCode server address did not resolve.")
		}
		for _, record := range records {
			addresses = append(addresses, record.IP.String())
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("The OpenCode server address did not resolve.")
	}
	for _, address := range addresses {
		if aiPrivateAddress(address) && !localDev {
			return nil, errors.New("The OpenCode address resolves to a private network, which is blocked for security.")
		}
	}
	return addresses, nil
}

func aiPrivateAddress(address string) bool {
	ip := net.ParseIP(address)
	if ip == nil {
		return true
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return aiPrivateIPv4(ipv4)
	}
	return aiPrivateIPv6(ip)
}

func aiPrivateIPv4(ip net.IP) bool {
	a, b, c := int(ip[0]), int(ip[1]), int(ip[2])
	return a == 0 || a == 10 || a == 127 || a >= 224 ||
		(a == 100 && b >= 64 && b <= 127) ||
		(a == 169 && b == 254) ||
		(a == 172 && b >= 16 && b <= 31) ||
		(a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)))) ||
		(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
		(a == 203 && b == 0 && c == 113)
}

func aiPrivateIPv6(ip net.IP) bool {
	first := ip[0]
	switch {
	case ip.IsUnspecified(), ip.IsLoopback():
		return true
	case first&0xfe == 0xfc:
		return true
	case first == 0xfe && ip[1]&0xc0 == 0x80:
		return true
	case first == 0xff:
		return true
	}
	if ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x0d && ip[3] == 0xb8 {
		return true
	}
	return first&0xe0 != 0x20
}

// ── PostgreSQL store ──

type pgAIConnectionStore struct{ pool *pgxpool.Pool }

func newPgAIConnectionStore(pool *pgxpool.Pool) *pgAIConnectionStore {
	return &pgAIConnectionStore{pool: pool}
}

const aiConnectionColumns = `id, provider, endpoint, model_id, status, is_default, run_count, input_tokens, output_tokens, last_used_at, connected_at`

func scanAIConnectionRow(row pgx.Row) (aiConnectionRecord, error) {
	var record aiConnectionRecord
	err := row.Scan(&record.ID, &record.Provider, &record.Endpoint, &record.ModelID, &record.Status,
		&record.IsDefault, &record.RunCount, &record.InputTokens, &record.OutputTokens, &record.LastUsedAt, &record.ConnectedAt)
	return record, err
}

func (s *pgAIConnectionStore) List(ctx context.Context, orgID, userID string) ([]aiConnectionRecord, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) ([]aiConnectionRecord, error) {
		rows, err := tx.Query(ctx, `SELECT `+aiConnectionColumns+`
			FROM coding_agent_connections
			WHERE org_id=$1::uuid AND user_id=$2::uuid
			ORDER BY connected_at DESC, id`, orgID, userID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		records := []aiConnectionRecord{}
		for rows.Next() {
			record, err := scanAIConnectionRow(rows)
			if err != nil {
				return nil, err
			}
			records = append(records, record)
		}
		return records, rows.Err()
	})
}

func (s *pgAIConnectionStore) UpsertOpenCode(ctx context.Context, orgID, userID, endpoint, encryptedCredential string, modelID *string, makeDefault *bool) (aiConnectionRecord, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (aiConnectionRecord, error) {
		existing, err := aiConnectionExists(ctx, tx, orgID, userID, aiConnectionProviderOpenCode)
		if err != nil {
			return aiConnectionRecord{}, err
		}
		isDefault := !existing
		if makeDefault != nil {
			isDefault = *makeDefault
		}
		if isDefault {
			if _, err := tx.Exec(ctx, `UPDATE coding_agent_connections SET is_default=false, updated_at=now()
				WHERE org_id=$1::uuid AND user_id=$2::uuid AND is_default`, orgID, userID); err != nil {
				return aiConnectionRecord{}, err
			}
		}
		generated, err := newAIUUID()
		if err != nil {
			return aiConnectionRecord{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO coding_agent_connections
			(id, org_id, user_id, provider, endpoint, encrypted_credential, model_id, status, is_default, updated_at)
			VALUES ($1::uuid,$2::uuid,$3::uuid,'opencode',$4,$5,$6,'connected',$7,now())
			ON CONFLICT (org_id, user_id, provider) DO UPDATE SET
				endpoint=EXCLUDED.endpoint,
				encrypted_credential=EXCLUDED.encrypted_credential,
				model_id=EXCLUDED.model_id,
				status='connected',
				is_default=EXCLUDED.is_default,
				updated_at=now()`,
			generated, orgID, userID, endpoint, encryptedCredential, modelID, isDefault); err != nil {
			return aiConnectionRecord{}, err
		}
		return scanAIConnectionRow(tx.QueryRow(ctx, `SELECT `+aiConnectionColumns+`
			FROM coding_agent_connections WHERE org_id=$1::uuid AND user_id=$2::uuid AND provider='opencode'`, orgID, userID))
	})
}

func (s *pgAIConnectionStore) MarkAttention(ctx context.Context, orgID, connectionID string) error {
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `UPDATE coding_agent_connections
			SET status='needs_attention', is_default=false, updated_at=now() WHERE id=$1::uuid`, connectionID)
		return struct{}{}, err
	})
	return err
}

func (s *pgAIConnectionStore) UpsertCodex(ctx context.Context, orgID, userID string, makeDefault *bool) (aiConnectionRecord, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (aiConnectionRecord, error) {
		existing, err := aiConnectionExists(ctx, tx, orgID, userID, aiConnectionProviderCodex)
		if err != nil {
			return aiConnectionRecord{}, err
		}
		isDefault := !existing
		if makeDefault != nil {
			isDefault = *makeDefault
		}
		if isDefault {
			if _, err := tx.Exec(ctx, `UPDATE coding_agent_connections SET is_default=false, updated_at=now()
				WHERE org_id=$1::uuid AND user_id=$2::uuid AND is_default`, orgID, userID); err != nil {
				return aiConnectionRecord{}, err
			}
		}
		generated, err := newAIUUID()
		if err != nil {
			return aiConnectionRecord{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO coding_agent_connections
			(id, org_id, user_id, provider, endpoint, encrypted_credential, model_id, status, is_default, updated_at)
			VALUES ($1::uuid,$2::uuid,$3::uuid,'codex',NULL,NULL,NULL,'connected',$4,now())
			ON CONFLICT (org_id, user_id, provider) DO UPDATE SET
				status='connected', is_default=EXCLUDED.is_default, updated_at=now()`,
			generated, orgID, userID, isDefault); err != nil {
			return aiConnectionRecord{}, err
		}
		return scanAIConnectionRow(tx.QueryRow(ctx, `SELECT `+aiConnectionColumns+`
			FROM coding_agent_connections WHERE org_id=$1::uuid AND user_id=$2::uuid AND provider='codex'`, orgID, userID))
	})
}

func (s *pgAIConnectionStore) ChooseDefault(ctx context.Context, orgID, userID string, connectionID *string) error {
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		if _, err := tx.Exec(ctx, `UPDATE coding_agent_connections SET is_default=false, updated_at=now()
			WHERE org_id=$1::uuid AND user_id=$2::uuid AND is_default`, orgID, userID); err != nil {
			return struct{}{}, err
		}
		if connectionID == nil {
			return struct{}{}, nil
		}
		var found string
		err := tx.QueryRow(ctx, `SELECT id FROM coding_agent_connections
			WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid AND status='connected' FOR UPDATE`,
			*connectionID, orgID, userID).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, errAIChooseDefault
		}
		if err != nil {
			return struct{}{}, err
		}
		_, err = tx.Exec(ctx, `UPDATE coding_agent_connections SET is_default=true, updated_at=now() WHERE id=$1::uuid`, found)
		return struct{}{}, err
	})
	return err
}

func (s *pgAIConnectionStore) Lookup(ctx context.Context, orgID, userID, provider string) (aiConnectionRecord, bool, error) {
	type lookupResult struct {
		record aiConnectionRecord
		found  bool
	}
	result, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (lookupResult, error) {
		record, err := scanAIConnectionRow(tx.QueryRow(ctx, `SELECT `+aiConnectionColumns+`
			FROM coding_agent_connections
			WHERE org_id=$1::uuid AND user_id=$2::uuid AND provider=$3 LIMIT 1`, orgID, userID, provider))
		if errors.Is(err, pgx.ErrNoRows) {
			return lookupResult{}, nil
		}
		if err != nil {
			return lookupResult{}, err
		}
		return lookupResult{record: record, found: true}, nil
	})
	return result.record, result.found, err
}

func (s *pgAIConnectionStore) MarkDisconnected(ctx context.Context, orgID, connectionID string) error {
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `UPDATE coding_agent_connections
			SET status='disconnected', is_default=false, encrypted_credential=NULL, updated_at=now()
			WHERE id=$1::uuid`, connectionID)
		return struct{}{}, err
	})
	return err
}

func aiConnectionExists(ctx context.Context, tx pgx.Tx, orgID, userID, provider string) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM coding_agent_connections
		WHERE org_id=$1::uuid AND user_id=$2::uuid AND provider=$3)`, orgID, userID, provider).Scan(&exists)
	return exists, err
}

// ── Local Codex device-login runtime ──

type localAICodexRuntime struct {
	mu        sync.Mutex
	processes map[string]*exec.Cmd
	states    map[string]*aiCodexLoginState
}

func newLocalAICodexRuntime() *localAICodexRuntime {
	return &localAICodexRuntime{
		processes: map[string]*exec.Cmd{},
		states:    map[string]*aiCodexLoginState{},
	}
}

func aiCodexBinary() string {
	if value := strings.TrimSpace(os.Getenv("CODEX_BIN")); value != "" {
		return value
	}
	return "codex"
}

func aiCodexHome(orgID, userID string) (string, error) {
	base := strings.TrimSpace(os.Getenv("CHASTE_CODEX_CONNECTION_HOME"))
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			home, _ = os.Getwd()
		}
		base = filepath.Join(home, ".chaste", "codex-connections")
	}
	digest := sha256.Sum256([]byte(orgID + ":" + userID))
	return filepath.Join(strings.TrimRight(base, "/"), hex.EncodeToString(digest[:])), nil
}

func (c *localAICodexRuntime) Probe() (bool, *string) {
	command := exec.Command(aiCodexBinary(), "--version")
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return false, nil
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return false, nil
		}
		version := strings.TrimSpace(stdout.String())
		if len(version) > 80 {
			version = version[:80]
		}
		if version == "" {
			return true, nil
		}
		return true, &version
	case <-time.After(2500 * time.Millisecond):
		_ = command.Process.Kill()
		return false, nil
	}
}

func (c *localAICodexRuntime) Start(ctx context.Context, orgID, userID string) (aiCodexLoginState, error) {
	available, _ := c.Probe()
	if !available {
		return aiCodexLoginState{}, errors.New("Codex CLI is not installed for this server. Set CODEX_BIN to its executable path.")
	}
	home, err := aiCodexHome(orgID, userID)
	if err != nil {
		return aiCodexLoginState{}, err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return aiCodexLoginState{}, err
	}
	_ = os.Chmod(home, 0o700)
	key := orgID + ":" + userID
	c.mu.Lock()
	if current := c.processes[key]; current != nil && current.Process != nil {
		_ = current.Process.Kill()
	}
	command := exec.Command(aiCodexBinary(), "login", "--device-auth")
	command.Env = append(os.Environ(), "CODEX_HOME="+home)
	stdout, err := command.StdoutPipe()
	if err != nil {
		c.mu.Unlock()
		return aiCodexLoginState{}, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		c.mu.Unlock()
		return aiCodexLoginState{}, err
	}
	if err := command.Start(); err != nil {
		c.mu.Unlock()
		return aiCodexLoginState{}, err
	}
	state := &aiCodexLoginState{}
	c.processes[key] = command
	c.states[key] = state
	c.mu.Unlock()
	update := newAICodexOutputUpdater(c, state)
	go update(stdout)
	go update(stderr)
	exited := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(exited)
		c.mu.Lock()
		if c.processes[key] == command {
			delete(c.processes, key)
		}
		c.mu.Unlock()
	}()
	select {
	case <-time.After(900 * time.Millisecond):
	case <-exited:
		return aiCodexLoginState{}, errors.New("Codex closed the login flow before returning a device code.")
	case <-ctx.Done():
	}
	c.mu.Lock()
	snapshot := *state
	c.mu.Unlock()
	return snapshot, nil
}

func newAICodexOutputUpdater(runtime *localAICodexRuntime, state *aiCodexLoginState) func(io.Reader) {
	var mu sync.Mutex
	var buffer strings.Builder
	return func(reader io.Reader) {
		chunk := make([]byte, 4096)
		for {
			count, err := reader.Read(chunk)
			if count > 0 {
				mu.Lock()
				buffer.Write(chunk[:count])
				text := buffer.String()
				if len(text) > 8000 {
					text = text[len(text)-8000:]
				}
				buffer.Reset()
				buffer.WriteString(text)
				verificationURL, userCode := parseAICodexLoginOutput(text)
				mu.Unlock()
				runtime.mu.Lock()
				if verificationURL != nil {
					state.VerificationURL = verificationURL
				}
				if userCode != nil {
					state.UserCode = userCode
				}
				runtime.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}
}

func (c *localAICodexRuntime) Poll(ctx context.Context, orgID, userID string) (bool, aiCodexLoginState, error) {
	home, err := aiCodexHome(orgID, userID)
	if err != nil {
		return false, aiCodexLoginState{}, err
	}
	statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(statusCtx, aiCodexBinary(), "login", "status")
	command.Env = append(os.Environ(), "CODEX_HOME="+home)
	output, err := command.Output()
	statusText := string(output)
	if err != nil || !aicCodexLoggedInPattern.MatchString(statusText) || aicCodexNotLoggedInPattern.MatchString(statusText) {
		key := orgID + ":" + userID
		c.mu.Lock()
		snapshot := aiCodexLoginState{}
		if current := c.states[key]; current != nil {
			snapshot = *current
		}
		c.mu.Unlock()
		return false, snapshot, nil
	}
	c.mu.Lock()
	delete(c.states, orgID+":"+userID)
	c.mu.Unlock()
	return true, aiCodexLoginState{}, nil
}

func (c *localAICodexRuntime) Stop(ctx context.Context, orgID, userID string) {
	key := orgID + ":" + userID
	c.mu.Lock()
	if current := c.processes[key]; current != nil && current.Process != nil {
		_ = current.Process.Kill()
	}
	delete(c.states, key)
	c.mu.Unlock()
	home, err := aiCodexHome(orgID, userID)
	if err != nil {
		return
	}
	logoutCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(logoutCtx, aiCodexBinary(), "logout")
	command.Env = append(os.Environ(), "CODEX_HOME="+home)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	_ = command.Run()
	_ = os.RemoveAll(home)
}

var (
	aicCodexANSIPattern         = regexp.MustCompile("\x1b\\[[0-9;]*m")
	aicCodexVerificationPattern = regexp.MustCompile(`(?i)https://[a-z0-9./_-]*(?:device|activate|login)[a-z0-9./?=_-]*`)
	aicCodexUserCodePattern     = regexp.MustCompile(`(?i)(?:code\s*[:：]?\s*)([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)`)
	aicCodexLoggedInPattern     = regexp.MustCompile(`(?i)logged in|authenticated`)
	aicCodexNotLoggedInPattern  = regexp.MustCompile(`(?i)not logged in|not authenticated`)
)

func parseAICodexLoginOutput(text string) (*string, *string) {
	plain := aicCodexANSIPattern.ReplaceAllString(text, "")
	var verificationURL *string
	if match := aicCodexVerificationPattern.FindString(plain); match != "" {
		verificationURL = &match
	}
	var userCode *string
	if match := aicCodexUserCodePattern.FindStringSubmatch(plain); len(match) > 1 && match[1] != "" {
		value := match[1]
		userCode = &value
	}
	return verificationURL, userCode
}
