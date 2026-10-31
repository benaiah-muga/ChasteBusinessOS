package signals

import (
	"context"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	stallDays     = 14
	dealStageScan = 200
	taskScan      = 100
)

type dealRow struct {
	id         string
	title      string
	stage      string
	valueMinor int64
	updatedAt  time.Time
}

type taskRow struct {
	id    string
	title string
	dueAt time.Time
}

type moveDealStageDraft struct {
	DealID string `json:"dealId"`
}

type completeTaskDraft struct {
	TaskID string `json:"taskId"`
}

// NewCRMProducer ports modules/crm/src/signals.ts: deals that have gone quiet
// in an open stage and promised tasks that slipped past their due date.
func NewCRMProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return crmSignals(ctx, tx, orgID, now)
		})
	}
}

func crmSignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	var signals []capability.BusinessSignal

	dealRows, err := tx.Query(ctx, `
		SELECT id::text, title, stage, value_minor, updated_at
		FROM deals
		WHERE org_id = $1::uuid
		  AND stage IN ('lead', 'qualified', 'proposal', 'negotiation')
		ORDER BY id ASC
		LIMIT $2`, orgID, dealStageScan)
	if err != nil {
		return nil, err
	}
	for dealRows.Next() {
		var deal dealRow
		if err := dealRows.Scan(&deal.id, &deal.title, &deal.stage, &deal.valueMinor, &deal.updatedAt); err != nil {
			dealRows.Close()
			return nil, err
		}
		days := ageDays(now.Sub(deal.updatedAt))
		if days < stallDays {
			continue
		}
		signals = append(signals, capability.BusinessSignal{
			ID:       "crm.stalled:" + deal.id,
			Severity: "orange",
			Module:   "crm",
			Subject:  fmt.Sprintf("Deal %s has gone quiet for %d days", quoteTitle(deal.title), days),
			Detail:   fmt.Sprintf("Sat in %s with %s attached - a nudge now is cheaper than a loss later.", quoteTitle(deal.stage), formatMinor(deal.valueMinor)),
			Evidence: evidence("deal", deal.id),
			SuggestedAction: suggestedAction("crm.moveDealStage", moveDealStageDraft{
				DealID: deal.id,
			}),
		})
	}
	if err := dealRows.Err(); err != nil {
		dealRows.Close()
		return nil, err
	}
	dealRows.Close()

	taskRows, err := tx.Query(ctx, `
		SELECT id::text, title, due_at
		FROM tasks
		WHERE org_id = $1::uuid AND done_at IS NULL AND due_at < $2
		ORDER BY id ASC
		LIMIT $3`, orgID, now, taskScan)
	if err != nil {
		return nil, err
	}
	defer taskRows.Close()
	for taskRows.Next() {
		var task taskRow
		if err := taskRows.Scan(&task.id, &task.title, &task.dueAt); err != nil {
			return nil, err
		}
		daysLate := ageDays(now.Sub(task.dueAt))
		signals = append(signals, capability.BusinessSignal{
			ID:       "crm.taskOverdue:" + task.id,
			Severity: "red",
			Module:   "crm",
			Subject:  fmt.Sprintf("Task %s is %d %s overdue", quoteTitle(task.title), daysLate, dayWord(daysLate)),
			Detail:   fmt.Sprintf("Due %s and still open. Close it or renegotiate the date - silent slippage is how trust erodes.", task.dueAt.UTC().Format("2006-01-02")),
			Evidence: evidence("task", task.id),
			SuggestedAction: suggestedAction("crm.completeTask", completeTaskDraft{
				TaskID: task.id,
			}),
		})
	}
	if err := taskRows.Err(); err != nil {
		return nil, err
	}

	return signals, nil
}
