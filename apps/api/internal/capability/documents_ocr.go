package capability

import (
	"bytes"
	"context"
	"crypto/tls"
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
)

const documentsOCRPrompt = "</s><s><predict_bbox><predict_classes><output_markdown><predict_no_text_in_pic>"

type documentsImageParser interface {
	ParseDocumentImage(context.Context, string, []byte) (string, error)
}

type documentsOCRLookup func(context.Context, string) ([]net.IP, error)

type documentsOpenAICompatibleOCR struct {
	baseURL  string
	endpoint string
	apiKey   string
	model    string
	client   *http.Client
	lookup   documentsOCRLookup
}

func newDocumentsImageParserFromEnvironment() documentsImageParser {
	return newDocumentsImageParserFromEnv(os.Getenv)
}

func newDocumentsImageParserFromEnv(getenv func(string) string) documentsImageParser {
	provider := strings.ToLower(strings.TrimSpace(getenv("MODEL_PROVIDER")))
	if provider == "" {
		provider = "nvidia"
	}
	model := strings.TrimSpace(getenv("MODEL_OCR"))
	if model == "" {
		model = "nvidia/nemotron-parse-v1.2"
	}
	endpoints := map[string]string{
		"nvidia":     "https://integrate.api.nvidia.com/v1",
		"openrouter": "https://openrouter.ai/api/v1",
		"groq":       "https://api.groq.com/openai/v1",
		"mistral":    "https://api.mistral.ai/v1",
		"zai":        "https://api.z.ai/api/paas/v4",
		"openai":     "https://api.openai.com/v1",
	}
	keyNames := map[string]string{
		"nvidia": "NVIDIA_API_KEY", "openrouter": "OPENROUTER_API_KEY", "groq": "GROQ_API_KEY",
		"mistral": "MISTRAL_API_KEY", "zai": "ZAI_API_KEY", "openai": "OPENAI_API_KEY",
	}
	if provider == "nvidia" && strings.TrimSpace(getenv("NIM_BASE_URL")) != "" {
		endpoints[provider] = strings.TrimSpace(getenv("NIM_BASE_URL"))
	}
	if provider == "zai" && strings.TrimSpace(getenv("ZAI_BASE_URL")) != "" {
		endpoints[provider] = strings.TrimSpace(getenv("ZAI_BASE_URL"))
	}
	endpoint, supported := endpoints[provider]
	apiKey := strings.TrimSpace(getenv(keyNames[provider]))
	if !supported || apiKey == "" || len(apiKey) > 4096 || strings.ContainsAny(apiKey, "\r\n") || len(model) > 200 || strings.ContainsAny(model, "\r\n") {
		return nil
	}
	if _, err := parseDocumentsOCRBaseURL(endpoint); err != nil {
		return nil
	}
	return &documentsOpenAICompatibleOCR{
		baseURL: endpoint,
		apiKey:  apiKey,
		model:   model,
		lookup:  lookupDocumentsOCRIP,
	}
}

func parseDocumentsOCRBaseURL(value string) (*url.URL, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint == nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("OCR provider base URL must be an absolute HTTPS URL without credentials, query, or fragment")
	}
	if endpoint.Port() != "" && endpoint.Port() != "443" {
		return nil, errors.New("OCR provider base URL must use HTTPS port 443")
	}
	endpoint.Host = strings.ToLower(endpoint.Host)
	endpoint.Path = strings.TrimRight(endpoint.Path, "/")
	return endpoint, nil
}

func lookupDocumentsOCRIP(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	addresses, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		ips = append(ips, address)
	}
	return ips, nil
}

