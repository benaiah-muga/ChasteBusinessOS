package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
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
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
)

const myWorkBriefSystemPrompt = "You write a two-sentence brief of a business team's pending work for its home page. Group what belongs together, name concrete counts, never invent items that are not in the list, never give advice."

const (
	myWorkBriefMaxBodyBytes      = 1 << 20
	myWorkBriefMaxCardFieldUnits = 4096
	myWorkBriefMaxPromptUnits    = 32000
	myWorkBriefMaxCodexOutput    = 2 << 20
)

type myWorkSummaryConfig struct {
	provider     string
	baseURL      string
	apiKey       string
	fastModel    string
	primaryModel string
	codingAgent  *supportCodingAgentConnection
}

type myWorkSummaryConfigReader interface {
	LoadForOrg(context.Context, string, string) (myWorkSummaryConfig, error)
	RecordCodingAgentUsage(context.Context, string, string, string, int64, int64) error
}

type myWorkSummaryModel interface {
	Brief(context.Context, myWorkSummaryConfig, string, string) (string, error)
	CodingAgentBrief(context.Context, supportCodingAgentConnection, string, string) (string, int64, int64, error)
}

type MyWorkSummarySessionHandler struct {
	resolver myWorkSessionResolver
	config   myWorkSummaryConfigReader
	model    myWorkSummaryModel
	logger   *slog.Logger
}

// NewMyWorkSummarySessionHandler creates the authenticated Go handler for the
// work brief. Workspace credentials are loaded and decrypted only on the API.
func NewMyWorkSummarySessionHandler(resolver myWorkSessionResolver, config myWorkSummaryConfigReader, model myWorkSummaryModel, logger *slog.Logger) http.Handler {
	if model == nil {
		model = newOpenAIWorkSummaryModel()
	}
	return &MyWorkSummarySessionHandler{resolver: resolver, config: config, model: model, logger: logger}
}

type myWorkBriefCard struct {
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

type myWorkBriefInput struct {
	Cards []myWorkBriefCard `json:"cards"`
}

func (h *MyWorkSummarySessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.config == nil || h.model == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "summary unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	input, ok := decodeMyWorkBriefInput(w, r)
	if !ok {
		return
	}
	lines := make([]string, len(input.Cards))
	for index, card := range input.Cards {
		if utf16Length(card.Kind) > myWorkBriefMaxCardFieldUnits || utf16Length(card.Title) > myWorkBriefMaxCardFieldUnits || utf16Length(card.Detail) > myWorkBriefMaxCardFieldUnits {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "card text is too long"})
			return
		}
		lines[index] = fmt.Sprintf("- [%s] %s: %s", card.Kind, card.Title, card.Detail)
	}
	if utf16Length(myWorkBriefPrompt(lines)) > myWorkBriefMaxPromptUnits {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "card text is too long"})
		return
	}
	config, err := h.config.LoadForOrg(r.Context(), *resolved.OrgID, resolved.UserID)
	if err != nil {
		if h.logger != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.logger.Error("Go my work summary configuration read failed", "organizationId", *resolved.OrgID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "summary unavailable"})
		return
	}
	if config.codingAgent != nil {
		brief, inputTokens, outputTokens, err := h.model.CodingAgentBrief(r.Context(), *config.codingAgent, myWorkBriefSystemPrompt, myWorkBriefPrompt(lines))
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "summary unavailable", "detail": safeCodingAgentSummaryError(err)})
			return
		}
		if err := h.config.RecordCodingAgentUsage(r.Context(), *resolved.OrgID, resolved.UserID, config.codingAgent.connectionID, inputTokens, outputTokens); err != nil {
			if h.logger != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				h.logger.Error("Go my work summary coding-agent usage update failed", "organizationId", *resolved.OrgID, "userId", resolved.UserID, "error", err)
			}
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "summary unavailable", "detail": "the selected coding-agent connection could not record usage"})
			return
		}
		brief = strings.TrimSpace(brief)
		if brief == "" {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "summary unavailable"})
			return
		}
		model := config.codingAgent.provider + ":" + config.codingAgent.modelID
		if config.codingAgent.modelID == "" {
			model = config.codingAgent.provider + ":plan-default"
		}
		writeJSON(w, http.StatusOK, map[string]string{"brief": brief, "model": model})
		return
	}
	if strings.TrimSpace(config.apiKey) == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "summary unavailable",
			"hint":  "no workspace model credential is configured; the ranked list itself does not depend on it",
		})
		return
	}
	brief, usedModel, err := h.briefWithFallback(r.Context(), config, myWorkBriefPrompt(lines))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "summary unavailable", "detail": safeMyWorkSummaryError(err)})
		return
	}
	if brief == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "summary unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"brief": brief, "model": stripMyWorkProviderPrefix(usedModel)})
}

