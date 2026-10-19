package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	evaluationHistoryLimit = 30
	evaluationSaveTimeout  = 5 * time.Second
)

type evaluationRunStore struct {
	pool *pgxpool.Pool
}

func (s *evaluationRunStore) save(ctx context.Context, orgID, actorID string, result *EvaluationRunResult) error {
	if s == nil || s.pool == nil {
		return fmt.Errorf("evaluation store is unavailable")
	}
	toolCalls := []byte("[]")
	if len(result.ToolCalls) > 0 {
		encoded, err := json.Marshal(result.ToolCalls)
		if err != nil {
			return err
		}
		toolCalls = encoded
	}
	checks := []byte("[]")
	if len(result.Checks) > 0 {
		encoded, err := json.Marshal(result.Checks)
		if err != nil {
			return err
		}
		checks = encoded
	}
	var nullableError *string
	if result.Error != "" {
		nullableError = &result.Error
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), evaluationSaveTimeout)
	defer cancel()
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		var createdAt time.Time
		if err := tx.QueryRow(ctx, `
			INSERT INTO evaluation_runs (
				org_id, scenario_id, status, model, final_answer, duration_ms,
				input_tokens, output_tokens, cached_tokens, tool_calls, checks, error, actor_id
			) VALUES (
				$1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::uuid
			) RETURNING created_at`,
			orgID, result.ScenarioID, result.Status, result.Model, result.FinalAnswer, result.DurationMS,
			result.Usage.Input, result.Usage.Output, result.Usage.CachedInput, toolCalls, checks, nullableError, actorID,
		).Scan(&createdAt); err != nil {
			return struct{}{}, err
		}
		result.CreatedAt = createdAt.UTC()
		result.Persisted = true
		return struct{}{}, nil
	})
	return err
}

func (s *evaluationRunStore) recent(ctx context.Context, orgID string, limit int) ([]EvaluationRunResult, error) {
	if s == nil || s.pool == nil {
		return []EvaluationRunResult{}, nil
	}
	if limit <= 0 || limit > evaluationHistoryLimit {
		limit = evaluationHistoryLimit
	}
	runs := make([]EvaluationRunResult, 0, limit)
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		rows, err := tx.Query(ctx, `
			SELECT scenario_id, status, model, final_answer, duration_ms,
				input_tokens, output_tokens, cached_tokens, tool_calls, checks,
				COALESCE(error, ''), created_at
			FROM evaluation_runs
			WHERE org_id = $1::uuid
			ORDER BY created_at DESC
			LIMIT $2`, orgID, limit)
		if err != nil {
			return struct{}{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var run EvaluationRunResult
			var toolCalls, checks []byte
			if err := rows.Scan(
				&run.ScenarioID, &run.Status, &run.Model, &run.FinalAnswer, &run.DurationMS,
				&run.Usage.Input, &run.Usage.Output, &run.Usage.CachedInput, &toolCalls, &checks,
				&run.Error, &run.CreatedAt,
			); err != nil {
				return struct{}{}, err
			}
			run.Persisted = true
			run.CreatedAt = run.CreatedAt.UTC()
			if len(toolCalls) > 0 {
				if err := json.Unmarshal(toolCalls, &run.ToolCalls); err != nil {
					return struct{}{}, err
				}
			}
			if len(checks) > 0 {
				if err := json.Unmarshal(checks, &run.Checks); err != nil {
					return struct{}{}, err
				}
			}
			if run.ToolCalls == nil {
				run.ToolCalls = []EvaluationToolCall{}
			}
			if run.Checks == nil {
				run.Checks = []EvaluationCheckResult{}
			}
			runs = append(runs, run)
		}
		return struct{}{}, rows.Err()
	})
	if err != nil {
		return []EvaluationRunResult{}, err
	}
	return runs, nil
}
