package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const aiConfigBodyLimit = 64 << 10
const aiConfigCapabilityID = "settings.configureAiProvider"

type aiConfigReader interface {
	ReadAIConfig(context.Context, string) (json.RawMessage, error)
}

type pgAIConfigReader struct{ pool *pgxpool.Pool }

func (reader pgAIConfigReader) ReadAIConfig(ctx context.Context, orgID string) (json.RawMessage, error) {
	if reader.pool == nil {
		return nil, errors.New("AI config database unavailable")
	}
	return dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (json.RawMessage, error) {
		var raw json.RawMessage
		err := tx.QueryRow(ctx, `SELECT settings->'ai' FROM organizations WHERE id=$1::uuid`, orgID).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("organization not found")
		}
		return raw, err
	})
}

type aiConfigModels struct {
	Primary    string `json:"primary"`
	Fast       string `json:"fast"`
	Reasoning  string `json:"reasoning"`
	Embeddings string `json:"embeddings"`
}

type aiConfigDTO struct {
	Provider   string         `json:"provider"`
	BaseURL    string         `json:"baseUrl"`
	Models     aiConfigModels `json:"models"`
	Configured bool           `json:"configured"`
	KeyHint    *string        `json:"keyHint"`
	Source     string         `json:"source"`
}

type aiConfigBody struct {
	Provider  string          `json:"provider"`
	BaseURL   string          `json:"baseUrl"`
	Models    aiConfigModels  `json:"models"`
	APIKey    *string         `json:"apiKey"`
	ClearKey  *bool           `json:"clearApiKey"`
	IntentID  json.RawMessage `json:"intentId"`
	UpdatedAt string          `json:"updatedAt"`
}

type AIConfigSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	reader            aiConfigReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewAIConfigSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &AIConfigSessionHandler{resolver: resolver, executor: executor, reader: pgAIConfigReader{pool: pool}, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *AIConfigSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.reader == nil || (r.Method == http.MethodPost && handler.executor == nil) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AI configuration service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		handler.unauthorized(w)
		return
	}
	resolved, err := handler.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		handler.unauthorized(w)
		return
	}
	if r.Method == http.MethodGet {
		handler.read(w, r, resolved)
		return
	}
	if !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	handler.write(w, r, resolved)
}

func (handler *AIConfigSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	raw, err := handler.reader.ReadAIConfig(r.Context(), *resolved.OrgID)
	if err != nil {
		handler.fail(w, "read workspace AI configuration", err)
		return
	}
	dto := publicAIConfig(raw)
	writeJSON(w, http.StatusOK, dto)
}

func (handler *AIConfigSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, aiConfigBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body aiConfigBody
	if decoder.Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid model configuration"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid model configuration"})
		return
	}
	intentID, ok := parseProjectIntentID(body.IntentID)
	if !ok || !isUUID(intentID) || !validAIConfigTimestamp(body.UpdatedAt) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid model configuration"})
		return
	}
	if !validAIConfigBody(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid model configuration"})
		return
	}
	currentRaw, err := handler.reader.ReadAIConfig(r.Context(), *resolved.OrgID)
	if err != nil {
		handler.fail(w, "read workspace AI configuration", err)
		return
	}
	current, _ := parsePublicAIConfig(currentRaw)
	var key *string
	clear := body.ClearKey != nil && *body.ClearKey
	switch {
	case clear:
		key = nil
	case body.APIKey != nil && strings.TrimSpace(*body.APIKey) != "":
		plain := strings.TrimSpace(*body.APIKey)
		encrypted, encryptErr := encryptAIProviderKey(plain, *resolved.OrgID, intentID)
		if encryptErr != nil {
			handler.fail(w, "encrypt workspace AI credential", encryptErr)
			return
		}
		key = &encrypted
	case current != nil:
		key = current.EncryptedAPIKey
	}
	var hint *string
	if !clear {
		if body.APIKey != nil && strings.TrimSpace(*body.APIKey) != "" {
			hint = maskedAIKeyHint(strings.TrimSpace(*body.APIKey))
		} else if current != nil {
			if current.EncryptedAPIKey != nil {
				if plain, decryptErr := decryptAIProviderKey(*current.EncryptedAPIKey); decryptErr == nil {
					hint = maskedAIKeyHint(plain)
				}
			}
		}
	}
	config := &capability.SettingsAIProviderConfig{
		Provider: body.Provider, BaseURL: strings.TrimSpace(body.BaseURL), Models: settingsAIModelsTrim(body.Models),
		EncryptedAPIKey: key, KeyHint: hint, UpdatedAt: body.UpdatedAt,
	}
	input, err := json.Marshal(capability.SettingsConfigureAiProviderInput{Config: config})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if _, err := capability.ParseSettingsConfigureAiProviderInput(input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid model configuration"})
		return
	}
	claims := aiConfigSessionClaims(resolved, intentID, input)
	result, err := handler.executor.Execute(r.Context(), claims, aiConfigCapabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			handler.unauthorized(w)
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			handler.fail(w, "configure workspace AI provider", err)
		}
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason, "error": reason, "approvalId": result.ApprovalID})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return
	}
	raw, err := handler.reader.ReadAIConfig(r.Context(), *resolved.OrgID)
	if err != nil {
		handler.fail(w, "read saved workspace AI configuration", err)
		return
	}
	response := map[string]any{"ok": true}
	for key, value := range aiConfigDTOMap(publicAIConfig(raw)) {
		response[key] = value
	}
	writeJSON(w, http.StatusOK, response)
}

