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

const documentsReviewDays = 2

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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	awaiting, err := documentsAwaitingAction(ctx, tx, orgID, now)
	if err != nil {
		return nil, err
	}
	signals = append(signals, awaiting...)
	return signals, nil
}

type awaitingDocumentRow struct {
	id              string
	title           string
	suggestionCount int64
}

func documentsAwaitingAction(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	cutoff := now.Add(-time.Duration(documentsReviewDays) * 24 * time.Hour)
	rows, err := tx.Query(ctx, `
		SELECT d.id::text, d.title, count(s.id)
		FROM documents d
		JOIN document_suggestions s ON s.document_id = d.id AND s.org_id = d.org_id AND s.status = 'open'
		WHERE d.org_id = $1::uuid
		  AND d.status = 'parsed'
		  AND d.ref_type IS NULL
		  AND d.ref_id IS NULL
		  AND d.created_at < $2
		GROUP BY d.id, d.title
		ORDER BY d.id ASC
		LIMIT 100`, orgID, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	signals := make([]capability.BusinessSignal, 0)
	for rows.Next() {
		var document awaitingDocumentRow
		if err := rows.Scan(&document.id, &document.title, &document.suggestionCount); err != nil {
			return nil, err
		}
		signals = append(signals, capability.BusinessSignal{
			ID:       "documents.awaitingAction:" + document.id,
			Severity: "orange",
			Module:   "documents",
			Subject:  fmt.Sprintf("Document %s is parsed but not recorded", quoteTitle(document.title)),
			Detail:   fmt.Sprintf("%d coded %s waiting for review. Create the supplier bill from the extracted lines, or dismiss the document so the queue stays honest.", document.suggestionCount, pluralWord(document.suggestionCount, "line is", "lines are")),
			Evidence: evidence("document", document.id),
		})
	}
	return signals, rows.Err()
}

func pluralWord(count int64, one, many string) string {
	if count == 1 {
		return one
	}
	return many
}