func resolveDocumentsOCRBaseURL(ctx context.Context, value string, lookup documentsOCRLookup) (*url.URL, net.IP, error) {
	endpoint, err := parseDocumentsOCRBaseURL(value)
	if err != nil {
		return nil, nil, err
	}
	if lookup == nil {
		lookup = lookupDocumentsOCRIP
	}
	host := strings.TrimSuffix(strings.ToLower(endpoint.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".internal") || (!strings.Contains(host, ".") && net.ParseIP(host) == nil) {
		return nil, nil, errors.New("OCR provider endpoint is outside the public network trust boundary")
	}
	addresses, err := lookup(ctx, host)
	if err != nil || len(addresses) == 0 {
		return nil, nil, errors.New("OCR provider endpoint did not resolve")
	}
	for _, address := range addresses {
		if !documentsOCRPublicIP(address) {
			return nil, nil, errors.New("OCR provider endpoint resolved outside the public network")
		}
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/chat/completions"
	return endpoint, addresses[0], nil
}

func documentsOCRPublicIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		for _, cidr := range []string{
			"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
			"198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
		} {
			_, network, _ := net.ParseCIDR(cidr)
			if network.Contains(v4) {
				return false
			}
		}
		return true
	}
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

func newDocumentsOCRPinnedHTTPClient(host string, ip net.IP) *http.Client {
	transport := &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			requestedHost, requestedPort, err := net.SplitHostPort(address)
			if err != nil || !strings.EqualFold(requestedHost, host) || requestedPort != "443" || !documentsOCRPublicIP(ip) {
				return nil, errors.New("OCR provider connection is outside the configured trust boundary")
			}
			dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), "443"))
		},
	}
	return &http.Client{
		Timeout:   60 * time.Second,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("OCR provider redirects are not allowed")
		},
	}
}

func (client *documentsOpenAICompatibleOCR) ParseDocumentImage(ctx context.Context, mimeType string, image []byte) (string, error) {
	if client == nil || client.apiKey == "" || client.model == "" || client.endpoint == "" && client.baseURL == "" {
		return "", errors.New("OCR provider is not configured")
	}
	if !documentsMIMETypePattern.MatchString(mimeType) || len(image) == 0 || len(image) > documentsMaxUploadBytes {
		return "", errors.New("uploaded document is invalid")
	}
	endpoint := client.endpoint
	httpClient := client.client
	if endpoint == "" {
		resolved, ip, err := resolveDocumentsOCRBaseURL(ctx, client.baseURL, client.lookup)
		if err != nil {
			return "", err
		}
		endpoint = resolved.String()
		httpClient = newDocumentsOCRPinnedHTTPClient(resolved.Hostname(), ip)
	}
	if httpClient == nil {
		return "", errors.New("OCR provider HTTP client is unavailable")
	}
	body, err := json.Marshal(map[string]any{
		"model":       client.model,
		"temperature": 0,
		"messages": []any{map[string]any{
			"role": "user",
			"content": []any{
				map[string]string{"type": "text", "text": documentsOCRPrompt},
				map[string]any{"type": "image_url", "image_url": map[string]string{
					"url": "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(image),
				}},
			},
		}},
	})
	if err != nil {
		return "", errors.New("could not encode OCR request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", errors.New("could not create OCR request")
	}
	request.Header.Set("Authorization", "Bearer "+client.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := httpClient.Do(request)
	if err != nil {
		return "", errors.New("OCR provider request failed")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(responseBody) > 4<<20 {
		return "", errors.New("OCR provider response was invalid or too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("OCR provider returned HTTP %d", response.StatusCode)
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(responseBody, &completion); err != nil {
		return "", errors.New("OCR provider response was invalid")
	}
	if len(completion.Choices) == 0 {
		return "", nil
	}
	return completion.Choices[0].Message.Content, nil
}

type documentsOCRContextKey struct{}

func withDocumentsImageParser(ctx context.Context, parser documentsImageParser) context.Context {
	return context.WithValue(ctx, documentsOCRContextKey{}, parser)
}

func documentsImageParserFromContext(ctx context.Context) documentsImageParser {
	parser, _ := ctx.Value(documentsOCRContextKey{}).(documentsImageParser)
	return parser
}