func validAIConfigTimestamp(value string) bool {
	if value == "" || !strings.HasSuffix(value, "Z") {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func maskedAIKeyHint(key string) *string {
	runes := []rune(key)
	visible := make([]rune, 0, 4)
	for i := len(runes) - 1; i >= 0 && len(visible) < 4; i-- {
		if unicode.IsPrint(runes[i]) {
			visible = append(visible, runes[i])
		}
	}
	if len(visible) == 0 {
		return nil
	}
	for left, right := 0, len(visible)-1; left < right; left, right = left+1, right-1 {
		visible[left], visible[right] = visible[right], visible[left]
	}
	hint := "••••" + string(visible)
	return &hint
}

func (handler *AIConfigSessionHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func (handler *AIConfigSessionHandler) fail(w http.ResponseWriter, action string, err error) {
	if handler.logger != nil {
		handler.logger.Error("Go AI config request failed", "action", action, "error", err)
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func aiConfigSessionClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: aiConfigCapabilityID, InputSHA256: inputHash, ActorID: &actorID, ActorType: "human",
		Permissions: permissions, AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func validAIConfigBody(body aiConfigBody) bool {
	providers := []string{"nvidia", "openrouter", "groq", "mistral", "zai", "openai", "deepseek", "custom"}
	if !slices.Contains(providers, body.Provider) || len(body.BaseURL) == 0 || utf16Length(body.BaseURL) > 500 ||
		strings.TrimSpace(body.Models.Primary) == "" || strings.TrimSpace(body.Models.Fast) == "" ||
		strings.TrimSpace(body.Models.Reasoning) == "" || strings.TrimSpace(body.Models.Embeddings) == "" {
		return false
	}
	if body.APIKey != nil && (utf16Length(strings.TrimSpace(*body.APIKey)) == 0 || utf16Length(strings.TrimSpace(*body.APIKey)) > 1000) {
		return false
	}
	return true
}

func settingsAIModelsTrim(models aiConfigModels) capability.SettingsAIModels {
	models.Primary = strings.TrimSpace(models.Primary)
	models.Fast = strings.TrimSpace(models.Fast)
	models.Reasoning = strings.TrimSpace(models.Reasoning)
	models.Embeddings = strings.TrimSpace(models.Embeddings)
	return capability.SettingsAIModels{Primary: models.Primary, Fast: models.Fast, Reasoning: models.Reasoning, Embeddings: models.Embeddings}
}

func aiConfigModelsFromSettings(models capability.SettingsAIModels) aiConfigModels {
	return aiConfigModels{Primary: models.Primary, Fast: models.Fast, Reasoning: models.Reasoning, Embeddings: models.Embeddings}
}

func publicAIConfig(raw json.RawMessage) aiConfigDTO {
	if config, err := parsePublicAIConfig(raw); err == nil && config != nil {
		var plain string
		configured := false
		if config.EncryptedAPIKey != nil {
			plain, err = decryptAIProviderKey(*config.EncryptedAPIKey)
			configured = err == nil && plain != ""
		}
		var hint *string
		if configured {
			hint = maskedAIKeyHint(plain)
		}
		return aiConfigDTO{Provider: config.Provider, BaseURL: config.BaseURL, Models: aiConfigModelsFromSettings(config.Models), Configured: configured, KeyHint: hint, Source: "workspace"}
	}
	provider := os.Getenv("MODEL_PROVIDER")
	if !slices.Contains([]string{"nvidia", "openrouter", "groq", "mistral", "zai", "openai", "deepseek", "custom"}, provider) {
		provider = "nvidia"
	}
	baseURL := map[string]string{
		"nvidia":     envOr("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
		"openrouter": "https://openrouter.ai/api/v1", "groq": "https://api.groq.com/openai/v1",
		"mistral": "https://api.mistral.ai/v1", "zai": envOr("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4"),
		"openai": "https://api.openai.com/v1", "deepseek": envOr("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
		"custom": "",
	}[provider]
	models := aiConfigModels{
		Primary: envOr("MODEL_PRIMARY", "moonshotai/kimi-k2.6"), Fast: envOr("MODEL_FAST", "meta/muse-glimmer-30b"),
		Reasoning: envOr("MODEL_REASONING", "nvidia/nemotron-3-ultra-550b-a55b"), Embeddings: envOr("MODEL_EMBEDDINGS", "nvidia/nv-embedqa-e5-v5"),
	}
	keyName := map[string]string{"nvidia": "NVIDIA_API_KEY", "openrouter": "OPENROUTER_API_KEY", "groq": "GROQ_API_KEY", "mistral": "MISTRAL_API_KEY", "zai": "ZAI_API_KEY", "openai": "OPENAI_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}[provider]
	key := os.Getenv(keyName)
	var hint *string
	if key != "" {
		hint = maskedAIKeyHint(key)
	}
	return aiConfigDTO{Provider: provider, BaseURL: baseURL, Models: models, Configured: key != "", KeyHint: hint, Source: "environment"}
}

func parsePublicAIConfig(raw json.RawMessage) (*capability.SettingsAIProviderConfig, error) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("stored AI configuration is invalid")
	}
	// The stored hint is display metadata only. Normalize it before schema
	// validation so stale or malformed hints cannot hide a usable config.
	fields["keyHint"] = json.RawMessage("null")
	normalized, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	return capability.ParseStoredAIProviderConfig(normalized)
}

func aiConfigDTOMap(dto aiConfigDTO) map[string]any {
	encoded, _ := json.Marshal(dto)
	var values map[string]any
	_ = json.Unmarshal(encoded, &values)
	return values
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func encryptAIProviderKey(plain, orgID, intentID string) (string, error) {
	secret := os.Getenv("AI_CONFIG_ENCRYPTION_KEY")
	if secret == "" {
		secret = os.Getenv("BETTER_AUTH_SECRET")
	}
	if secret == "" {
		return "", errors.New("AI config encryption secret is missing")
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
	nonceKey := sha256.Sum256(append([]byte("ai-config-nonce-v1\x00"), key[:]...))
	mac := hmac.New(sha256.New, nonceKey[:])
	_, _ = mac.Write([]byte("ai-config-v1\x00" + orgID + "\x00" + intentID + "\x00" + plain))
	nonce := mac.Sum(nil)[:gcm.NonceSize()]
	sealed := gcm.Seal(nil, nonce, []byte(plain), nil)
	tagSize := gcm.Overhead()
	ciphertext, tag := sealed[:len(sealed)-tagSize], sealed[len(sealed)-tagSize:]
	return "v1:" + base64.RawURLEncoding.EncodeToString(nonce) + ":" + base64.RawURLEncoding.EncodeToString(tag) + ":" + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func decryptAIProviderKey(value string) (string, error) {
	parts := strings.Split(value, ":")
	if len(parts) != 4 || parts[0] != "v1" {
		return "", errors.New("invalid encrypted provider key")
	}
	secret := os.Getenv("AI_CONFIG_ENCRYPTION_KEY")
	if secret == "" {
		secret = os.Getenv("BETTER_AUTH_SECRET")
	}
	if secret == "" {
		return "", errors.New("AI config encryption secret is missing")
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
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(nonce) != gcm.NonceSize() {
		return "", errors.New("invalid encrypted provider key")
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(tag) != gcm.Overhead() {
		return "", errors.New("invalid encrypted provider key")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return "", errors.New("invalid encrypted provider key")
	}
	returnValue, err := gcm.Open(nil, nonce, append(ciphertext, tag...), nil)
	if err != nil {
		return "", errors.New("invalid encrypted provider key")
	}
	return string(returnValue), nil
}
