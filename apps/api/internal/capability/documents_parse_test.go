package capability

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type documentsImageParserFunc func(context.Context, string, []byte) (string, error)

func (parse documentsImageParserFunc) ParseDocumentImage(ctx context.Context, mimeType string, image []byte) (string, error) {
	return parse(ctx, mimeType, image)
}

type documentsTestEmbedder struct {
	model     string
	input     string
	inputType string
	vector    []float32
}

func (embedder *documentsTestEmbedder) Embed(_ context.Context, model, inputType string, inputs []string) ([][]float32, error) {
	embedder.model = model
	embedder.inputType = inputType
	if len(inputs) == 1 {
		embedder.input = inputs[0]
	}
	return [][]float32{embedder.vector}, nil
}

func TestParseDocumentInput(t *testing.T) {
	input, err := parseDocumentInput(json.RawMessage(`{"documentId":"doc-123","ignored":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.DocumentID == nil || *input.DocumentID != "doc-123" {
		t.Fatalf("documentId = %v, want doc-123", input.DocumentID)
	}

	for _, raw := range []string{`null`, `[]`, `{}`, `{"documentId":null}`, `{"documentId":1}`} {
		t.Run(raw, func(t *testing.T) {
			if _, err := parseDocumentInput(json.RawMessage(raw)); err == nil {
				t.Fatalf("parseDocumentInput(%s) accepted invalid input", raw)
			}
		})
	}
}

func TestDocumentsParseMemoryContentUsesUTF16Limit(t *testing.T) {
	input := strings.Repeat("a", 7999) + "🧾" + "truncated"
	got := documentsParseMemoryContent(input)
	if documentsParseJSLength(got) != 7999 || got != strings.Repeat("a", 7999) {
		t.Fatalf("memory content length=%d suffix=%q, want 7999 UTF-16 units without splitting a surrogate pair", documentsParseJSLength(got), got[7990:])
	}
}

func TestDocumentsParseEmbeddingUsesExactMarkdownAndConfiguredDimension(t *testing.T) {
	markdown := strings.Repeat("a", 7999) + "🧾" + "excluded"
	content := documentsParseMemoryContent(markdown)
	embedder := &documentsTestEmbedder{vector: []float32{0.1, -0.25, 1}}
	got := documentsParseEmbeddingWith(context.Background(), content, 3, "configured-model", embedder)
	if got != "[0.1,-0.25,1]" {
		t.Fatalf("embedding literal=%v", got)
	}
	if embedder.model != "configured-model" || embedder.inputType != "passage" || embedder.input != content {
		t.Fatalf("embedding request model=%q type=%q input length=%d, want exact markdown only", embedder.model, embedder.inputType, len(embedder.input))
	}
	if fallback := documentsParseEmbeddingWith(context.Background(), content, 3, "", nil); fallback != "[0,0,0]" {
		t.Fatalf("configured-dimension fallback=%v, want [0,0,0]", fallback)
	}
	if invalidDimension := documentsParseEmbeddingWith(context.Background(), content, 0, "", nil); invalidDimension != nil {
		t.Fatalf("invalid-dimension fallback=%v, want NULL embedding", invalidDimension)
	}
}

func TestDocumentsOCRRequestMatchesTypeScriptContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-only" {
			t.Errorf("authorization = %q", got)
		}
		var body struct {
			Model       string  `json:"model"`
			Temperature float64 `json:"temperature"`
			Messages    []struct {
				Role    string `json:"role"`
				Content []struct {
					Type     string `json:"type"`
					Text     string `json:"text"`
					ImageURL struct {
						URL string `json:"url"`
					} `json:"image_url"`
				} `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if body.Model != "nvidia/nemotron-parse-v1.2" || body.Temperature != 0 || len(body.Messages) != 1 || body.Messages[0].Role != "user" {
			t.Errorf("request model/temp/messages = %q/%v/%+v", body.Model, body.Temperature, body.Messages)
		}
		content := body.Messages[0].Content
		if len(content) != 2 || content[0].Type != "text" || content[0].Text != documentsOCRPrompt || content[1].Type != "image_url" || content[1].ImageURL.URL != "data:image/png;base64,"+base64.StdEncoding.EncodeToString([]byte("image-bytes")) {
			t.Errorf("request content = %+v", content)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"recognized markdown"}}]}`))
	}))
	defer server.Close()

	client := &documentsOpenAICompatibleOCR{
		endpoint: server.URL + "/chat/completions", apiKey: "test-only", model: "nvidia/nemotron-parse-v1.2", client: server.Client(),
	}
	got, err := client.ParseDocumentImage(context.Background(), "image/png", []byte("image-bytes"))
	if err != nil || got != "recognized markdown" {
		t.Fatalf("ParseDocumentImage() = %q, %v", got, err)
	}
}

func TestDocumentsOCRProviderConfigMatchesChatClientSelection(t *testing.T) {
	values := map[string]string{
		"MODEL_PROVIDER": "nvidia",
		"MODEL_OCR":      "zai/nemotron-parse-v1.2",
		"NVIDIA_API_KEY": "test-key",
		"NIM_BASE_URL":   "https://nim.example/v1",
		"ZAI_BASE_URL":   "https://zai-proxy.example/api/paas/v4",
	}
	parser := newDocumentsImageParserFromEnv(func(name string) string { return values[name] })
	client, ok := parser.(*documentsOpenAICompatibleOCR)
	if !ok {
		t.Fatal("provider config did not produce an OCR client")
	}
	if client.model != "zai/nemotron-parse-v1.2" || client.baseURL != "https://nim.example/v1" {
		t.Fatalf("MODEL_PROVIDER-selected client base=%q model=%q, want NVIDIA base and unchanged model", client.baseURL, client.model)
	}

	values["MODEL_PROVIDER"] = "zai"
	values["ZAI_API_KEY"] = "test-zai-key"
	parser = newDocumentsImageParserFromEnv(func(name string) string { return values[name] })
	client, ok = parser.(*documentsOpenAICompatibleOCR)
	if !ok || client.baseURL != values["ZAI_BASE_URL"] || client.model != "zai/nemotron-parse-v1.2" {
		t.Fatalf("ZAI config=%+v, want configured ZAI base and unmodified MODEL_OCR", client)
	}
}

func TestDocumentsOCRBaseURLResolutionRejectsPrivateAddresses(t *testing.T) {
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		if host != "ocr.example" {
			t.Fatalf("lookup host=%q", host)
		}
		return []net.IP{net.ParseIP("203.0.113.12")}, nil
	}
	if _, _, err := resolveDocumentsOCRBaseURL(context.Background(), "https://ocr.example/v1", lookup); err == nil {
		t.Fatal("accepted documentation-range provider address")
	}
	lookup = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("8.8.8.8")}, nil }
	endpoint, ip, err := resolveDocumentsOCRBaseURL(context.Background(), "https://ocr.example/v1/", lookup)
	if err != nil || ip.String() != "8.8.8.8" || endpoint.String() != "https://ocr.example/v1/chat/completions" {
		t.Fatalf("resolved endpoint=%v ip=%v err=%v", endpoint, ip, err)
	}
	for _, value := range []string{"http://ocr.example/v1", "https://user:pass@ocr.example/v1", "https://ocr.example:8443/v1", "https://ocr.example/v1?x=y"} {
		if _, err := parseDocumentsOCRBaseURL(value); err == nil {
			t.Errorf("accepted unsafe base URL %q", value)
		}
	}
	if _, _, err := resolveDocumentsOCRBaseURL(context.Background(), "https://localhost/v1", nil); err == nil {
		t.Fatal("accepted localhost OCR provider endpoint")
	}
}
