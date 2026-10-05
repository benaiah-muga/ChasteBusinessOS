package capability

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNVIDIAEmbeddingClientValidatesConfiguredRequestAndDimensions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/embeddings" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing provider authorization")
		}
		var request struct {
			Input     []string `json:"input"`
			InputType string   `json:"input_type"`
			Model     string   `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if len(request.Input) != 1 || request.InputType != "query" || request.Model != DefaultSupportEmbeddingModel {
			t.Errorf("unexpected embedding request: %+v", request)
		}
		vector := make([]float32, SupportKnowledgeEmbeddingDimension)
		for i := range vector {
			vector[i] = float32(i) / SupportKnowledgeEmbeddingDimension
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"index": 0, "embedding": vector}}})
	}))
	defer server.Close()

	client, err := NewNVIDIAEmbeddingClient("test-key")
	if err != nil {
		t.Fatal(err)
	}
	client.endpoint = server.URL + "/embeddings"
	vectors, err := client.Embed(context.Background(), DefaultSupportEmbeddingModel, "query", []string{"query: return policy"})
	if err != nil {
		t.Fatalf("Embed() error = %v", err)
	}
	if len(vectors) != 1 || len(vectors[0]) != SupportKnowledgeEmbeddingDimension {
		t.Fatalf("got vector shape %d/%d", len(vectors), len(vectors[0]))
	}
}

func TestNVIDIAEmbeddingClientRejectsWrongDimensionsAndMalformedIndexes(t *testing.T) {
	for _, tc := range []struct {
		name string
		data func() any
	}{
		{name: "short vector", data: func() any {
			return map[string]any{"index": 0, "embedding": make([]float32, SupportKnowledgeEmbeddingDimension-1)}
		}},
		{name: "duplicate index", data: func() any {
			vector := make([]float32, SupportKnowledgeEmbeddingDimension)
			return []any{map[string]any{"index": 0, "embedding": vector}, map[string]any{"index": 0, "embedding": vector}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				var data any
				switch value := tc.data().(type) {
				case []any:
					data = value
				default:
					data = []any{value}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
			}))
			defer server.Close()
			client, _ := NewNVIDIAEmbeddingClient("test-key")
			client.endpoint = server.URL
			if _, err := client.Embed(context.Background(), DefaultSupportEmbeddingModel, "passage", []string{"article"}); err == nil {
				t.Fatal("invalid provider vector unexpectedly accepted")
			}
		})
	}
}

func TestPublicSupportSemanticSearchUsesOnlyOrgPublicArticleVectors(t *testing.T) {
	tx := &publicSupportFakeTx{}
	vector := make([]float32, SupportKnowledgeEmbeddingDimension)
	vector[0] = 0.25
	output, err := publicSupportSemanticSearchKnowledge(context.Background(), tx, publicSupportOrgID, DefaultSupportEmbeddingModel, vector)
	if err != nil {
		t.Fatalf("publicSupportSemanticSearchKnowledge() error = %v", err)
	}
	if output.Mode != "semantic" || len(output.Results) != 1 || output.Results[0].Content != "Returns are accepted within 30 days." {
		t.Fatalf("unexpected semantic output: %+v", output)
	}
	query := strings.ToLower(tx.lastQuery)
	for _, required := range []string{"support_kb_article_embeddings", "a.is_public=true", "e.org_id=$1::uuid", "a.org_id=$1::uuid", "e.embedding_model=$2", "<=> $3::vector"} {
		if !strings.Contains(query, required) {
			t.Errorf("semantic SQL missing %q: %s", required, tx.lastQuery)
		}
	}
	if strings.Contains(query, "memories") {
		t.Fatal("public support search queried the private memories store")
	}
	if len(tx.lastQueryArgs) != 3 || tx.lastQueryArgs[0] != publicSupportOrgID || tx.lastQueryArgs[1] != DefaultSupportEmbeddingModel {
		t.Fatalf("semantic query arguments are not scoped/configured: %#v", tx.lastQueryArgs)
	}
	if got := tx.lastQueryArgs[2].(string); !strings.HasPrefix(got, "[0.25,") || !strings.HasSuffix(got, "]") {
		t.Fatalf("vector literal was not bound as a parameter: %.40q", got)
	}
}

type supportEmbeddingFunc func(context.Context, string, string, []string) ([][]float32, error)

func (embed supportEmbeddingFunc) Embed(ctx context.Context, model, inputType string, inputs []string) ([][]float32, error) {
	return embed(ctx, model, inputType, inputs)
}

func TestPublicSupportSemanticToolUsesConfiguredQueryEmbedding(t *testing.T) {
	pool := &publicSupportFakePool{tx: &publicSupportFakeTx{}}
	called := false
	embedder := supportEmbeddingFunc(func(_ context.Context, model, inputType string, inputs []string) ([][]float32, error) {
		called = true
		if model != "configured/model" || inputType != "query" || len(inputs) != 1 || inputs[0] != "query: refund window" {
			t.Fatalf("unexpected query embedding request: model=%q type=%q inputs=%#v", model, inputType, inputs)
		}
		vector := make([]float32, SupportKnowledgeEmbeddingDimension)
		return [][]float32{vector}, nil
	})
	result, err := RunPublicSupportReadToolWithEmbedding(
		context.Background(), pool, publicSupportOrgID, publicSupportConversationID,
		PublicSupportSearchKnowledgeTool, json.RawMessage(`{"query":"refund window"}`), "configured/model", embedder,
	)
	if err != nil {
		t.Fatalf("RunPublicSupportReadToolWithEmbedding() error = %v", err)
	}
	if !called {
		t.Fatal("configured embedding provider was not called")
	}
	var output SupportSearchKnowledgeOutput
	if err := json.Unmarshal(result, &output); err != nil || output.Mode != "semantic" {
		t.Fatalf("semantic tool returned unexpected output: %+v, err=%v", output, err)
	}
}

func TestSupportEmbeddingVectorLiteralRejectsDimensionMismatch(t *testing.T) {
	if _, err := supportEmbeddingVectorLiteral(make([]float32, SupportKnowledgeEmbeddingDimension-1)); err == nil {
		t.Fatal("wrong dimension unexpectedly accepted")
	}
	invalid := make([]float32, SupportKnowledgeEmbeddingDimension)
	invalid[0] = float32(math.Inf(1))
	if _, err := supportEmbeddingVectorLiteral(invalid); err == nil {
		t.Fatal("non-finite vector unexpectedly accepted")
	}
}

func TestSupportEmbeddingModelConfiguration(t *testing.T) {
	t.Setenv("GO_SUPPORT_EMBEDDING_MODEL", "  custom/embed-model  ")
	model, err := SupportEmbeddingModelFromEnv()
	if err != nil || model != "custom/embed-model" {
		t.Fatalf("model config = %q, %v", model, err)
	}
	t.Setenv("GO_SUPPORT_EMBEDDING_MODEL", "bad\nmodel")
	if _, err := SupportEmbeddingModelFromEnv(); err == nil {
		t.Fatal("invalid model configuration unexpectedly accepted")
	}
	client, err := NewNVIDIAEmbeddingClient(strings.Repeat("k", 4097))
	if err == nil || client != nil {
		t.Fatal("oversized API key unexpectedly accepted")
	}
}
