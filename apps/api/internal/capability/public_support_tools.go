package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const (
	PublicSupportLookupOrderStatusTool = "support.lookupOrderStatus"
	PublicSupportSearchKnowledgeTool   = "support.searchKnowledge"
)

// RunPublicSupportReadTool executes one of the two read-only support tools
// exposed to the public auto-reply model. The order lookup is always bound to
// conversationID from the trusted server context; input conversation IDs are
// ignored.
func RunPublicSupportReadTool(
	ctx context.Context,
	pool dbx.Beginner,
	orgID string,
	conversationID string,
	toolName string,
	rawInput json.RawMessage,
) (json.RawMessage, error) {
	return runPublicSupportReadTool(ctx, pool, orgID, conversationID, toolName, rawInput, "", nil)
}

// RunPublicSupportReadToolWithEmbedding enables semantic search using only the
// explicit public support article index. Callers must provide the configured
// embedding model and client; this path never reads memories.embedding.
func RunPublicSupportReadToolWithEmbedding(
	ctx context.Context,
	pool dbx.Beginner,
	orgID string,
	conversationID string,
	toolName string,
	rawInput json.RawMessage,
	model string,
	embedder SupportKnowledgeEmbedder,
) (json.RawMessage, error) {
	if model == "" || embedder == nil {
		return nil, errors.New("public support semantic search is not configured")
	}
	return runPublicSupportReadTool(ctx, pool, orgID, conversationID, toolName, rawInput, model, embedder)
}

func runPublicSupportReadTool(
	ctx context.Context,
	pool dbx.Beginner,
	orgID string,
	conversationID string,
	toolName string,
	rawInput json.RawMessage,
	model string,
	embedder SupportKnowledgeEmbedder,
) (json.RawMessage, error) {
	if pool == nil {
		return nil, errors.New("public support tools are unavailable")
	}
	if orgID == "" {
		return nil, dbx.ErrMissingOrgID
	}

	var result any
	switch toolName {
	case PublicSupportLookupOrderStatusTool:
		// Validate that model arguments are a JSON object, then parse the trusted
		// conversation ID with the existing UUID parser. This intentionally
		// discards any conversationId supplied by the model.
		if _, err := decodeJSONObject(rawInput); err != nil {
			return nil, err
		}
		boundInput, err := json.Marshal(map[string]string{"conversationId": conversationID})
		if err != nil {
			return nil, err
		}
		parsed, err := ParseSupportConversationIDInput(boundInput)
		if err != nil {
			return nil, err
		}
		var output SupportLookupOrderStatusOutput
		output, err = runPublicSupportOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (SupportLookupOrderStatusOutput, error) {
			return supportLookupOrderStatus(ctx, tx, orgID, SupportLookupOrderStatusInput{ConversationID: parsed.ConversationID})
		})
		if err != nil {
			return nil, err
		}
		result = output
	case PublicSupportSearchKnowledgeTool:
		parsed, err := ParseSupportSearchKnowledgeInput(rawInput)
		if err != nil {
			return nil, err
		}
		var vector []float32
		if embedder != nil {
			vectors, err := embedder.Embed(ctx, model, "query", []string{"query: " + parsed.Query})
			if err != nil {
				return nil, err
			}
			if len(vectors) != 1 || !validSupportEmbedding(vectors[0]) {
				return nil, errors.New("embedding provider returned an invalid support query vector")
			}
			vector = vectors[0]
		}
		output, err := runPublicSupportOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (SupportSearchKnowledgeOutput, error) {
			if embedder != nil {
				return publicSupportSemanticSearchKnowledge(ctx, tx, orgID, model, vector)
			}
			return publicSupportSearchKnowledge(ctx, tx, orgID, parsed)
		})
		if err != nil {
			return nil, err
		}
		result = output
	default:
		return nil, errors.New("unsupported public support tool")
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func runPublicSupportOrgTx[T any](ctx context.Context, pool dbx.Beginner, orgID string, action func(pgx.Tx) (T, error)) (T, error) {
	return dbx.WithOrgTx(ctx, pool, orgID, action)
}

func publicSupportSearchKnowledge(ctx context.Context, tx pgx.Tx, orgID string, input SupportSearchKnowledgeInput) (SupportSearchKnowledgeOutput, error) {
	needle := "%" + strings.NewReplacer("%", "", "_", "").Replace(strings.TrimSpace(input.Query)) + "%"
	rows, err := tx.Query(ctx, `
		SELECT title, body FROM support_kb_articles
		WHERE org_id=$1::uuid AND is_public=true AND (title ILIKE $2 OR body ILIKE $2)
		ORDER BY updated_at DESC LIMIT 5`, orgID, needle)
	if err != nil {
		return SupportSearchKnowledgeOutput{}, err
	}
	defer rows.Close()
	out := SupportSearchKnowledgeOutput{Mode: "text", Results: []SupportKnowledgeResult{}}
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
