package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const recurringInvoiceScheduleBatchSize = 20

type dueRecurringInvoiceCandidate struct {
	RecurringInvoiceID string    `json:"recurringInvoiceId"`
	OrgID              string    `json:"orgId"`
	ScheduledFor       time.Time `json:"scheduledFor"`
}

func (w *Worker) scheduleDueRecurringInvoices(ctx context.Context, now time.Time) (int, error) {
	if !w.recurringInvoiceScheduler {
		return 0, nil
	}
	var encoded []byte
	var orgID any
	if w.recurringInvoiceSchedulerOrgID != "" {
		orgID = w.recurringInvoiceSchedulerOrgID
	}
	err := w.claimDB.QueryRow(ctx, `
		SELECT COALESCE(jsonb_agg(jsonb_build_object(
			'recurringInvoiceId', recurring_invoice_id,
			'orgId', org_id,
			'scheduledFor', scheduled_for
		) ORDER BY scheduled_for, recurring_invoice_id), '[]'::jsonb)
		FROM jobs_worker.list_due_recurring_invoice_candidates($1, $2::uuid)`, recurringInvoiceScheduleBatchSize, orgID).Scan(&encoded)
	if err != nil {
		return 0, err
	}
	var candidates []dueRecurringInvoiceCandidate
	if err := json.Unmarshal(encoded, &candidates); err != nil {
		return 0, fmt.Errorf("decode due recurring invoice candidates: %w", err)
	}

	byOrg := make(map[string][]dueRecurringInvoiceCandidate)
	orgIDs := make([]string, 0)
	for _, candidate := range candidates {
		if candidate.RecurringInvoiceID == "" || candidate.OrgID == "" || candidate.ScheduledFor.IsZero() {
			return 0, errors.New("due recurring invoice candidate has incomplete metadata")
		}
		if _, exists := byOrg[candidate.OrgID]; !exists {
			orgIDs = append(orgIDs, candidate.OrgID)
		}
		byOrg[candidate.OrgID] = append(byOrg[candidate.OrgID], candidate)
	}

	enqueued := 0
	for _, orgID := range orgIDs {
		count, err := w.scheduleOrgRecurringInvoices(ctx, orgID, byOrg[orgID], now)
		if err != nil {
			return enqueued, err
		}
		enqueued += count
	}
	return enqueued, nil
}

func (w *Worker) scheduleOrgRecurringInvoices(ctx context.Context, orgID string, candidates []dueRecurringInvoiceCandidate, now time.Time) (int, error) {
	if orgID == "" || len(candidates) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.RecurringInvoiceID)
	}
	return dbx.WithOrgTx(ctx, w.effectDB, orgID, func(tx pgx.Tx) (int, error) {
		rows, err := tx.Query(ctx, `
			SELECT id::text, next_run_at
			FROM public.recurring_invoices
			WHERE org_id = $1::uuid
			  AND id::text = ANY($2::text[])
			  AND active = true
			  AND next_run_at <= $3::timestamptz
			ORDER BY next_run_at, id
			FOR UPDATE SKIP LOCKED`, orgID, ids, now)
		if err != nil {
			return 0, err
		}
		type dueTemplate struct {
			ID          string
			ScheduledAt time.Time
		}
		due := make([]dueTemplate, 0, len(ids))
		for rows.Next() {
			var template dueTemplate
			if err := rows.Scan(&template.ID, &template.ScheduledAt); err != nil {
				rows.Close()
				return 0, err
			}
			due = append(due, template)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return 0, err
		}
		rows.Close()

		enqueued := 0
		for _, template := range due {
			var occurrenceID string
			err := tx.QueryRow(ctx, `
				INSERT INTO public.recurring_invoice_runs(org_id, recurring_invoice_id, scheduled_for, status)
				VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'queued')
				ON CONFLICT (org_id, recurring_invoice_id, scheduled_for)
				DO UPDATE SET status = 'queued', invoice_id = NULL, completed_at = NULL
				WHERE public.recurring_invoice_runs.status = 'cancelled'
				RETURNING id::text`, orgID, template.ID, template.ScheduledAt).Scan(&occurrenceID)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return 0, err
			}

			payload, err := json.Marshal(map[string]string{"occurrenceId": occurrenceID})
			if err != nil {
				return 0, err
			}
			var jobID string
			if err := tx.QueryRow(ctx, `
				INSERT INTO public.jobs(org_id, type, payload, created_by_actor_type)
				VALUES ($1::uuid, 'accounting.generateDueInvoices', $2::jsonb, 'system')
				RETURNING id::text`, orgID, string(payload)).Scan(&jobID); err != nil {
				return 0, err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE public.recurring_invoice_runs
				SET job_id = $2::uuid
				WHERE id = $1::uuid AND org_id = $3::uuid`, occurrenceID, jobID, orgID); err != nil {
				return 0, err
			}
			enqueued++
		}
		return enqueued, nil
	})
}
