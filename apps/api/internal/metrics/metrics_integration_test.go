package metrics

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresMetricsReaderAggregatesNewestSessionsForOneOrganization(t *testing.T) {
	ctx := context.Background()
	owner, runtime := metricsPools(t, ctx)
	orgID := createMetricsOrg(t, ctx, owner, "metrics-main")
	otherOrgID := createMetricsOrg(t, ctx, owner, "metrics-other")
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{orgID, otherOrgID}); err != nil {
			t.Errorf("delete metrics fixture organizations: %v", err)
		}
	})

	_, err := owner.Exec(ctx, `
		INSERT INTO agent_sessions (org_id, token_usage, updated_at)
		SELECT $1::uuid,
		       CASE n
		         WHEN 1 THEN '{"input":100,"output":5,"cachedInput":40}'::jsonb
		         WHEN 2 THEN '{"output":3}'::jsonb
		         WHEN 3 THEN '{"input":0,"output":0,"cachedInput":9}'::jsonb
		         WHEN 201 THEN '{"input":10000,"output":10000,"cachedInput":5000}'::jsonb
		         ELSE '{"input":1,"output":0}'::jsonb
		       END,
		       now() - (n * interval '1 second')
		FROM generate_series(1, 201) AS n`, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO agent_sessions (org_id, token_usage, updated_at) VALUES ($1::uuid, '{"input":999999,"output":999999,"cachedInput":999999}', now() + interval '1 hour')`, otherOrgID); err != nil {
		t.Fatal(err)
	}

	got, err := NewPostgresReader(runtime).ForOrg(ctx, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Totals.SessionsTracked != 199 || got.Totals.InputTokens != 297 || got.Totals.OutputTokens != 8 || got.Totals.CachedInputTokens != 40 {
		t.Fatalf("unexpected totals: %+v", got.Totals)
	}
	if got.Totals.CacheHitRatePct == nil || *got.Totals.CacheHitRatePct != 13 {
		t.Fatalf("cache hit rate = %v, want 13", got.Totals.CacheHitRatePct)
	}
	if got.Note != note {
		t.Fatalf("note = %q, want %q", got.Note, note)
	}

	visibleOtherOrgRows, err := dbx.WithOrgTx(ctx, runtime, orgID, func(tx pgx.Tx) (int64, error) {
		var count int64
		err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_sessions WHERE org_id = $1::uuid`, otherOrgID).Scan(&count)
		return count, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if visibleOtherOrgRows != 0 {
		t.Fatalf("runtime role saw %d session(s) from another organization", visibleOtherOrgRows)
	}
}

func TestPostgresMetricsReaderReturnsNullRateForZeroInputAndRoundsHalfUp(t *testing.T) {
	ctx := context.Background()
	owner, runtime := metricsPools(t, ctx)
	zeroOrgID := createMetricsOrg(t, ctx, owner, "metrics-zero")
	roundOrgID := createMetricsOrg(t, ctx, owner, "metrics-round")
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{zeroOrgID, roundOrgID}); err != nil {
			t.Errorf("delete metrics fixture organizations: %v", err)
		}
	})
	_, err := owner.Exec(ctx, `
		INSERT INTO agent_sessions (org_id, token_usage) VALUES
		($1::uuid, '{"cachedInput":12}'::jsonb),
		($1::uuid, '{"input":null,"output":0}'::jsonb),
		($2::uuid, '{"input":8,"output":1,"cachedInput":1}'::jsonb)`, zeroOrgID, roundOrgID)
	if err != nil {
		t.Fatal(err)
	}

	zero, err := NewPostgresReader(runtime).ForOrg(ctx, zeroOrgID)
	if err != nil {
		t.Fatal(err)
	}
	if zero.Totals.SessionsTracked != 0 || zero.Totals.InputTokens != 0 || zero.Totals.OutputTokens != 0 || zero.Totals.CachedInputTokens != 0 || zero.Totals.CacheHitRatePct != nil {
		t.Fatalf("zero-input payload = %+v, want all zero totals and null rate", zero.Totals)
	}

	rounded, err := NewPostgresReader(runtime).ForOrg(ctx, roundOrgID)
	if err != nil {
		t.Fatal(err)
	}
	if rounded.Totals.CacheHitRatePct == nil || *rounded.Totals.CacheHitRatePct != 13 {
		t.Fatalf("cache hit rate = %v, want JavaScript Math.round(12.5) == 13", rounded.Totals.CacheHitRatePct)
	}
}

func metricsPools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed metrics integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed metrics fixtures")
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}
	return owner, runtime
}

func createMetricsOrg(t *testing.T, ctx context.Context, owner *pgxpool.Pool, suffix string) string {
	t.Helper()
	var orgID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO organizations (name, slug, base_currency)
		VALUES ($1, $2, 'USD') RETURNING id::text`,
		"Go metrics "+suffix, fmt.Sprintf("go-metrics-%s-%d", suffix, os.Getpid()),
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	return orgID
}
