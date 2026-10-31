package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const (
	maxSessions = 200
	note        = "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet."
)

type Payload struct {
	Totals Totals `json:"totals"`
	Note   string `json:"note"`
}

type Totals struct {
	SessionsTracked   int     `json:"sessionsTracked"`
	InputTokens       float64 `json:"inputTokens"`
	OutputTokens      float64 `json:"outputTokens"`
	CachedInputTokens float64 `json:"cachedInputTokens"`
	CacheHitRatePct   *int    `json:"cacheHitRatePct"`
}

type Reader interface {
	ForOrg(context.Context, string) (Payload, error)
}

type PostgresReader struct {
	pool dbx.Beginner
}

func NewPostgresReader(pool dbx.Beginner) *PostgresReader {
	return &PostgresReader{pool: pool}
}

func (r *PostgresReader) ForOrg(ctx context.Context, orgID string) (Payload, error) {
	if r == nil || r.pool == nil {
		return Payload{}, errors.New("metrics reader is unavailable")
	}
	if orgID == "" {
		return Payload{}, dbx.ErrMissingOrgID
	}

	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (Payload, error) {
		rows, err := tx.Query(ctx, `
			SELECT token_usage
			FROM public.agent_sessions
			WHERE org_id = $1::uuid
			ORDER BY updated_at DESC
			LIMIT $2`, orgID, maxSessions)
		if err != nil {
			return Payload{}, fmt.Errorf("query agent session metrics: %w", err)
		}
		defer rows.Close()

		totals := Totals{}
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				return Payload{}, fmt.Errorf("scan agent session metrics: %w", err)
			}
			usage, err := decodeUsage(raw)
			if err != nil {
				return Payload{}, fmt.Errorf("decode agent session token usage: %w", err)
			}
			if usage.input == 0 && usage.output == 0 {
				continue
			}
			totals.SessionsTracked++
			totals.InputTokens += usage.input
			totals.OutputTokens += usage.output
			totals.CachedInputTokens += usage.cachedInput
		}
		if err := rows.Err(); err != nil {
			return Payload{}, fmt.Errorf("read agent session metrics: %w", err)
		}

		if totals.InputTokens > 0 {
			rate := int(math.Floor(totals.CachedInputTokens/totals.InputTokens*100 + 0.5))
			totals.CacheHitRatePct = &rate
		}
		return Payload{Totals: totals, Note: note}, nil
	})
}

type usage struct {
	input       float64
	output      float64
	cachedInput float64
}

func decodeUsage(raw []byte) (usage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return usage{}, err
	}
	input, err := numberOrZero(fields["input"])
	if err != nil {
		return usage{}, fmt.Errorf("input: %w", err)
	}
	output, err := numberOrZero(fields["output"])
	if err != nil {
		return usage{}, fmt.Errorf("output: %w", err)
	}
	cachedInput, err := numberOrZero(fields["cachedInput"])
	if err != nil {
		return usage{}, fmt.Errorf("cachedInput: %w", err)
	}
	return usage{input: input, output: output, cachedInput: cachedInput}, nil
}

func numberOrZero(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, nil
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, errors.New("token usage value must be numeric or null")
	}
	return value, nil
}
