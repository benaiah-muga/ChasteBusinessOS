package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const routineScheduleBatchSize = 10

type dueRoutineCandidate struct {
	RoutineID   string    `json:"routineId"`
	OrgID       string    `json:"orgId"`
	ScheduledAt time.Time `json:"scheduledAt"`
}

type dueRoutine struct {
	ID          string
	OrgID       string
	Name        string
	Schedule    capability.RoutineSchedule
	ScheduledAt time.Time
}

func (w *Worker) scheduleDueRoutines(ctx context.Context, now time.Time) (int, error) {
	if !w.routineScheduler {
		return 0, nil
	}
	var encoded []byte
	err := w.claimDB.QueryRow(ctx, `
		SELECT COALESCE(jsonb_agg(jsonb_build_object(
			'routineId', routine_id,
			'orgId', org_id,
			'scheduledAt', scheduled_at
		) ORDER BY scheduled_at, routine_id), '[]'::jsonb)
		FROM jobs_worker.list_due_routine_candidates($1)`, routineScheduleBatchSize).Scan(&encoded)
	if err != nil {
		return 0, err
	}
	var candidates []dueRoutineCandidate
	if err := json.Unmarshal(encoded, &candidates); err != nil {
		return 0, fmt.Errorf("decode due routine candidates: %w", err)
	}
	candidates = limitRoutineCandidates(candidates, routineScheduleBatchSize)

	byOrg := make(map[string][]string)
	orgIDs := make([]string, 0)
	for _, candidate := range candidates {
		if candidate.RoutineID == "" || candidate.OrgID == "" || candidate.ScheduledAt.IsZero() {
			return 0, errors.New("due routine candidate has incomplete metadata")
		}
		if _, exists := byOrg[candidate.OrgID]; !exists {
			orgIDs = append(orgIDs, candidate.OrgID)
		}
		byOrg[candidate.OrgID] = append(byOrg[candidate.OrgID], candidate.RoutineID)
	}

	claimed := 0
	for _, orgID := range orgIDs {
		count, err := w.scheduleOrgRoutines(ctx, orgID, byOrg[orgID], now)
		if err != nil {
			return claimed, err
		}
		claimed += count
	}
	return claimed, nil
}

func limitRoutineCandidates(candidates []dueRoutineCandidate, limit int) []dueRoutineCandidate {
	candidates = append([]dueRoutineCandidate(nil), candidates...)
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].ScheduledAt.Equal(candidates[j].ScheduledAt) {
			return candidates[i].RoutineID < candidates[j].RoutineID
		}
		return candidates[i].ScheduledAt.Before(candidates[j].ScheduledAt)
	})
	if limit > 0 && len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}

func (w *Worker) scheduleOrgRoutines(ctx context.Context, orgID string, routineIDs []string, now time.Time) (int, error) {
	if orgID == "" || len(routineIDs) == 0 {
		return 0, nil
	}
	return dbx.WithOrgTx(ctx, w.effectDB, orgID, func(tx pgx.Tx) (int, error) {
		rows, err := tx.Query(ctx, `
			SELECT id::text, name, schedule, next_run_at
			FROM public.routines
			WHERE org_id = $1::uuid
			  AND id::text = ANY($2::text[])
			  AND enabled = true
			  AND trigger_type = 'schedule'
			  AND next_run_at <= $3::timestamptz
			ORDER BY next_run_at, id
			FOR UPDATE SKIP LOCKED`, orgID, routineIDs, now)
		if err != nil {
			return 0, err
		}
		defer rows.Close()

		due := make([]dueRoutine, 0, len(routineIDs))
		for rows.Next() {
			var row dueRoutine
			row.OrgID = orgID
			var schedule []byte
			if err := rows.Scan(&row.ID, &row.Name, &schedule, &row.ScheduledAt); err != nil {
				return 0, err
			}
			if err := json.Unmarshal(schedule, &row.Schedule); err != nil {
				return 0, fmt.Errorf("decode routine %s schedule: %w", row.ID, err)
			}
			if err := capability.ValidateRoutineSchedule(row.Schedule); err != nil {
				return 0, fmt.Errorf("validate routine %s schedule: %w", row.ID, err)
			}
			due = append(due, row)
		}
		if err := rows.Err(); err != nil {
			return 0, err
		}
		rows.Close()

		claimed := 0
		for _, routine := range due {
			var occurrenceID string
			err := tx.QueryRow(ctx, `
				INSERT INTO public.routine_occurrences(org_id, routine_id, scheduled_at, status)
				VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'queued')
				ON CONFLICT (routine_id, scheduled_at) DO NOTHING
				RETURNING id::text`, orgID, routine.ID, routine.ScheduledAt).Scan(&occurrenceID)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return 0, err
			}

			payload, err := json.Marshal(routinePayload{
				RoutineID: routine.ID, Trigger: "schedule", OccurrenceID: &occurrenceID,
				ScheduledAt: routine.ScheduledAt.UTC().Format(time.RFC3339Nano),
			})
			if err != nil {
				return 0, err
			}
			var jobID string
			if err := tx.QueryRow(ctx, `
				INSERT INTO public.jobs(org_id, type, payload)
				VALUES ($1::uuid, 'routines.executeRoutine', $2::jsonb)
				RETURNING id::text`, orgID, string(payload)).Scan(&jobID); err != nil {
				return 0, err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE public.routine_occurrences
				SET job_id = $3::uuid
				WHERE id = $1::uuid AND org_id = $2::uuid`, occurrenceID, orgID, jobID); err != nil {
				return 0, err
			}
			nextRunAt := capability.RoutinesNextRun(routine.Schedule, now)
			if _, err := tx.Exec(ctx, `
				UPDATE public.routines
				SET last_run_at = $3::timestamptz,
				    last_status = 'running',
				    next_run_at = $4::timestamptz
				WHERE id = $1::uuid AND org_id = $2::uuid`, routine.ID, orgID, now, nextRunAt); err != nil {
				return 0, err
			}
			claimed++
		}
		return claimed, nil
	})
}
