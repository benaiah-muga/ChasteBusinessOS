package outbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type NotificationEmailWorkerOptions struct {
	WorkerID      string
	LeaseDuration time.Duration
	Config        MarketingEmailConfig
	Send          NotificationEmailSender
	Now           func() time.Time
	Logger        *slog.Logger
}

type NotificationEmailWorker struct {
	pool       dbx.Beginner
	claim      QueryRower
	workerID   string
	lease      time.Duration
	dispatcher *NotificationEmailDispatcher
	now        func() time.Time
	logger     *slog.Logger
}

func NewNotificationEmailWorker(pool dbx.Beginner, claim QueryRower, options NotificationEmailWorkerOptions) (*NotificationEmailWorker, error) {
	if pool == nil || claim == nil {
		return nil, errors.New("notification email worker requires a database pool")
	}
	workerID := options.WorkerID
	if workerID == "" {
		workerID = fmt.Sprintf("go-notification-email:%d", time.Now().UnixNano())
	}
	if len(workerID) > 128 {
		return nil, errors.New("notification email worker id exceeds 128 characters")
	}
	lease := options.LeaseDuration
	if lease == 0 {
		lease = DefaultLeaseDuration
	}
	if lease < time.Second || lease > 5*time.Minute {
		return nil, errors.New("notification email worker lease must be between 1 second and 5 minutes")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &NotificationEmailWorker{
		pool: pool, claim: claim, workerID: workerID, lease: lease,
		dispatcher: NewNotificationEmailDispatcher(options.Config, options.Send), now: now,
		logger: options.Logger,
	}, nil
}

func (w *NotificationEmailWorker) ClaimOne(ctx context.Context) (*NotificationEmailClaim, error) {
	var claim NotificationEmailClaim
	err := w.claim.QueryRow(ctx, `
		SELECT id, org_id, kind, dedupe_key, provider_operation_id, attempts, max_attempts,
		       fencing_token, lease_owner, lease_expires_at
		FROM outbox_worker.claim_notification_email($1, $2)`, w.workerID, w.lease.Milliseconds()).Scan(
		&claim.ID, &claim.OrgID, &claim.Kind, &claim.DedupeKey, &claim.ProviderOperationID,
		&claim.Attempts, &claim.MaxAttempts, &claim.FencingToken, &claim.LeaseOwner, &claim.LeaseExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !validUUID(claim.ID) || !validUUID(claim.OrgID) || claim.Kind != "email" ||
		!validNotificationEmailDedupeKey(claim.DedupeKey) || !validUUID(claim.ProviderOperationID) ||
		claim.LeaseOwner != w.workerID || claim.FencingToken < 1 {
		return nil, errors.New("notification email claim returned invalid lease metadata")
	}
	return &claim, nil
}

func (w *NotificationEmailWorker) ProcessOne(ctx context.Context) (bool, error) {
	claim, err := w.ClaimOne(ctx)
	if err != nil || claim == nil {
		return claim != nil, err
	}
	deliveryCtx, cancel := context.WithCancel(ctx)
	stopHeartbeat := w.maintainLease(ctx, *claim, cancel)
	var raw []byte
	_, err = dbx.WithOrgTx(deliveryCtx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(deliveryCtx, `SELECT payload FROM public.outbox_messages
			WHERE id=$1::uuid AND org_id=$2::uuid AND kind='email' AND dedupe_key=$3
			AND status='processing' AND lease_owner=$4 AND fencing_token=$5
			AND lease_expires_at > clock_timestamp()`, claim.ID, claim.OrgID, claim.DedupeKey, claim.LeaseOwner, claim.FencingToken).Scan(&raw)
	})
	if err != nil {
		cancel()
		if stopHeartbeat() {
			return true, nil
		}
		message := unknownOutcome + ": approval email payload could not be safely read"
		return true, w.finalize(ctx, *claim, DeliveryResult{Status: "unknown", LastError: &message})
	}
	result := w.dispatcher.Deliver(deliveryCtx, *claim, raw)
	cancel()
	if stopHeartbeat() {
		return true, nil
	}
	return true, w.finalize(ctx, *claim, result)
}

func (w *NotificationEmailWorker) finalize(ctx context.Context, claim NotificationEmailClaim, result DeliveryResult) error {
	var completedAt any
	if result.Status != "pending" {
		completedAt = w.now()
	}
	var receipt any
	if len(result.ProviderReceipt) > 0 {
		receipt = []byte(result.ProviderReceipt)
	}
	_, err := dbx.WithOrgTx(ctx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		var updated string
		return struct{}{}, tx.QueryRow(ctx, `UPDATE public.outbox_messages
			SET status=$6, provider_receipt=$7::jsonb, last_error=$8, lease_owner=NULL,
			    lease_expires_at=NULL, completed_at=$9, updated_at=clock_timestamp()
			WHERE id=$1::uuid AND org_id=$2::uuid AND kind='email' AND dedupe_key=$3
			  AND status='processing' AND lease_owner=$4 AND fencing_token=$5
			  AND lease_expires_at > clock_timestamp()
			RETURNING id::text`, claim.ID, claim.OrgID, claim.DedupeKey, claim.LeaseOwner,
			claim.FencingToken, result.Status, receipt, result.LastError, completedAt).Scan(&updated)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("notification email acknowledgement was fenced or its lease expired")
	}
	return err
}

func (w *NotificationEmailWorker) maintainLease(ctx context.Context, claim NotificationEmailClaim, cancel context.CancelFunc) func() bool {
	stop := make(chan struct{})
	done := make(chan struct{})
	var lost bool
	go func() {
		defer close(done)
		ticker := time.NewTicker(w.lease / 3)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				updated, err := w.renewLease(ctx, claim)
				if err == nil && !updated {
					lost = true
					cancel()
					return
				}
				if err != nil && w.logger != nil {
					w.logger.Warn("notification email lease renewal failed", "error", err.Error())
				}
			}
		}
	}()
	return func() bool {
		close(stop)
		<-done
		return lost
	}
}

func (w *NotificationEmailWorker) renewLease(ctx context.Context, claim NotificationEmailClaim) (bool, error) {
	var updated string
	_, err := dbx.WithOrgTx(ctx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `UPDATE public.outbox_messages
			SET lease_expires_at=clock_timestamp()+($6*interval '1 millisecond'), updated_at=clock_timestamp()
			WHERE id=$1::uuid AND org_id=$2::uuid AND kind='email' AND dedupe_key=$3
			  AND status='processing' AND lease_owner=$4 AND fencing_token=$5
			  AND lease_expires_at > clock_timestamp()
			RETURNING id::text`, claim.ID, claim.OrgID, claim.DedupeKey, claim.LeaseOwner,
			claim.FencingToken, w.lease.Milliseconds()).Scan(&updated)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (w *NotificationEmailWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(marketingEmailPollInterval)
	defer ticker.Stop()
	for {
		worked, err := w.ProcessOne(ctx)
		if err != nil && ctx.Err() == nil {
			return err
		}
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
