package capability

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestPublicSupportArticleEmbeddingLifecycleAndTenantIsolation(t *testing.T) {
	fx := newExecutorFixture(t)
	const model = "test/support-embeddings"
	var publicArticleID, privateArticleID, foreignArticleID string
	for _, article := range []struct {
		orgID  string
		title  string
		body   string
		public bool
		target *string
	}{
		{orgID: fx.orgID, title: "Returns policy", body: "Returns are accepted within 30 days.", public: true, target: &publicArticleID},
		{orgID: fx.orgID, title: "Internal refund notes", body: "Manager approval is required.", public: false, target: &privateArticleID},
		{orgID: fx.otherOrgID, title: "Foreign returns", body: "Foreign org policy.", public: true, target: &foreignArticleID},
	} {
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO support_kb_articles (org_id, title, body, is_public)
			VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`, article.orgID, article.title, article.body, article.public).Scan(article.target); err != nil {
			t.Fatal(err)
		}
	}
	var publicJobs, privateJobs, foreignJobs int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embedding_jobs WHERE org_id=$1::uuid`, fx.orgID).Scan(&publicJobs); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embedding_jobs WHERE org_id=$1::uuid AND article_id=$2::uuid`, fx.orgID, privateArticleID).Scan(&privateJobs); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embedding_jobs WHERE org_id=$1::uuid`, fx.otherOrgID).Scan(&foreignJobs); err != nil {
		t.Fatal(err)
	}
	if publicJobs != 1 || privateJobs != 0 || foreignJobs != 1 {
		t.Fatalf("insert lifecycle jobs public-org=%d private=%d foreign-org=%d", publicJobs, privateJobs, foreignJobs)
	}

	embedder := supportEmbeddingFunc(func(_ context.Context, gotModel, inputType string, inputs []string) ([][]float32, error) {
		if gotModel != model || inputType != "passage" || len(inputs) != 1 || !strings.HasPrefix(inputs[0], "passage: ") {
			t.Fatalf("unexpected worker embedding request model=%q type=%q input=%q", gotModel, inputType, inputs)
		}
		vector := make([]float32, SupportKnowledgeEmbeddingDimension)
		vector[0] = 0.75
		return [][]float32{vector}, nil
	})
	processed, err := ProcessOnePublicSupportArticleEmbedding(fx.ctx, fx.runtime, fx.orgID, model, embedder)
	if err != nil || !processed {
		t.Fatalf("ProcessOnePublicSupportArticleEmbedding() = %t, %v", processed, err)
	}
	processed, err = ProcessOnePublicSupportArticleEmbedding(fx.ctx, fx.runtime, fx.otherOrgID, model, embedder)
	if err != nil || !processed {
		t.Fatalf("ProcessOnePublicSupportArticleEmbedding() foreign org = %t, %v", processed, err)
	}
	var indexed int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embeddings WHERE org_id=$1::uuid`, fx.orgID).Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if indexed != 1 {
		t.Fatalf("indexed public article count = %d, want 1", indexed)
	}

	queryVector := make([]float32, SupportKnowledgeEmbeddingDimension)
	queryVector[0] = 0.75
	for _, check := range []struct {
		orgID string
		want  string
	}{
		{orgID: fx.orgID, want: "Returns policy"},
		{orgID: fx.otherOrgID, want: "Foreign returns"},
	} {
		result, err := runPublicSupportOrgTx(fx.ctx, fx.runtime, check.orgID, func(tx pgx.Tx) (SupportSearchKnowledgeOutput, error) {
			return publicSupportSemanticSearchKnowledge(fx.ctx, tx, check.orgID, model, queryVector)
		})
		if err != nil {
			t.Fatalf("semantic search for %s: %v", check.orgID, err)
		}
		if len(result.Results) != 0 && *result.Results[0].Source != check.want {
			t.Fatalf("org %s received %q, want %q", check.orgID, *result.Results[0].Source, check.want)
		}
		if check.orgID == fx.orgID && (len(result.Results) != 1 || *result.Results[0].Source != check.want) {
			t.Fatalf("org %s did not retrieve its indexed article: %+v", check.orgID, result)
		}
		if check.orgID == fx.otherOrgID && (len(result.Results) != 1 || *result.Results[0].Source != check.want) {
			t.Fatalf("org %s did not retrieve its own indexed article: %+v", check.orgID, result)
		}
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE support_kb_articles SET body='Updated public policy.' WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, publicArticleID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embeddings WHERE org_id=$1::uuid AND article_id=$2::uuid`, fx.orgID, publicArticleID).Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if indexed != 0 {
		t.Fatal("article edit left a stale public embedding")
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embedding_jobs WHERE org_id=$1::uuid AND article_id=$2::uuid`, fx.orgID, publicArticleID).Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if indexed != 1 {
		t.Fatal("article edit did not enqueue a replacement embedding")
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE support_kb_articles SET is_public=false WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, publicArticleID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM support_kb_article_embedding_jobs WHERE org_id=$1::uuid AND article_id=$2::uuid`, fx.orgID, publicArticleID).Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if indexed != 0 {
		t.Fatal("unpublished article remained queued for public embedding")
	}
}

