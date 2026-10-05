package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const (
	SupportKnowledgeEmbeddingDimension = 1024
	DefaultSupportEmbeddingModel       = "nvidia/nv-embedqa-e5-v5"
	nvidiaEmbeddingEndpoint            = "https://integrate.api.nvidia.com/v1/embeddings"
)

// SupportKnowledgeEmbedder is intentionally separate from general org memory
// retrieval. Public support can only embed the caller-supplied query or article
// content selected from support_kb_articles.
type SupportKnowledgeEmbedder interface {
	Embed(context.Context, string, string, []string) ([][]float32, error)
}

type NVIDIAEmbeddingClient struct {
	apiKey   string
	client   *http.Client
	endpoint string
}

func NewNVIDIAEmbeddingClient(apiKey string) (*NVIDIAEmbeddingClient, error) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" || len(apiKey) > 4096 || strings.ContainsAny(apiKey, "\r\n") {
		return nil, errors.New("NVIDIA embedding API key is invalid")
	}
	return &NVIDIAEmbeddingClient{
		apiKey:   apiKey,
		endpoint: nvidiaEmbeddingEndpoint,
		client: &http.Client{
			Timeout: 20 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("embedding endpoint redirects are not allowed")
			},
		},
	}, nil
}

func SupportEmbeddingModelFromEnv() (string, error) {
	model := strings.TrimSpace(os.Getenv("GO_SUPPORT_EMBEDDING_MODEL"))
	if model == "" {
		model = DefaultSupportEmbeddingModel
	}
	if len(model) > 200 || strings.ContainsAny(model, "\r\n") {
		return "", errors.New("GO_SUPPORT_EMBEDDING_MODEL is invalid")
	}
	return model, nil
}

func SupportEmbeddingClientFromEnv() (*NVIDIAEmbeddingClient, error) {
	return NewNVIDIAEmbeddingClient(os.Getenv("NVIDIA_API_KEY"))
}

func (c *NVIDIAEmbeddingClient) Embed(ctx context.Context, model, inputType string, inputs []string) ([][]float32, error) {
	if c == nil || c.client == nil || model == "" || len(model) > 200 || strings.ContainsAny(model, "\r\n") || len(inputs) < 1 || len(inputs) > 128 {
		return nil, errors.New("support embedding request is invalid")
	}
	if inputType != "query" && inputType != "passage" {
		return nil, errors.New("support embedding input type is invalid")
	}
	for _, input := range inputs {
		if strings.TrimSpace(input) == "" || len(input) > 32<<10 {
			return nil, errors.New("support embedding input is invalid")
		}
	}
	body, err := json.Marshal(map[string]any{
		"input": inputs, "input_type": inputType, "model": model, "encoding_format": "float",
	})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("embedding provider returned HTTP %d", response.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var result struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &result); err != nil || len(result.Data) != len(inputs) {
		return nil, errors.New("embedding provider returned an invalid response")
	}
	vectors := make([][]float32, len(inputs))
	seen := make([]bool, len(inputs))
	for _, item := range result.Data {
		if item.Index < 0 || item.Index >= len(inputs) || seen[item.Index] || !validSupportEmbedding(item.Embedding) {
			return nil, errors.New("embedding provider returned an invalid vector")
		}
		seen[item.Index] = true
		vectors[item.Index] = item.Embedding
	}
	for _, present := range seen {
		if !present {
			return nil, errors.New("embedding provider omitted a vector")
		}
	}
	return vectors, nil
}

func validSupportEmbedding(vector []float32) bool {
	if len(vector) != SupportKnowledgeEmbeddingDimension {
		return false
	}
	for _, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return false
		}
	}
	return true
}

func supportEmbeddingVectorLiteral(vector []float32) (string, error) {
	if !validSupportEmbedding(vector) {
		return "", errors.New("support embedding has an invalid dimension or value")
	}
	var builder strings.Builder
	builder.WriteByte('[')
	for index, value := range vector {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(strconv.FormatFloat(float64(value), 'f', -1, 32))
	}
	builder.WriteByte(']')
	return builder.String(), nil
}

