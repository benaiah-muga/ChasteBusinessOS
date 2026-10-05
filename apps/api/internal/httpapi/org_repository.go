package httpapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PgOrgRepository is the PostgreSQL-backed OrgRepository.
type PgOrgRepository struct{ pool *pgxpool.Pool }

func NewPgOrgRepository(pool *pgxpool.Pool) *PgOrgRepository {
	return &PgOrgRepository{pool: pool}
}

// ListOrgsForUser loads the caller's session-scoped membership candidates one
// tenant at a time. Each organization and membership check runs under its RLS
// context, and revoked memberships are omitted.
func (r *PgOrgRepository) ListOrgsForUser(ctx context.Context, userID string, orgIDs []string) ([]OrgSummary, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("org repository has no pool")
	}
	orgs := make([]OrgSummary, 0, len(orgIDs))
	for _, orgID := range orgIDs {
		type orgLookup struct {
			org   OrgSummary
			found bool
		}
		result, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (orgLookup, error) {
			var org OrgSummary
			err := tx.QueryRow(ctx, `
				SELECT o.id::text, o.name, o.base_currency
				FROM organizations AS o
				JOIN memberships AS m ON m.org_id = o.id
				WHERE o.id = $1::uuid AND m.user_id = $2::uuid`, orgID, userID).
				Scan(&org.ID, &org.Name, &org.BaseCurrency)
			if errors.Is(err, pgx.ErrNoRows) {
				return orgLookup{}, nil
			}
			if err != nil {
				return orgLookup{}, err
			}
			return orgLookup{org: org, found: true}, nil
		})
		if err != nil {
			return nil, fmt.Errorf("list organization: %w", err)
		}
		if result.found {
			orgs = append(orgs, result.org)
		}
	}
	return orgs, nil
}

func (r *PgOrgRepository) IsMember(ctx context.Context, userID, orgID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("org repository has no pool")
	}
	if !isUUID(userID) || !isUUID(orgID) {
		return false, nil
	}
	exists, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (bool, error) {
		var member bool
		err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM memberships WHERE user_id = $1::uuid AND org_id = $2::uuid
			)`, userID, orgID).Scan(&member)
		return member, err
	})
	if err != nil {
		return false, fmt.Errorf("membership check: %w", err)
	}
	return exists, nil
}

// AgentSoul returns the organization's persona, or the empty string when the
// organization has none. A missing organization reads as empty rather than
// erroring, matching the legacy route's optional chaining.
func (r *PgOrgRepository) AgentSoul(ctx context.Context, orgID string) (string, error) {
	if r == nil || r.pool == nil {
		return "", errors.New("org repository has no pool")
	}
	soul, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (*string, error) {
		var soul *string
		err := tx.QueryRow(ctx,
			`SELECT agent_soul FROM organizations WHERE id = $1::uuid`, orgID).Scan(&soul)
		return soul, err
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("read agent soul: %w", err)
	}
	if soul == nil {
		return "", nil
	}
	return *soul, nil
}

func (r *PgOrgRepository) SetAgentSoul(ctx context.Context, orgID, soul string) error {
	if r == nil || r.pool == nil {
		return errors.New("org repository has no pool")
	}
	var value any
	if soul != "" {
		value = soul
	}
	if _, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx,
			`UPDATE organizations SET agent_soul = $2 WHERE id = $1::uuid`, orgID, value)
		return struct{}{}, err
	}); err != nil {
		return fmt.Errorf("set agent soul: %w", err)
	}
	return nil
}
