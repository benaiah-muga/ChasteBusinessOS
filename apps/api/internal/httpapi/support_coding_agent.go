package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type supportCodingAgentConnection struct {
	provider     string
	endpoint     string
	credential   string
	modelID      string
	connectionID string
	orgID        string
	userID       string
}

type supportOpenCodeCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// draftSupportReplyWithCodingAgent uses the requested owner's default connected
// coding-agent connection. handled is true whenever such a connection exists,
// including unsupported or unusable connections, so callers must not silently
// fall back to workspace credentials after an error.
func draftSupportReplyWithCodingAgent(
	ctx context.Context,
	pool *pgxpool.Pool,
	orgID string,
	userID string,
	messages []publicSupportChatMessage,
) (reply string, handled bool, err error) {
	if pool == nil || !isUUID(orgID) || !isUUID(userID) {
		return "", false, errors.New("invalid support coding-agent owner")
	}
	var connection supportCodingAgentConnection
	_, err = dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		err := tx.QueryRow(ctx, `
			SELECT provider, COALESCE(endpoint, ''), COALESCE(encrypted_credential, ''),
			       COALESCE(model_id, ''), id::text
			FROM coding_agent_connections
			WHERE org_id = $1::uuid AND user_id = $2::uuid
			  AND is_default = true AND status = 'connected'
			ORDER BY connected_at DESC, id
			LIMIT 1`, orgID, userID).Scan(
			&connection.provider, &connection.endpoint, &connection.credential,
			&connection.modelID, &connection.connectionID,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, nil
		}
		return struct{}{}, err
	})
	if err != nil {
		return "", false, err
	}
	if connection.provider == "" {
		return "", false, nil
	}
	if connection.provider != "opencode" {
		return "", true, fmt.Errorf("configured %s coding-agent connections are not supported for public support replies", connection.provider)
	}
	credential, err := decodeSupportOpenCodeCredential(connection.credential)
	if err != nil {
		return "", true, err
	}
	base, address, err := resolveSupportOpenCodeEndpoint(connection.endpoint)
	if err != nil {
		return "", true, err
	}
	return requestSupportOpenCodeReply(ctx, base, address, credential, connection.modelID, messages)
}

func decodeSupportOpenCodeCredential(encrypted string) (supportOpenCodeCredential, error) {
	var credential supportOpenCodeCredential
	plain, err := decryptSupportProviderKey(encrypted)
	if err != nil {
		return credential, errors.New("OpenCode connection secret could not be decrypted. Reconnect this account.")
	}
	if err := json.Unmarshal([]byte(plain), &credential); err != nil || strings.TrimSpace(credential.Username) == "" || credential.Password == "" {
		return supportOpenCodeCredential{}, errors.New("OpenCode sign-in details are missing. Reconnect this account.")
	}
	return credential, nil
}

func decryptSupportProviderKey(value string) (string, error) {
	parts := strings.Split(value, ":")
	if len(parts) != 4 || parts[0] != "v1" {
		return "", errors.New("invalid encrypted provider key")
	}
	iv, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return "", err
	}
	secret := os.Getenv("AI_CONFIG_ENCRYPTION_KEY")
	if secret == "" {
		secret = os.Getenv("BETTER_AUTH_SECRET")
	}
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
	if len(iv) != gcm.NonceSize() || len(tag) != gcm.Overhead() {
		return "", errors.New("invalid encrypted provider key")
	}
	plain, err := gcm.Open(nil, iv, append(ciphertext, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func resolveSupportOpenCodeEndpoint(value string) (*url.URL, string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint == nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, "", errors.New("OpenCode support replies require a public HTTPS server address")
	}
	host := strings.ToLower(strings.TrimSuffix(endpoint.Hostname(), "."))
	if !strings.Contains(host, ".") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, "", errors.New("OpenCode support replies require a public HTTPS server address")
	}
	ip := net.ParseIP(host)
	if ip != nil {
		if !supportPublicIP(ip) {
			return nil, "", errors.New("OpenCode address resolves to a non-public network")
		}
		return endpoint, ip.String(), nil
	}
	addresses, err := net.LookupIP(host)
	if err != nil || len(addresses) == 0 {
		return nil, "", errors.New("OpenCode server address did not resolve")
	}
	for _, address := range addresses {
		if !supportPublicIP(address) {
			return nil, "", errors.New("OpenCode address resolves to a non-public network")
		}
	}
	return endpoint, addresses[0].String(), nil
}

