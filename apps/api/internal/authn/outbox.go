package authn

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maxPendingAuthEmails = 10000
	mailOutboxLease      = 30 * time.Second
	mailWorkerPoll       = 500 * time.Millisecond
	mailRetryMax         = 5 * time.Minute
)

type emailOutboxJob struct {
	ID              string
	Kind            string
	Recipient       string
	Link            string
	TokenIdentifier *string
	ExpiresAt       time.Time
	Attempts        int
}

// enqueueLink writes the sensitive link in the same transaction as the
// account or recovery token, so a successful API response always has a
// durable delivery record.
func (s *Service) enqueueLink(ctx context.Context, tx pgx.Tx, job linkDelivery) error {
	if (job.verification && s.verificationLinkSender == nil) || (!job.verification && s.recoveryLinkSender == nil) {
		return ErrDeliveryUnavailable
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(18994477, 11)`); err != nil {
		return err
	}
	var pending int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE expires_at > now()`).Scan(&pending); err != nil {
		return err
	}
	if pending >= maxPendingAuthEmails {
		return ErrDeliveryUnavailable
	}
	id, err := randomIDBytes(24)
	if err != nil {
		return err
	}
	kind := "recovery"
	expiresAt := s.now().UTC().Add(recoveryLifetime)
	var tokenIdentifier any
	if job.verification {
		kind = "verification"
		expiresAt = s.now().UTC().Add(VerificationLifetime)
	} else if job.cleanupIdentifier != "" {
		tokenIdentifier = job.cleanupIdentifier
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_email_outbox (id, kind, recipient, link, token_identifier, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)`, id, kind, job.email, job.link, tokenIdentifier, expiresAt)
	if err != nil {
		return fmt.Errorf("enqueue auth email: %w", err)
	}
	return nil
}

func (s *Service) claimEmail(ctx context.Context) (emailOutboxJob, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return emailOutboxJob{}, false, err
	}
	defer tx.Rollback(context.Background())
	var job emailOutboxJob
	err = tx.QueryRow(ctx, `
		WITH candidate AS (
			SELECT id FROM auth_email_outbox
			WHERE expires_at > now() AND available_at <= now()
			  AND (lease_expires_at IS NULL OR lease_expires_at <= now())
			ORDER BY available_at, created_at
			FOR UPDATE SKIP LOCKED LIMIT 1
		)
		UPDATE auth_email_outbox o
		SET lease_owner = $1, lease_expires_at = now() + $2::interval, attempts = attempts + 1
		FROM candidate c WHERE o.id = c.id
		RETURNING o.id, o.kind, o.recipient, o.link, o.token_identifier, o.expires_at, o.attempts`,
		s.workerID, mailOutboxLease.String()).Scan(&job.ID, &job.Kind, &job.Recipient, &job.Link, &job.TokenIdentifier, &job.ExpiresAt, &job.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return emailOutboxJob{}, false, err
		}
		return emailOutboxJob{}, false, nil
	}
	if err != nil {
		return emailOutboxJob{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return emailOutboxJob{}, false, err
	}
	return job, true, nil
}

// ProcessEmailOutboxOnce claims at most one job. Failed deliveries are
// retained with backoff, and leases let another process reclaim work after a
// crash. Delivery errors are deliberately not logged because providers may
// include sensitive message contents in their error strings.
func (s *Service) ProcessEmailOutboxOnce(ctx context.Context) (bool, error) {
	if err := s.pruneEmailOutbox(ctx); err != nil {
		return false, err
	}
	job, found, err := s.claimEmail(ctx)
	if err != nil || !found {
		return found, err
	}
	deliveryCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	if job.Kind == "verification" && s.verificationLinkSender != nil {
		err = s.verificationLinkSender(deliveryCtx, job.Recipient, job.Link)
	} else if job.Kind == "recovery" && s.recoveryLinkSender != nil {
		err = s.recoveryLinkSender(deliveryCtx, job.Recipient, job.Link)
	} else {
		err = ErrDeliveryUnavailable
	}
	cancel()
	if err == nil {
		_, err = s.pool.Exec(ctx, `DELETE FROM auth_email_outbox WHERE id = $1 AND lease_owner = $2`, job.ID, s.workerID)
		if err != nil {
			return true, err
		}
		return true, nil
	}
	backoff := authEmailRetryDelay(job.Attempts)
	_, updateErr := s.pool.Exec(ctx, `
		UPDATE auth_email_outbox SET available_at = now() + $3::interval,
			lease_owner = NULL, lease_expires_at = NULL
		WHERE id = $1 AND lease_owner = $2`, job.ID, s.workerID, backoff.String())
	if updateErr != nil {
		return true, updateErr
	}
	s.logger.Error("authentication email delivery failed; retry scheduled", "kind", job.Kind, "attempt", job.Attempts)
	return true, nil
}

func authEmailRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := time.Second << min(attempt-1, 9)
	if delay > mailRetryMax {
		return mailRetryMax
	}
	return delay
}

func (s *Service) pruneEmailOutbox(ctx context.Context) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `
		WITH expired AS (
			SELECT id, token_identifier FROM auth_email_outbox
			WHERE expires_at <= now() ORDER BY expires_at
			FOR UPDATE SKIP LOCKED LIMIT 500
		), removed AS (
			DELETE FROM auth_email_outbox o USING expired e WHERE o.id = e.id
			RETURNING e.token_identifier
		)
		DELETE FROM auth_verification v USING removed r
		WHERE r.token_identifier IS NOT NULL AND v.identifier = r.token_identifier`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM auth_verification
			WHERE identifier LIKE 'reset-password:%' AND expires_at <= now()
			ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 500
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id = e.id`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RunEmailOutbox owns one bounded poller for this process. Jobs are durable in
// PostgreSQL, so cancellation leaves a leased job for the next process to
// reclaim after its lease expires.
func (s *Service) RunEmailOutbox(ctx context.Context) error {
	ticker := time.NewTicker(mailWorkerPoll)
	defer ticker.Stop()
	databaseFailures := 0
	for {
		worked, err := s.ProcessEmailOutboxOnce(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			databaseFailures++
			retryDelay := time.Second << min(databaseFailures-1, 5)
			s.logger.Error("authentication email outbox database operation failed; retry scheduled", "attempt", databaseFailures)
			timer := time.NewTimer(retryDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			continue
		}
		databaseFailures = 0
		if worked {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