func (h *MyWorkSummarySessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func decodeMyWorkBriefInput(w http.ResponseWriter, r *http.Request) (myWorkBriefInput, bool) {
	if r.ContentLength > myWorkBriefMaxBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
		return myWorkBriefInput{}, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, myWorkBriefMaxBodyBytes)
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
			return myWorkBriefInput{}, false
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cards are required"})
		return myWorkBriefInput{}, false
	}
	if !utf8.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cards are required"})
		return myWorkBriefInput{}, false
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil || raw == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cards are required"})
		return myWorkBriefInput{}, false
	}
	cardsRaw, exists := raw["cards"]
	var cards []json.RawMessage
	if !exists || json.Unmarshal(cardsRaw, &cards) != nil || len(cards) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cards are required"})
		return myWorkBriefInput{}, false
	}
	if len(cards) > 30 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many cards"})
		return myWorkBriefInput{}, false
	}
	input := myWorkBriefInput{Cards: make([]myWorkBriefCard, 0, len(cards))}
	for _, item := range cards {
		var fields map[string]json.RawMessage
		if json.Unmarshal(item, &fields) != nil || fields == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid card"})
			return myWorkBriefInput{}, false
		}
		var card myWorkBriefCard
		if !decodeMyWorkBriefString(fields, "kind", &card.Kind) || card.Kind == "" ||
			!decodeMyWorkBriefString(fields, "title", &card.Title) || card.Title == "" ||
			!decodeMyWorkBriefString(fields, "detail", &card.Detail) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid card"})
			return myWorkBriefInput{}, false
		}
		input.Cards = append(input.Cards, card)
	}
	return input, true
}

func myWorkBriefPrompt(lines []string) string {
	return "Pending work:\n" + strings.Join(lines, "\n")
}

func decodeMyWorkBriefString(fields map[string]json.RawMessage, key string, target *string) bool {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false
	}
	return json.Unmarshal(raw, target) == nil
}

func (h *MyWorkSummarySessionHandler) briefWithFallback(ctx context.Context, config myWorkSummaryConfig, prompt string) (string, string, error) {
	brief, err := h.model.Brief(ctx, config, config.fastModel, prompt)
	if err == nil && strings.TrimSpace(brief) != "" {
		return strings.TrimSpace(brief), config.fastModel, nil
	}
	if err != nil && !myWorkModelUnavailable(err) {
		return "", "", err
	}
	brief, fallbackErr := h.model.Brief(ctx, config, config.primaryModel, prompt)
	if fallbackErr != nil {
		return "", "", fallbackErr
	}
	if strings.TrimSpace(brief) == "" {
		return "", "", nil
	}
	return strings.TrimSpace(brief), config.primaryModel, nil
}

