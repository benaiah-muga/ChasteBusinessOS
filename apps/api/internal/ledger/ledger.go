package ledger

import (
	"context"
	"encoding/json"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type Event struct {
	Seq          int64           `json:"seq"`
	Kind         string          `json:"kind"`
	CapabilityID *string         `json:"capabilityId"`
	ActorType    string          `json:"actorType"`
	ActorID      *string         `json:"actorId"`
	SessionID    *string         `json:"sessionId"`
	Payload      json.RawMessage `json:"payload"`
	Hash         string          `json:"hash"`
	PrevHash     *string         `json:"prevHash"`
	OccurredAt   string          `json:"occurredAt"`
}

type Reader interface {
	RecentForOrg(context.Context, string, int) ([]Event, error)
}

type PostgresReader struct {
	pool dbx.Beginner
}

func NewPostgresReader(pool dbx.Beginner) *PostgresReader {
	return &PostgresReader{pool: pool}
}

func (r *PostgresReader) RecentForOrg(ctx context.Context, orgID string, limit int) ([]Event, error) {
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) ([]Event, error) {
		rows, err := tx.Query(ctx, `
			SELECT seq, kind, capability_id, actor_type, actor_id, session_id,
			       payload, hash, prev_hash, occurred_at
			FROM ledger_events
			WHERE org_id = $1
			ORDER BY seq DESC
			LIMIT $2`, orgID, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		events := make([]Event, 0, limit)
		for rows.Next() {
			var event Event
			var capabilityID pgtype.Text
			var actorID pgtype.UUID
			var sessionID pgtype.UUID
			var payload []byte
			var prevHash pgtype.Text
			var occurredAt time.Time
			if err := rows.Scan(
				&event.Seq,
				&event.Kind,
				&capabilityID,
				&event.ActorType,
				&actorID,
				&sessionID,
				&payload,
				&event.Hash,
				&prevHash,
				&occurredAt,
			); err != nil {
				return nil, err
			}
			event.CapabilityID = nullableText(capabilityID)
			event.ActorID = nullableUUID(actorID)
			event.SessionID = nullableUUID(sessionID)
			event.Payload = append(json.RawMessage(nil), payload...)
			event.PrevHash = nullableText(prevHash)
			event.OccurredAt = occurredAt.UTC().Format("2006-01-02T15:04:05.000Z")
			events = append(events, event)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return events, nil
	})
}

func nullableText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func nullableUUID(value pgtype.UUID) *string {
	if !value.Valid {
		return nil
	}
	result := value.String()
	return &result
}
