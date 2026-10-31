package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const supportAutoReplyDraftLimit = 3
const supportAutoReplyOrganizationDraftLimit = 30
const supportAutoReplyOrganizationConcurrencyLimit = 4
const supportAutoReplyReservationTTL = 5 * time.Minute
const supportAutoReplyBudgetRetention = 2 * time.Hour
const supportAutoReplyCleanupBatch = 100

var errMissingSupportAutoReplyConversationID = errors.New("support conversation id is required")

// reserveSupportAutoReplyDraft applies per-conversation and per-organization
// fixed-window limits, and reserves one of the organization's concurrent
// drafting slots. The returned reservation ID must be released after drafting;
// the database also expires abandoned reservations after five minutes.
func reserveSupportAutoReplyDraft(
	ctx context.Context,
	pool *pgxpool.Pool,
	orgID, conversationID string,
	now time.Time,
) (string, bool, error) {
	if orgID == "" || conversationID == "" {
		if orgID == "" {
			return "", false, dbx.ErrMissingOrgID
		}
		return "", false, errMissingSupportAutoReplyConversationID
	}

	type decision struct {
		reservationID string
		allowed       bool
	}
	result, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (decision, error) {
		now = now.UTC()
		retentionCutoff := now.Add(-supportAutoReplyBudgetRetention)
		// Prune old per-thread counters in bounded batches. Conversation
		// deletion also cascades through the migration's foreign key.
		if _, err := tx.Exec(ctx, `
			DELETE FROM support_auto_reply_draft_limits
			WHERE ctid IN (
				SELECT ctid FROM support_auto_reply_draft_limits
				WHERE org_id = $1::uuid AND window_started_at < $2
				LIMIT $3
			)`, orgID, retentionCutoff, supportAutoReplyCleanupBatch); err != nil {
			return decision{}, err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM support_auto_reply_reservations
			WHERE reservation_id IN (
				SELECT reservation_id FROM support_auto_reply_reservations
				WHERE org_id = $1::uuid AND expires_at <= $2
			LIMIT $3
			)`, orgID, now, supportAutoReplyCleanupBatch); err != nil {
			return decision{}, err
		}

		// This row lock serializes all admissions for one organization, so new
		// conversations cannot evade either organization-wide limit.
		var orgDraftCount int
		var orgWindow time.Time
		if err := tx.QueryRow(ctx, `
			INSERT INTO support_auto_reply_org_draft_limits (org_id, window_started_at, draft_count)
			VALUES ($1::uuid, $2, 0)
			ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
			RETURNING window_started_at, draft_count`, orgID, now).Scan(&orgWindow, &orgDraftCount); err != nil {
			return decision{}, err
		}
		if !orgWindow.After(now.Add(-time.Minute)) {
			orgWindow = now
			orgDraftCount = 0
			if _, err := tx.Exec(ctx, `UPDATE support_auto_reply_org_draft_limits SET window_started_at = $2, draft_count = 0 WHERE org_id = $1::uuid`, orgID, now); err != nil {
				return decision{}, err
			}
		}
		var activeReservations int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM support_auto_reply_reservations WHERE org_id = $1::uuid AND expires_at > $2`, orgID, now).Scan(&activeReservations); err != nil {
			return decision{}, err
		}
		if activeReservations >= supportAutoReplyOrganizationConcurrencyLimit || orgDraftCount >= supportAutoReplyOrganizationDraftLimit {
			return decision{}, nil
		}

		var conversationAllowed bool
		err := tx.QueryRow(ctx, `
			INSERT INTO support_auto_reply_draft_limits (
				org_id, conversation_id, window_started_at, draft_count
			)
			VALUES ($1::uuid, $2::uuid, $3, 1)
			ON CONFLICT (org_id, conversation_id) DO UPDATE
			SET window_started_at = CASE
					WHEN support_auto_reply_draft_limits.window_started_at <= $3 - interval '60 seconds' THEN $3
					ELSE support_auto_reply_draft_limits.window_started_at
				END,
				draft_count = CASE
					WHEN support_auto_reply_draft_limits.window_started_at <= $3 - interval '60 seconds' THEN 1
					ELSE support_auto_reply_draft_limits.draft_count + 1
				END
			WHERE support_auto_reply_draft_limits.window_started_at <= $3 - interval '60 seconds'
			   OR support_auto_reply_draft_limits.draft_count < $4
			RETURNING true`, orgID, conversationID, now, supportAutoReplyDraftLimit).Scan(&conversationAllowed)
		if errors.Is(err, pgx.ErrNoRows) {
			return decision{}, nil
		}
		if err != nil {
			return decision{}, err
		}
		var reservationID string
		if err := tx.QueryRow(ctx, `INSERT INTO support_auto_reply_reservations (org_id, expires_at) VALUES ($1::uuid, $2) RETURNING reservation_id::text`, orgID, now.Add(supportAutoReplyReservationTTL)).Scan(&reservationID); err != nil {
			return decision{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE support_auto_reply_org_draft_limits SET draft_count = draft_count + 1 WHERE org_id = $1::uuid`, orgID); err != nil {
			return decision{}, err
		}
		return decision{reservationID: reservationID, allowed: true}, nil
	})
	return result.reservationID, result.allowed, err
}

func releaseSupportAutoReplyDraft(ctx context.Context, pool *pgxpool.Pool, orgID, reservationID string) error {
	if orgID == "" {
		return dbx.ErrMissingOrgID
	}
	if reservationID == "" {
		return errors.New("support auto-reply reservation id is required")
	}
	_, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `DELETE FROM support_auto_reply_reservations WHERE org_id = $1::uuid AND reservation_id = $2::uuid`, orgID, reservationID)
		return struct{}{}, err
	})
	return err
}

// allowSupportAutoReplyDraft is retained for short admission-only callers.
// Long-running draft requests should reserve and release a concurrency slot.
func allowSupportAutoReplyDraft(
	ctx context.Context,
	pool *pgxpool.Pool,
	orgID, conversationID string,
	now time.Time,
) (bool, error) {
	if orgID == "" || conversationID == "" {
		if orgID == "" {
			return false, dbx.ErrMissingOrgID
		}
		return false, errMissingSupportAutoReplyConversationID
	}

	reservationID, allowed, err := reserveSupportAutoReplyDraft(ctx, pool, orgID, conversationID, now)
	if err != nil || !allowed {
		return allowed, err
	}
	if err := releaseSupportAutoReplyDraft(ctx, pool, orgID, reservationID); err != nil {
		return false, err
	}
	return true, nil
}