func TestSupportEmbeddingFailureBackoffDoesNotBlockLaterArticle(t *testing.T) {
	fx := newExecutorFixture(t)
	const model = "test/support-embeddings"
	var firstArticleID, secondArticleID string
	for _, article := range []struct {
		title string
		id    *string
	}{
		{title: "First article", id: &firstArticleID},
		{title: "Second article", id: &secondArticleID},
	} {
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO support_kb_articles (org_id, title, body, is_public)
			VALUES ($1::uuid, $2, 'Published help content.', true) RETURNING id::text`, fx.orgID, article.title).Scan(article.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE support_kb_article_embedding_jobs SET requested_model=$2, queued_at=CASE WHEN article_id=$3::uuid THEN now()-interval '1 minute' ELSE now() END WHERE org_id=$1::uuid`, fx.orgID, model, firstArticleID); err != nil {
		t.Fatal(err)
	}
	_, err := ProcessOnePublicSupportArticleEmbedding(fx.ctx, fx.runtime, fx.orgID, model, supportEmbeddingFunc(func(context.Context, string, string, []string) ([][]float32, error) {
		return nil, errors.New("temporary provider failure")
	}))
	if err == nil {
		t.Fatal("expected the first article embedding to fail")
	}
	var attempts int
	var availableAtFuture bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT attempts, available_at > now()
		FROM support_kb_article_embedding_jobs
		WHERE org_id=$1::uuid AND article_id=$2::uuid`, fx.orgID, firstArticleID).Scan(&attempts, &availableAtFuture); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !availableAtFuture {
		t.Fatalf("failed job state attempts=%d available_at_future=%t", attempts, availableAtFuture)
	}
	var embedded string
	processed, err := ProcessOnePublicSupportArticleEmbedding(fx.ctx, fx.runtime, fx.orgID, model, supportEmbeddingFunc(func(_ context.Context, gotModel, inputType string, inputs []string) ([][]float32, error) {
		if gotModel != model || inputType != "passage" || len(inputs) != 1 {
			t.Fatalf("unexpected embedding request: model=%q type=%q inputs=%v", gotModel, inputType, inputs)
		}
		embedded = inputs[0]
		vector := make([]float32, SupportKnowledgeEmbeddingDimension)
		vector[0] = 0.5
		return [][]float32{vector}, nil
	}))
	if err != nil || !processed {
		t.Fatalf("later article processing = %t, %v", processed, err)
	}
	if !strings.Contains(embedded, "Second article") || strings.Contains(embedded, "First article") {
		t.Fatalf("backoff did not skip the failing article: %q", embedded)
	}
}