func publicSupportSemanticSearchKnowledge(ctx context.Context, tx pgx.Tx, orgID string, model string, vector []float32) (SupportSearchKnowledgeOutput, error) {
	literal, err := supportEmbeddingVectorLiteral(vector)
	if err != nil {
		return SupportSearchKnowledgeOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT a.title, a.body
		FROM support_kb_article_embeddings e
		JOIN support_kb_articles a ON a.id=e.article_id AND a.org_id=e.org_id
		WHERE e.org_id=$1::uuid AND a.org_id=$1::uuid AND a.is_public=true
		  AND e.embedding_model=$2 AND e.content_md5=md5(a.title || E'\n' || a.body)
		ORDER BY e.embedding <=> $3::vector, a.updated_at DESC
		LIMIT 5`, orgID, model, literal)
	if err != nil {
		return SupportSearchKnowledgeOutput{}, err
	}
	defer rows.Close()
	out := SupportSearchKnowledgeOutput{Mode: "semantic", Results: []SupportKnowledgeResult{}}
	for rows.Next() {
		var articleTitle, body string
		if err := rows.Scan(&articleTitle, &body); err != nil {
			return SupportSearchKnowledgeOutput{}, err
		}
		source := articleTitle
		out.Results = append(out.Results, SupportKnowledgeResult{Kind: "article", Source: &source, Content: body})
	}
	return out, rows.Err()
}

type pendingSupportArticleEmbedding struct {
	articleID  string
	title      string
	body       string
	contentMD5 string
	attempts   int
}

// ProcessOnePublicSupportArticleEmbedding processes one pending row for the
// requested organization. Call it repeatedly from the Go worker loop.
func ProcessOnePublicSupportArticleEmbedding(ctx context.Context, pool dbx.Beginner, orgID, model string, embedder SupportKnowledgeEmbedder) (bool, error) {
	if pool == nil || embedder == nil || orgID == "" || model == "" {
		return false, errors.New("public support embedding worker is not configured")
	}
	pending, err := runPublicSupportOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (*pendingSupportArticleEmbedding, error) {
		// A model change causes eligible public articles to be re-enqueued. The
		// source digest also repairs rows that predate the trigger or a prior job.
		_, err := tx.Exec(ctx, `
			INSERT INTO support_kb_article_embedding_jobs (org_id, article_id, content_md5, requested_model)
			SELECT a.org_id, a.id, md5(a.title || E'\n' || a.body), $2
			FROM support_kb_articles a
			LEFT JOIN support_kb_article_embeddings e
			  ON e.org_id=a.org_id AND e.article_id=a.id AND e.embedding_model=$2
			WHERE a.org_id=$1::uuid AND a.is_public=true
			  AND (e.article_id IS NULL OR e.content_md5 <> md5(a.title || E'\n' || a.body))
			ON CONFLICT (org_id, article_id) DO UPDATE
			SET content_md5=EXCLUDED.content_md5, requested_model=EXCLUDED.requested_model,
			    queued_at=now(), attempts=0, available_at=now()
			WHERE support_kb_article_embedding_jobs.content_md5 IS DISTINCT FROM EXCLUDED.content_md5
			   OR support_kb_article_embedding_jobs.requested_model IS DISTINCT FROM EXCLUDED.requested_model`, orgID, model)
		if err != nil {
			return nil, err
		}
		var row pendingSupportArticleEmbedding
		err = tx.QueryRow(ctx, `
			SELECT j.article_id::text, a.title, a.body, j.content_md5, j.attempts
			FROM support_kb_article_embedding_jobs j
			JOIN support_kb_articles a ON a.id=j.article_id AND a.org_id=j.org_id
			WHERE j.org_id=$1::uuid AND j.requested_model=$2 AND j.available_at <= now() AND a.is_public=true
			ORDER BY j.queued_at, j.article_id
		LIMIT 1`, orgID, model).Scan(&row.articleID, &row.title, &row.body, &row.contentMD5, &row.attempts)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &row, nil
	})
	if err != nil || pending == nil {
		return false, err
	}
	content := "passage: " + pending.title + "\n\n" + pending.body
	vectors, err := embedder.Embed(ctx, model, "passage", []string{content})
	if err != nil {
		return true, errors.Join(err, deferSupportEmbeddingRetry(ctx, pool, orgID, model, *pending))
	}
	if len(vectors) != 1 || !validSupportEmbedding(vectors[0]) {
		err := errors.New("embedding provider returned an invalid public article vector")
		return true, errors.Join(err, deferSupportEmbeddingRetry(ctx, pool, orgID, model, *pending))
	}
	literal, err := supportEmbeddingVectorLiteral(vectors[0])
	if err != nil {
		return true, errors.Join(err, deferSupportEmbeddingRetry(ctx, pool, orgID, model, *pending))
	}
	_, err = runPublicSupportOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			INSERT INTO support_kb_article_embeddings (org_id, article_id, embedding_model, content_md5, embedding)
			SELECT a.org_id, a.id, $3, $4, $5::vector
			FROM support_kb_articles a
			JOIN support_kb_article_embedding_jobs j ON j.org_id=a.org_id AND j.article_id=a.id
			WHERE a.org_id=$1::uuid AND a.id=$2::uuid AND a.is_public=true
			  AND j.content_md5=$4 AND j.requested_model=$3
			  AND md5(a.title || E'\n' || a.body)=$4
			ON CONFLICT (org_id, article_id) DO UPDATE SET
			  embedding_model=EXCLUDED.embedding_model,
			  content_md5=EXCLUDED.content_md5,
			  embedding=EXCLUDED.embedding,
			  updated_at=now()`, orgID, pending.articleID, model, pending.contentMD5, literal)
		if err != nil {
			return struct{}{}, err
		}
		_, err = tx.Exec(ctx, `DELETE FROM support_kb_article_embedding_jobs WHERE org_id=$1::uuid AND article_id=$2::uuid AND content_md5=$3 AND requested_model=$4`, orgID, pending.articleID, pending.contentMD5, model)
		return struct{}{}, err
	})
	if err != nil {
		return true, errors.Join(err, deferSupportEmbeddingRetry(ctx, pool, orgID, model, *pending))
	}
	return true, nil
}

func deferSupportEmbeddingRetry(ctx context.Context, pool dbx.Beginner, orgID, model string, pending pendingSupportArticleEmbedding) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	shift := pending.attempts
	if shift < 0 {
		shift = 0
	}
	if shift > 6 {
		shift = 6
	}
	delaySeconds := 5 * (1 << shift)
	if delaySeconds > 300 {
		delaySeconds = 300
	}
	_, err := runPublicSupportOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			UPDATE support_kb_article_embedding_jobs
			SET attempts=attempts+1, available_at=now()+($5::int * interval '1 second')
			WHERE org_id=$1::uuid AND article_id=$2::uuid AND content_md5=$3 AND requested_model=$4`,
			orgID, pending.articleID, pending.contentMD5, model, delaySeconds)
		return struct{}{}, err
	})
	return err
}
