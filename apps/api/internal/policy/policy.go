package policy

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type Value struct {
	MaxRiskAutonomous   string          `json:"maxRiskAutonomous"`
	MoneyThresholdMinor int64           `json:"moneyThresholdMinor"`
	RequiresApprovalFor json.RawMessage `json:"requiresApprovalFor"`
}

type Reader interface {
	ForOrg(context.Context, string) (Value, error)
}

type PostgresReader struct {
	pool dbx.Beginner
}

func NewPostgresReader(pool dbx.Beginner) *PostgresReader {
	return &PostgresReader{pool: pool}
}

func (r *PostgresReader) ForOrg(ctx context.Context, orgID string) (Value, error) {
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (Value, error) {
		value := Value{
			MaxRiskAutonomous:   "write",
			MoneyThresholdMinor: 50_000,
			RequiresApprovalFor: json.RawMessage("[]"),
		}
		var risk string
		var threshold int64
		var requiresApproval []byte
		err := tx.QueryRow(ctx, `
			SELECT max_risk_autonomous,
			       COALESCE(money_threshold_minor, 50000),
			       requires_approval_for
			FROM policies
			WHERE org_id = $1 AND capability_pattern = '*'
			LIMIT 1`, orgID).Scan(&risk, &threshold, &requiresApproval)
		if errors.Is(err, pgx.ErrNoRows) {
			return value, nil
		}
		if err != nil {
			return Value{}, err
		}
		value.MaxRiskAutonomous = risk
		value.MoneyThresholdMinor = threshold
		value.RequiresApprovalFor = parseRequiresApproval(requiresApproval)
		return value, nil
	})
}

func parseRequiresApproval(raw []byte) json.RawMessage {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return json.RawMessage("[]")
	}
	return json.RawMessage(append([]byte(nil), raw...))
}
