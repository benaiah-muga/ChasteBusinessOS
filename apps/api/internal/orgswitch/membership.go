package orgswitch

import (
	"context"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type MembershipChecker interface {
	IsMember(context.Context, string, string) (bool, error)
}

type PostgresMembershipChecker struct {
	pool dbx.Beginner
}

func NewPostgresMembershipChecker(pool dbx.Beginner) *PostgresMembershipChecker {
	return &PostgresMembershipChecker{pool: pool}
}

func (c *PostgresMembershipChecker) IsMember(ctx context.Context, userID, orgID string) (bool, error) {
	return dbx.WithOrgTx(ctx, c.pool, orgID, func(tx pgx.Tx) (bool, error) {
		var member bool
		err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM memberships
				WHERE org_id = $1::uuid AND user_id = $2::uuid
			)`, orgID, userID).Scan(&member)
		return member, err
	})
}