func myWorkModelUnavailable(err error) bool {
	var status interface{ StatusCode() int }
	if errors.As(err, &status) && status.StatusCode() == http.StatusNotFound {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"testing period", "no endpoints found", "not a valid model", "model_not_found"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func safeMyWorkSummaryError(err error) string {
	var status interface{ StatusCode() int }
	if errors.As(err, &status) {
		return fmt.Sprintf("model request failed (HTTP %d)", status.StatusCode())
	}
	return "model request failed"
}

func safeCodingAgentSummaryError(err error) string {
	message := strings.TrimSpace(err.Error())
	if message == "" || strings.Contains(strings.ToLower(message), "credential") || strings.Contains(strings.ToLower(message), "secret") || strings.Contains(strings.ToLower(message), "password") {
		return "the selected coding-agent connection is unavailable"
	}
	if len(message) > 240 {
		message = message[:240]
	}
	return message
}

func stripMyWorkProviderPrefix(model string) string {
	for _, provider := range []string{"openrouter", "groq", "mistral", "zai", "openai"} {
		prefix := provider + "/"
		if strings.HasPrefix(model, prefix) {
			return strings.TrimPrefix(model, prefix)
		}
	}
	return model
}

type myWorkSummaryProviderError struct {
	status  int
	message string
}

func (e myWorkSummaryProviderError) Error() string   { return e.message }
func (e myWorkSummaryProviderError) StatusCode() int { return e.status }

type openAIWorkSummaryModel struct {
}

func newOpenAIWorkSummaryModel() myWorkSummaryModel {
	return &openAIWorkSummaryModel{}
}

func (m *openAIWorkSummaryModel) Brief(ctx context.Context, config myWorkSummaryConfig, model, prompt string) (string, error) {
	endpoint, address, err := resolveWorkSummaryEndpoint(config.baseURL)
	if err != nil {
		return "", errors.New("configured model endpoint is invalid or outside the provider network trust boundary")
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/chat/completions"
	body, err := json.Marshal(map[string]any{
		"model": stripMyWorkProviderPrefix(model), "temperature": 0.2, "max_tokens": 220,
		"messages": []map[string]string{
			{"role": "system", "content": myWorkBriefSystemPrompt},
			{"role": "user", "content": prompt},
		},
	})
	if err != nil {
		return "", errors.New("could not encode model request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return "", errors.New("could not create model request")
	}
	request.Header.Set("Authorization", "Bearer "+config.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Title", "ChasteBusinessOS")
	client := newSupportPinnedHTTPClient(address, 35*time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("model request failed")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(responseBody) > 1<<20 {
		return "", errors.New("model response was invalid or too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var providerError struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(responseBody, &providerError)
		return "", myWorkSummaryProviderError{status: response.StatusCode, message: providerError.Error.Message}
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(responseBody, &completion); err != nil {
		return "", errors.New("model response was invalid")
	}
	if len(completion.Choices) == 0 {
		return "", nil
	}
	return strings.TrimSpace(completion.Choices[0].Message.Content), nil
}

func (m *openAIWorkSummaryModel) CodingAgentBrief(ctx context.Context, connection supportCodingAgentConnection, system, prompt string) (string, int64, int64, error) {
	if connection.provider == "codex" {
		return runCodexWorkSummary(ctx, connection, system, prompt)
	}
	if connection.provider != "opencode" {
		return "", 0, 0, fmt.Errorf("configured %s coding-agent connections are not supported for work summaries", connection.provider)
	}
	credential, err := decodeSupportOpenCodeCredential(connection.credential)
	if err != nil {
		return "", 0, 0, err
	}
	endpoint, address, err := resolveCodingPlanOpenCodeEndpoint(connection.endpoint)
	if err != nil {
		return "", 0, 0, err
	}
	client := newSupportPinnedHTTPClient(address, 185*time.Second)
	defer client.CloseIdleConnections()
	text, _, inputTokens, outputTokens, err := requestSupportOpenCodeReplyWithUsage(ctx, client, endpoint, credential, connection.modelID, []publicSupportChatMessage{
		{Role: "system", Content: system},
		{Role: "User", Content: prompt},
	})
	return text, inputTokens, outputTokens, err
}

func resolveCodingPlanOpenCodeEndpoint(value string) (*url.URL, string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint == nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, "", errors.New("OpenCode server address is invalid")
	}
	host := strings.ToLower(strings.TrimSuffix(endpoint.Hostname(), "."))
	localDev := myWorkSummaryDevelopmentMode() && (host == "localhost" || host == "127.0.0.1" || host == "::1")
	if (endpoint.Scheme != "https" && !(localDev && endpoint.Scheme == "http")) || strings.HasSuffix(host, ".internal") || (!localDev && !strings.Contains(host, ".") && net.ParseIP(host) == nil) {
		return nil, "", errors.New("OpenCode server address must use public HTTPS; local servers are allowed in development only")
	}
	addresses := []net.IP{}
	if ip := net.ParseIP(host); ip != nil {
		addresses = append(addresses, ip)
	} else {
		addresses, err = net.LookupIP(host)
		if err != nil || len(addresses) == 0 {
			return nil, "", errors.New("OpenCode server address did not resolve")
		}
	}
	for _, address := range addresses {
		if !localDev && !supportPublicIP(address) {
			return nil, "", errors.New("OpenCode address resolves to a non-public network")
		}
	}
	return endpoint, addresses[0].String(), nil
}

func resolveWorkSummaryEndpoint(value string) (*url.URL, string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint == nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, "", errors.New("model endpoint is invalid")
	}
	host := strings.ToLower(strings.TrimSuffix(endpoint.Hostname(), "."))
	localDev := myWorkSummaryDevelopmentMode() && (host == "localhost" || host == "127.0.0.1" || host == "::1")
	if (endpoint.Scheme != "https" && !(localDev && endpoint.Scheme == "http")) || strings.HasSuffix(host, ".internal") || (!localDev && !strings.Contains(host, ".") && net.ParseIP(host) == nil) {
		return nil, "", errors.New("model endpoint must use public HTTPS")
	}
	addresses := []net.IP{}
	if ip := net.ParseIP(host); ip != nil {
		addresses = append(addresses, ip)
	} else {
		addresses, err = net.LookupIP(host)
		if err != nil || len(addresses) == 0 {
			return nil, "", errors.New("model endpoint did not resolve")
		}
	}
	for _, address := range addresses {
		if !localDev && !supportPublicIP(address) {
			return nil, "", errors.New("model endpoint resolves to a non-public network")
		}
	}
	return endpoint, addresses[0].String(), nil
}

func myWorkSummaryDevelopmentMode() bool {
	if os.Getenv("GO_AUTH_MODE") == "production" || os.Getenv("NODE_ENV") == "production" {
		return false
	}
	return os.Getenv("GO_AUTH_MODE") == "development" || os.Getenv("NODE_ENV") == "development"
}

type codexWorkSummaryState struct {
	text        string
	completed   bool
	inputUsage  int64
	outputUsage int64
	failure     string
}

func codexWorkSummaryHome(orgID, userID string) (string, error) {
	if !isUUID(orgID) || !isUUID(userID) {
		return "", errors.New("Codex connection owner is invalid")
	}
	root := strings.TrimSpace(os.Getenv("CHASTE_CODEX_CONNECTION_HOME"))
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", errors.New("Codex connection home is unavailable")
		}
		root = filepath.Join(home, ".chaste", "codex-connections")
	} else if !filepath.IsAbs(root) {
		return "", errors.New("CHASTE_CODEX_CONNECTION_HOME must be an absolute path")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", errors.New("Codex connection home is invalid")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", errors.New("Codex connection home is not available in this runtime")
	}
	owner := sha256.Sum256([]byte(orgID + ":" + userID))
	home := filepath.Join(root, hex.EncodeToString(owner[:]))
	resolvedHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", errors.New("Codex account is not available in this runtime")
	}
	relative, err := filepath.Rel(root, resolvedHome)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("Codex account home is outside its configured connection directory")
	}
	info, err := os.Stat(resolvedHome)
	if err != nil || !info.IsDir() {
		return "", errors.New("Codex account home is not a directory")
	}
	return resolvedHome, nil
}

func codexWorkSummaryArgs(cwd, modelID string) ([]string, error) {
	if len(modelID) > 200 || strings.ContainsAny(modelID, "\r\n\t ") || strings.HasPrefix(modelID, "-") {
		return nil, errors.New("configured Codex model identifier is invalid")
	}
	args := []string{
		"exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
		"--skip-git-repo-check", "--sandbox", "read-only", "--cd", cwd,
	}
	if modelID != "" {
		args = append(args, "--model", modelID)
	}
	for _, key := range []string{
		"features.shell_tool", "features.web_search_request", "features.plugins", "features.multi_agent",
		"features.view_image", "features.image_generation", "features.browser_use", "features.computer_use", "features.memory_tool",
	} {
		args = append(args, "-c", key+"=false")
	}
	args = append(args, "-")
	return args, nil
}

func codexWorkSummaryPrompt(system, prompt string) string {
	return "SYSTEM INSTRUCTIONS\n" + system + "\n\nUSER\n" + prompt
}

func runCodexWorkSummary(ctx context.Context, connection supportCodingAgentConnection, system, prompt string) (string, int64, int64, error) {
	if connection.provider != "codex" {
		return "", 0, 0, errors.New("Codex connection provider is invalid")
	}
	codeHome, err := codexWorkSummaryHome(connection.orgID, connection.userID)
	if err != nil {
		return "", 0, 0, err
	}
	workDir, err := os.MkdirTemp("", "chaste-codex-summary-")
	if err != nil {
		return "", 0, 0, errors.New("Codex summary workspace could not be created")
	}
	defer os.RemoveAll(workDir)
	if err := os.Chmod(workDir, 0o700); err != nil {
		return "", 0, 0, errors.New("Codex summary workspace permissions could not be set")
	}
	command := strings.TrimSpace(os.Getenv("CODEX_BIN"))
	if command == "" {
		command = "codex"
	}
	binary, err := exec.LookPath(command)
	if err != nil {
		return "", 0, 0, errors.New("Codex is not installed in the Go API runtime")
	}
	args, err := codexWorkSummaryArgs(workDir, connection.modelID)
	if err != nil {
		return "", 0, 0, err
	}
	runCtx, cancel := context.WithTimeout(ctx, 190*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, binary, args...)
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(codexWorkSummaryPrompt(system, prompt))
	cmd.Env = codexWorkSummaryEnvironment(codeHome)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", 0, 0, errors.New("Codex output could not be read")
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", 0, 0, errors.New("Codex diagnostics could not be read")
	}
	if err := cmd.Start(); err != nil {
		return "", 0, 0, errors.New("Codex could not start in the Go API runtime")
	}
	stdoutDone := make(chan []byte, 1)
	go func() {
		body, _ := io.ReadAll(io.LimitReader(stdout, myWorkBriefMaxCodexOutput+1))
		if len(body) > myWorkBriefMaxCodexOutput && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		stdoutDone <- body
	}()
	stderrDone := make(chan struct{}, 1)
	go func() {
		_, _ = io.Copy(io.Discard, stderr)
		stderrDone <- struct{}{}
	}()
	waitErr := cmd.Wait()
	body := <-stdoutDone
	<-stderrDone
	if runCtx.Err() != nil || waitErr != nil || len(body) > myWorkBriefMaxCodexOutput {
		return "", 0, 0, errors.New("Codex did not complete a work summary")
	}
	state := parseCodexWorkSummaryEvents(body)
	if !state.completed || state.failure != "" || strings.TrimSpace(state.text) == "" {
		return "", 0, 0, errors.New("Codex did not complete a work summary")
	}
	return strings.TrimSpace(state.text), state.inputUsage, state.outputUsage, nil
}

func parseCodexWorkSummaryEvents(body []byte) codexWorkSummaryState {
	var state codexWorkSummaryState
	for _, line := range bytes.Split(body, []byte("\n")) {
		var event struct {
			Type string `json:"type"`
			Item struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
			Usage struct {
				Input  int64 `json:"input_tokens"`
				Output int64 `json:"output_tokens"`
			} `json:"usage"`
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(line, &event) != nil {
			continue
		}
		switch event.Type {
		case "item.updated", "item.completed":
			if event.Item.Type == "agent_message" && len(event.Item.Text) >= len(state.text) {
				state.text = event.Item.Text
			}
		case "turn.completed":
			state.completed = true
			state.inputUsage, state.outputUsage = event.Usage.Input, event.Usage.Output
		case "turn.failed", "error":
			state.failure = "Codex did not complete a work summary"
			if event.Error.Message != "" || event.Message != "" {
				state.failure = "Codex reported a failed work summary"
			}
		}
	}
	if state.inputUsage < 0 {
		state.inputUsage = 0
	}
	if state.outputUsage < 0 {
		state.outputUsage = 0
	}
	return state
}

func codexWorkSummaryEnvironment(codeHome string) []string {
	keys := []string{"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"}
	env := make([]string, 0, len(keys)+1)
	for _, key := range keys {
		if value, exists := os.LookupEnv(key); exists {
			env = append(env, key+"="+value)
		}
	}
	return append(env, "CODEX_HOME="+codeHome)
}

type myWorkSummaryPostgresReader struct {
	pool dbx.Beginner
}

func NewMyWorkSummaryPostgresReader(pool dbx.Beginner) myWorkSummaryConfigReader {
	return &myWorkSummaryPostgresReader{pool: pool}
}

func (reader *myWorkSummaryPostgresReader) LoadForOrg(ctx context.Context, orgID, userID string) (myWorkSummaryConfig, error) {
	if reader == nil || reader.pool == nil || !isUUID(orgID) || !isUUID(userID) {
		return myWorkSummaryConfig{}, errors.New("my work summary configuration reader is unavailable")
	}
	var config myWorkSummaryConfig
	_, err := dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		var settings []byte
		if err := tx.QueryRow(ctx, `SELECT settings FROM organizations WHERE id=$1::uuid`, orgID).Scan(&settings); err != nil {
			return struct{}{}, err
		}
		var settingsObject map[string]json.RawMessage
		_ = json.Unmarshal(settings, &settingsObject)
		var stored *capability.SettingsAIProviderConfig
		if rawAI, ok := settingsObject["ai"]; ok && !bytes.Equal(bytes.TrimSpace(rawAI), []byte("null")) {
			stored, _ = capability.ParseStoredAIProviderConfig(rawAI)
		}
		if stored != nil {
			config.provider = stored.Provider
			config.baseURL = stored.BaseURL
			config.fastModel = stored.Models.Fast
			config.primaryModel = stored.Models.Primary
			if stored.EncryptedAPIKey != nil && strings.TrimSpace(*stored.EncryptedAPIKey) != "" {
				config.apiKey, _ = decryptSupportProviderKey(*stored.EncryptedAPIKey)
			}
		} else {
			config = environmentMyWorkSummaryConfig()
		}
		var connection supportCodingAgentConnection
		err := tx.QueryRow(ctx, `
			SELECT provider, COALESCE(endpoint, ''), COALESCE(encrypted_credential, ''),
			       COALESCE(model_id, ''), id::text
			FROM coding_agent_connections
			WHERE org_id=$1::uuid AND user_id=$2::uuid AND is_default=true AND status='connected'
			ORDER BY connected_at DESC, id
			LIMIT 1`, orgID, userID).Scan(
			&connection.provider, &connection.endpoint, &connection.credential, &connection.modelID, &connection.connectionID,
		)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, err
		}
		if err == nil {
			connection.orgID = orgID
			connection.userID = userID
			config.codingAgent = &connection
		}
		return struct{}{}, nil
	})
	return config, err
}

