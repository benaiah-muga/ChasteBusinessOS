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

type expiredDocumentRow struct {
	id        string
	title     string
	expiresAt time.Time
}

// NewDocumentsProducer ports modules/documents/src/signals.ts: documents past
// their validity date.
func NewDocumentsProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return documentSignals(ctx, tx, orgID, now)
		})
	}
}

func documentSignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, title, expires_at
		FROM documents
		WHERE org_id = $1::uuid AND expires_at < $2
		ORDER BY id ASC
		LIMIT 100`, orgID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var signals []capability.BusinessSignal
	for rows.Next() {
		var document expiredDocumentRow
		if err := rows.Scan(&document.id, &document.title, &document.expiresAt); err != nil {
			return nil, err
		}
		days := ageDays(now.Sub(document.expiresAt))
		signals = append(signals, capability.BusinessSignal{
			ID:       "documents.expired:" + document.id,
			Severity: "red",
			Module:   "documents",
			Subject:  fmt.Sprintf("Document %s expired %d %s ago", quoteTitle(document.title), days, dayWord(days)),
			Detail:   fmt.Sprintf("Past its validity date (%s). Renew it, or archive it so it stops looking current.", document.expiresAt.UTC().Format("2006-01-02")),
			Evidence: evidence("document", document.id),
		})
	}
	return signals, rows.Err()
}
