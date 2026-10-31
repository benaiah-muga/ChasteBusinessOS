package signals

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type supportBreachRow struct {
	id           string
	ticketNumber *int64
	priority     string
	slaDueAt     time.Time
}

// NewSupportProducer ports modules/support/src/signals.ts: open tickets past
// their SLA due date.
func NewSupportProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return supportSignals(ctx, tx, orgID, now)
		})
	}
}

func supportSignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, ticket_number, priority, sla_due_at
		FROM support_conversations
		WHERE org_id = $1::uuid AND status = 'open' AND sla_due_at < $2
		ORDER BY id ASC
		LIMIT 100`, orgID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var signals []capability.BusinessSignal
	for rows.Next() {
		var ticket supportBreachRow
		if err := rows.Scan(&ticket.id, &ticket.ticketNumber, &ticket.priority, &ticket.slaDueAt); err != nil {
			return nil, err
		}
		days := ageDays(now.Sub(ticket.slaDueAt))
		ticketLabel := "?"
		if ticket.ticketNumber != nil {
			ticketLabel = strconv.FormatInt(*ticket.ticketNumber, 10)
		}
		signals = append(signals, capability.BusinessSignal{
			ID:       "support.slaBreach:" + ticket.id,
			Severity: "red",
			Module:   "support",
			Subject:  fmt.Sprintf("Ticket #%s breached its SLA %d %s ago", ticketLabel, days, dayWord(days)),
			Detail:   fmt.Sprintf("Open %s-priority ticket past its due date. Resolve it or renegotiate the deadline with the customer today.", ticket.priority),
			Evidence: evidence("support_conversation", ticket.id),
		})
	}
	return signals, rows.Err()
}
