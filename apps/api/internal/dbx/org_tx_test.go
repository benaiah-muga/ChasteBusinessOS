package dbx

import (
	"context"
	"errors"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWithOrgTxSetsTransactionLocalOrgContext(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := VerifyAppRuntimeRole(ctx, pool); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	const orgID = "00000000-0000-4000-8000-000000000123"
	gotOrgID, err := WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (string, error) {
		var actual string
		err := tx.QueryRow(ctx, "SELECT current_setting('app.org_id', true)").Scan(&actual)
		return actual, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotOrgID != orgID {
		t.Fatalf("transaction org id = %q, want %q", gotOrgID, orgID)
	}

	var outsideOrgID string
	if err := pool.QueryRow(ctx, "SELECT current_setting('app.org_id', true)").Scan(&outsideOrgID); err != nil {
		t.Fatal(err)
	}
	if outsideOrgID != "" {
		t.Fatalf("org id leaked outside transaction: %q", outsideOrgID)
	}
}

func TestWithOrgTxRejectsMissingOrgBeforeOpeningTransaction(t *testing.T) {
	_, err := WithOrgTx(context.Background(), nil, "", func(pgx.Tx) (string, error) {
		t.Fatal("action ran without an organization id")
		return "", nil
	})
	if err != ErrMissingOrgID {
		t.Fatalf("error = %v, want %v", err, ErrMissingOrgID)
	}
}