func resolveSupportProviderEndpoint(value string) (*url.URL, string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint == nil || (endpoint.Port() != "" && endpoint.Port() != "443") {
		return nil, "", errors.New("support replies require a public HTTPS provider on port 443")
	}
	return resolveSupportOpenCodeEndpoint(value)
}

func newSupportPinnedHTTPClient(address string, timeout time.Duration) *http.Client {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addressWithPort string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addressWithPort)
			if err != nil {
				return nil, err
			}
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(address, port))
		},
		TLSHandshakeTimeout: 10 * time.Second,
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func supportPublicIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		// Exclude documentation, benchmarking, and other special-use ranges that
		// IsGlobalUnicast alone considers globally scoped.
		blocked := []struct {
			network string
			bits    int
		}{
			{"0.0.0.0", 8}, {"100.64.0.0", 10}, {"192.0.0.0", 24},
			{"192.0.2.0", 24}, {"198.18.0.0", 15}, {"198.51.100.0", 24},
			{"203.0.113.0", 24}, {"224.0.0.0", 4}, {"240.0.0.0", 4},
		}
		for _, entry := range blocked {
			_, network, _ := net.ParseCIDR(fmt.Sprintf("%s/%d", entry.network, entry.bits))
			if network.Contains(v4) {
				return false
			}
		}
		return true
	}
	// Globally routable IPv6 currently resides in 2000::/3. Excluding all
	// other ranges also blocks ULA, link-local, documentation, and mapped forms.
	_, globalIPv6, _ := net.ParseCIDR("2000::/3")
	if !globalIPv6.Contains(ip) {
		return false
	}
	for _, cidr := range []string{"2001:db8::/32", "2001:10::/28", "2001:20::/28"} {
		_, network, _ := net.ParseCIDR(cidr)
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func requestSupportOpenCodeReply(
	ctx context.Context,
	endpoint *url.URL,
	address string,
	credential supportOpenCodeCredential,
	modelID string,
	messages []publicSupportChatMessage,
) (string, bool, error) {
	client := newSupportPinnedHTTPClient(address, 45*time.Second)
	defer client.CloseIdleConnections()
	return requestSupportOpenCodeReplyWithClient(ctx, client, endpoint, credential, modelID, messages)
}

func requestSupportOpenCodeReplyWithClient(
	ctx context.Context,
	client *http.Client,
	endpoint *url.URL,
	credential supportOpenCodeCredential,
	modelID string,
	messages []publicSupportChatMessage,
) (string, bool, error) {
	text, handled, _, _, err := requestSupportOpenCodeReplyWithUsage(ctx, client, endpoint, credential, modelID, messages)
	return text, handled, err
}

func requestSupportOpenCodeReplyWithUsage(
	ctx context.Context,
	client *http.Client,
	endpoint *url.URL,
	credential supportOpenCodeCredential,
	modelID string,
	messages []publicSupportChatMessage,
) (string, bool, int64, int64, error) {
	model := strings.SplitN(modelID, "/", 2)
	var modelRef map[string]string
	if len(model) == 2 && model[0] != "" && model[1] != "" {
		modelRef = map[string]string{"providerID": model[0], "modelID": model[1]}
	} else if modelID != "" {
		return "", true, 0, 0, errors.New("configured OpenCode model identifier is invalid")
	}

	base := *endpoint
	base.Path = strings.TrimRight(base.Path, "/")
	createURL := base
	createURL.Path += "/session"
	created, err := supportOpenCodeRequest(ctx, client, createURL.String(), credential, http.MethodPost, map[string]any{"title": "Chaste support reply"})
	if err != nil {
		return "", true, 0, 0, err
	}
	var session struct {
		ID string `json:"id"`
	}
	if created.status < 200 || created.status >= 300 || json.Unmarshal(created.body, &session) != nil || !validSupportOpenCodeSessionID(session.ID) {
		return "", true, 0, 0, errors.New("OpenCode could not start a support reply session")
	}
	messageURL := base
	messageURL.Path += "/session/" + session.ID + "/message"
	var system, transcript strings.Builder
	for _, message := range messages {
		if message.Role == "system" {
			if system.Len() > 0 {
				system.WriteString("\n\n")
			}
			system.WriteString(message.Content)
			continue
		}
		if transcript.Len() > 0 {
			transcript.WriteString("\n\n")
		}
		transcript.WriteString(message.Role)
		transcript.WriteString(": ")
		transcript.WriteString(message.Content)
	}
	messageBody := map[string]any{
		"tools": map[string]bool{"*": false},
		"parts": []map[string]string{{"type": "text", "text": transcript.String()}},
	}
	if system.Len() > 0 {
		messageBody["system"] = system.String()
	}
	if modelRef != nil {
		messageBody["model"] = modelRef
	}
	response, err := supportOpenCodeRequest(ctx, client, messageURL.String(), credential, http.MethodPost, messageBody)
	deleteURL := base
	deleteURL.Path += "/session/" + session.ID
	_, _ = supportOpenCodeRequest(ctx, client, deleteURL.String(), credential, http.MethodDelete, nil)
	if err != nil {
		return "", true, 0, 0, err
	}
	var completion struct {
		Info struct {
			Role   string `json:"role"`
			Tokens struct {
				Input  int64 `json:"input"`
				Output int64 `json:"output"`
			} `json:"tokens"`
		} `json:"info"`
		Parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"parts"`
	}
	if response.status < 200 || response.status >= 300 || json.Unmarshal(response.body, &completion) != nil || completion.Info.Role != "assistant" {
		return "", true, 0, 0, errors.New("OpenCode could not complete the support reply")
	}
	var reply strings.Builder
	for _, part := range completion.Parts {
		if part.Type == "text" {
			reply.WriteString(part.Text)
		}
	}
	result := strings.TrimSpace(reply.String())
	if result == "" {
		return "", true, 0, 0, errors.New("OpenCode returned an empty support reply")
	}
	inputTokens, outputTokens := completion.Info.Tokens.Input, completion.Info.Tokens.Output
	if inputTokens < 0 {
		inputTokens = 0
	}
	if outputTokens < 0 {
		outputTokens = 0
	}
	return result, true, inputTokens, outputTokens, nil
}

func validSupportOpenCodeSessionID(value string) bool {
	if value == "" || len(value) > 200 {
		return false
	}
	for _, char := range value {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_' || char == '-') {
			return false
		}
	}
	return true
}

type supportOpenCodeResponse struct {
	status int
	body   []byte
}

func supportOpenCodeRequest(ctx context.Context, client *http.Client, target string, credential supportOpenCodeCredential, method string, body any) (supportOpenCodeResponse, error) {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return supportOpenCodeResponse{}, err
		}
		payload = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return supportOpenCodeResponse{}, err
	}
	request.SetBasicAuth(credential.Username, credential.Password)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return supportOpenCodeResponse{}, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return supportOpenCodeResponse{}, err
	}
	if len(responseBody) == 1<<20 {
		return supportOpenCodeResponse{}, errors.New("OpenCode response exceeded the size limit")
	}
	return supportOpenCodeResponse{status: response.StatusCode, body: responseBody}, nil
}
