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
	lateCountThreshold = 3
	trailingDays       = 7
)

type lateStreakRow struct {
	employeeID string
	name       string
	lateCount  int64
}

// NewHRProducer ports modules/hr/src/signals.ts: chronic lateness over the
// trailing week. Advisory, not punitive.
func NewHRProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return hrSignals(ctx, tx, orgID, now)
		})
	}
}

func hrSignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	cutoff := now.Add(-time.Duration(trailingDays) * 24 * time.Hour)
	rows, err := tx.Query(ctx, `
		SELECT e.id::text, e.name, count(*)
		FROM time_entries te
		JOIN employees e ON e.id = te.employee_id
		WHERE te.org_id = $1::uuid AND te.late = true AND te.clocked_in_at >= $2
		GROUP BY e.id, e.name
		ORDER BY e.id ASC`, orgID, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var signals []capability.BusinessSignal
	for rows.Next() {
		var row lateStreakRow
		if err := rows.Scan(&row.employeeID, &row.name, &row.lateCount); err != nil {
			return nil, err
		}
		if row.lateCount < lateCountThreshold {
			continue
		}
		signals = append(signals, capability.BusinessSignal{
			ID:       "hr.lateStreak:" + row.employeeID,
			Severity: "orange",
			Module:   "hr",
			Subject:  fmt.Sprintf("%s clocked in late %d times in the last %d days", row.name, row.lateCount, trailingDays),
			Detail:   "Pattern, not one-off - worth a conversation before it becomes a culture.",
			Evidence: evidence("employee", row.employeeID),
		})
	}
	return signals, rows.Err()
}