func (reader *myWorkSummaryPostgresReader) RecordCodingAgentUsage(ctx context.Context, orgID, userID, connectionID string, inputTokens, outputTokens int64) error {
	if reader == nil || reader.pool == nil || !isUUID(orgID) || !isUUID(userID) || !isUUID(connectionID) || inputTokens < 0 || outputTokens < 0 {
		return errors.New("invalid coding-agent usage scope")
	}
	_, err := dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		tag, err := tx.Exec(ctx, `
			UPDATE coding_agent_connections
			SET run_count=run_count+1, input_tokens=input_tokens+$4, output_tokens=output_tokens+$5,
			    last_used_at=NOW(), updated_at=NOW()
			WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid AND status='connected'`,
			connectionID, orgID, userID, inputTokens, outputTokens)
		if err != nil {
			return struct{}{}, err
		}
		if tag.RowsAffected() != 1 {
			return struct{}{}, errors.New("coding-agent connection no longer exists for this user")
		}
		return struct{}{}, nil
	})
	return err
}

func environmentMyWorkSummaryConfig() myWorkSummaryConfig {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("MODEL_PROVIDER")))
	if provider == "" {
		provider = "nvidia"
	}
	baseURL := map[string]string{
		"nvidia":     envOrMyWork("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
		"openrouter": "https://openrouter.ai/api/v1", "groq": "https://api.groq.com/openai/v1",
		"mistral": "https://api.mistral.ai/v1", "zai": envOrMyWork("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4"),
		"openai": "https://api.openai.com/v1", "custom": os.Getenv("MODEL_BASE_URL"),
	}[provider]
	keyName := map[string]string{"nvidia": "NVIDIA_API_KEY", "openrouter": "OPENROUTER_API_KEY", "groq": "GROQ_API_KEY", "mistral": "MISTRAL_API_KEY", "zai": "ZAI_API_KEY", "openai": "OPENAI_API_KEY"}[provider]
	return myWorkSummaryConfig{
		provider: provider, baseURL: strings.TrimRight(baseURL, "/"), apiKey: strings.TrimSpace(os.Getenv(keyName)),
		fastModel:    envOrMyWork("MODEL_FAST", "meta/muse-glimmer-30b"),
		primaryModel: envOrMyWork("MODEL_PRIMARY", "moonshotai/kimi-k2.6"),
	}
}

func envOrMyWork(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
