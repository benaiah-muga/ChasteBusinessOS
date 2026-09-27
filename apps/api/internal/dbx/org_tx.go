package dbx

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

var ErrMissingOrgID = errors.New("organization id is required")

type Beginner interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

func WithOrgTx[T any](ctx context.Context, pool Beginner, orgID string, action func(pgx.Tx) (T, error)) (T, error) {
	var zero T
	if orgID == "" {
		return zero, ErrMissingOrgID
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return zero, err
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	if _, err := tx.Exec(ctx, "SELECT set_config('app.org_id', $1, true)", orgID); err != nil {
		return zero, err
	}
	result, err := action(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
