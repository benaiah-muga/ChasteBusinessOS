package outbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const (
	DefaultLeaseDuration  = 60 * time.Second
	DefaultPollInterval   = 2 * time.Second
	DefaultRequestTimeout = 5 * time.Second
	unknownOutcome        = "provider outcome unknown; reconcile before retrying"
)

var ErrInvalidPayload = errors.New("invalid webhook payload")

type QueryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type ClaimedMessage struct {
	ID                  string
	OrgID               string
	Kind                string
	ProviderOperationID string
	Attempts            int
	MaxAttempts         int
	FencingToken        int
	LeaseOwner          string
	LeaseExpiresAt      time.Time
}

type webhookPayload struct {
	URL  string                     `json:"url"`
	Body map[string]json.RawMessage `json:"body"`
}

type DeliveryResult struct {
	Status          string
	LastError       *string
	ProviderReceipt json.RawMessage
	AvailableAt     *time.Time
}

type Worker struct {
	pool        dbx.Beginner
	claim       QueryRower
	workerID    string
	lease       time.Duration
	requestTime time.Duration
	client      *http.Client
	now         func() time.Time
}

type Options struct {
	WorkerID       string
	LeaseDuration  time.Duration
	RequestTimeout time.Duration
	HTTPClient     *http.Client
	Now            func() time.Time
}

func NewWorker(pool dbx.Beginner, claim QueryRower, options Options) (*Worker, error) {
	if pool == nil || claim == nil {
		return nil, errors.New("outbox worker requires a database pool")
	}
	workerID := options.WorkerID
	if workerID == "" {
		workerID = fmt.Sprintf("go-outbox:%d:%d", time.Now().UnixNano(), time.Now().Unix())
	}
	lease := options.LeaseDuration
	if lease == 0 {
		lease = DefaultLeaseDuration
	}
	if lease < time.Second || lease > 5*time.Minute {
		return nil, errors.New("outbox worker lease must be between 1 second and 5 minutes")
	}
	requestTimeout := options.RequestTimeout
	if requestTimeout == 0 {
		requestTimeout = DefaultRequestTimeout
	}
	if requestTimeout <= 0 || requestTimeout > 5*time.Minute {
		return nil, errors.New("outbox webhook timeout must be between zero and five minutes")
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: requestTimeout}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Worker{
		pool:        pool,
		claim:       claim,
		workerID:    workerID,
		lease:       lease,
		requestTime: requestTimeout,
		client:      client,
		now:         now,
	}, nil
}

func (w *Worker) ClaimOne(ctx context.Context) (*ClaimedMessage, error) {
	var claimed ClaimedMessage
	err := w.claim.QueryRow(ctx, `
		SELECT id, org_id, kind, provider_operation_id, attempts, max_attempts,
		       fencing_token, lease_owner, lease_expires_at
		FROM outbox_worker.claim_webhook($1, $2)`, w.workerID, w.lease.Milliseconds()).Scan(
		&claimed.ID,
		&claimed.OrgID,
		&claimed.Kind,
		&claimed.ProviderOperationID,
		&claimed.Attempts,
		&claimed.MaxAttempts,
		&claimed.FencingToken,
		&claimed.LeaseOwner,
		&claimed.LeaseExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if claimed.Kind != "webhook" || claimed.OrgID == "" || claimed.ID == "" || claimed.LeaseOwner != w.workerID {
		return nil, errors.New("webhook claim returned invalid lease metadata")
	}
	return &claimed, nil
}

func (w *Worker) payload(ctx context.Context, claim ClaimedMessage) (webhookPayload, error) {
	var payload webhookPayload
	_, err := dbx.WithOrgTx(ctx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		var raw []byte
		err := tx.QueryRow(ctx, `
			SELECT payload
			FROM public.outbox_messages
			WHERE id = $1::uuid
			  AND org_id = $2::uuid
			  AND kind = 'webhook'
			  AND status = 'processing'
			  AND lease_owner = $3
			  AND fencing_token = $4
			  AND lease_expires_at > clock_timestamp()`,
			claim.ID, claim.OrgID, claim.LeaseOwner, claim.FencingToken,
		).Scan(&raw)
		if err != nil {
			return struct{}{}, err
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return struct{}{}, fmt.Errorf("%w: decode JSON", ErrInvalidPayload)
		}
		if payload.Body == nil {
			return struct{}{}, fmt.Errorf("%w: body must be a JSON object", ErrInvalidPayload)
		}
		parsedURL, err := url.ParseRequestURI(payload.URL)
		if err != nil || !parsedURL.IsAbs() || parsedURL.Hostname() == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
			return struct{}{}, fmt.Errorf("%w: URL must be absolute HTTP or HTTPS", ErrInvalidPayload)
		}
		return struct{}{}, nil
	})
	return payload, err
}

func (w *Worker) send(ctx context.Context, claim ClaimedMessage, payload webhookPayload) DeliveryResult {
	body, err := json.Marshal(payload.Body)
	if err != nil {
		return unknownResult(fmt.Sprintf("%s: encode request body", unknownOutcome))
	}
	requestCtx, cancel := context.WithTimeout(ctx, w.requestTime)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, payload.URL, bytes.NewReader(body))
	if err != nil {
		return unknownResult(fmt.Sprintf("%s: create webhook request", unknownOutcome))
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("idempotency-key", claim.ProviderOperationID)
	request.Header.Set("x-chaste-outbox-id", claim.ID)
	response, err := w.client.Do(request)
	if err != nil {
		return unknownResult(fmt.Sprintf("%s: webhook transport failed", unknownOutcome))
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
	receipt, _ := json.Marshal(map[string]any{
		"status":              response.StatusCode,
		"providerOperationId": claim.ProviderOperationID,
	})
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
		return DeliveryResult{Status: "sent", ProviderReceipt: receipt}
	}
	if response.StatusCode == http.StatusTooManyRequests {
		retryAfter := retryAfterDuration(response.Header.Get("Retry-After"))
		next := w.now().Add(retryAfter)
		message := fmt.Sprintf("webhook rate limited (%d)", response.StatusCode)
		return DeliveryResult{Status: "pending", LastError: &message, ProviderReceipt: receipt, AvailableAt: &next}
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 {
		message := fmt.Sprintf("webhook rejected (%d)", response.StatusCode)
		return DeliveryResult{Status: "failed", LastError: &message, ProviderReceipt: receipt}
	}
	message := fmt.Sprintf("webhook provider outcome unknown (%d)", response.StatusCode)
	return DeliveryResult{Status: "unknown", LastError: &message, ProviderReceipt: receipt}
}

func retryAfterDuration(value string) time.Duration {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Second
	}
	seconds, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 30 * time.Second
	}
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return 30 * time.Second
	}
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 300 {
		seconds = 300
	}
	return time.Duration(seconds * float64(time.Second))
}

func unknownResult(message string) DeliveryResult {
	return DeliveryResult{Status: "unknown", LastError: &message}
}

func (w *Worker) finalize(ctx context.Context, claim ClaimedMessage, result DeliveryResult) (bool, error) {
	if result.Status != "pending" && result.Status != "sent" && result.Status != "unknown" && result.Status != "failed" {
		return false, errors.New("invalid outbox delivery result")
	}
	var completedAt *time.Time
	if result.Status != "pending" {
		now := w.now()
		completedAt = &now
	}
	receipt := any(nil)
	if len(result.ProviderReceipt) > 0 {
		receipt = []byte(result.ProviderReceipt)
	}
	var updatedID string
	_, err := dbx.WithOrgTx(ctx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `
			UPDATE public.outbox_messages
			SET status = $5,
			    available_at = COALESCE($6::timestamptz, available_at),
			    provider_receipt = $7::jsonb,
			    last_error = $8,
			    lease_owner = NULL,
			    lease_expires_at = NULL,
			    completed_at = $9,
			    updated_at = clock_timestamp()
			WHERE id = $1::uuid
			  AND org_id = $2::uuid
			  AND kind = 'webhook'
			  AND status = 'processing'
			  AND lease_owner = $3
			  AND fencing_token = $4
			  AND lease_expires_at > clock_timestamp()
			RETURNING id::text`,
			claim.ID,
			claim.OrgID,
			claim.LeaseOwner,
			claim.FencingToken,
			result.Status,
			result.AvailableAt,
			receipt,
			result.LastError,
			completedAt,
		).Scan(&updatedID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ProcessOne claims and handles at most one webhook. Unknown provider outcomes
// remain closed for operator reconciliation instead of being retried.
func (w *Worker) ProcessOne(ctx context.Context) (bool, error) {
	claim, err := w.ClaimOne(ctx)
	if err != nil || claim == nil {
		return claim != nil, err
	}
	deliveryCtx, cancelDelivery := context.WithCancel(ctx)
	stopHeartbeat := w.maintainLease(ctx, *claim, cancelDelivery)
	payload, err := w.payload(deliveryCtx, *claim)
	if err != nil {
		cancelDelivery()
		if stopHeartbeat() {
			return true, nil
		}
		if errors.Is(err, ErrInvalidPayload) || errors.Is(err, pgx.ErrNoRows) {
			result := unknownResult("provider outcome unknown; webhook payload could not be safely delivered")
			finalized, finalizeErr := w.finalize(ctx, *claim, result)
			if finalizeErr != nil {
				return true, finalizeErr
			}
			if !finalized {
				return true, nil
			}
			return true, nil
		}
		return true, err
	}
	result := w.send(deliveryCtx, *claim, payload)
	cancelDelivery()
	if stopHeartbeat() {
		return true, nil
	}
	finalized, err := w.finalize(ctx, *claim, result)
	if err != nil {
		return true, err
	}
	if !finalized {
		return true, errors.New("outbox webhook acknowledgement was fenced or its lease expired")
	}
	return true, nil
}

func (w *Worker) maintainLease(ctx context.Context, claim ClaimedMessage, cancelDelivery context.CancelFunc) func() bool {
	interval := w.lease / 3
	if interval < 100*time.Millisecond {
		interval = 100 * time.Millisecond
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	var leaseLost atomic.Bool
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				updated, err := renewLease(ctx, w.pool, claim, w.lease)
				if err != nil {
					continue
				}
				if !updated {
					leaseLost.Store(true)
					cancelDelivery()
					return
				}
			}
		}
	}()
	return func() bool {
		close(stop)
		<-done
		return leaseLost.Load()
	}
}

func renewLease(ctx context.Context, pool dbx.Beginner, claim ClaimedMessage, lease time.Duration) (bool, error) {
	var updatedID string
	_, err := dbx.WithOrgTx(ctx, pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `
			UPDATE public.outbox_messages
			SET lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'),
			    updated_at = clock_timestamp()
			WHERE id = $1::uuid
			  AND org_id = $2::uuid
			  AND kind = 'webhook'
			  AND status = 'processing'
			  AND lease_owner = $3
			  AND fencing_token = $4
			  AND lease_expires_at > clock_timestamp()
			RETURNING id::text`,
			claim.ID, claim.OrgID, claim.LeaseOwner, claim.FencingToken, lease.Milliseconds(),
		).Scan(&updatedID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

type ReconcileInput struct {
	OrgID           string
	OutboxID        string
	Status          string
	ProviderReceipt json.RawMessage
	Note            *string
}

func (w *Worker) Reconcile(ctx context.Context, input ReconcileInput) (bool, error) {
	if input.OrgID == "" || input.OutboxID == "" || (input.Status != "sent" && input.Status != "failed") {
		return false, errors.New("outbox reconciliation requires an organization, message, and sent or failed status")
	}
	receipt := any(nil)
	if len(input.ProviderReceipt) > 0 {
		if !json.Valid(input.ProviderReceipt) {
			return false, errors.New("provider receipt must be valid JSON")
		}
		receipt = []byte(input.ProviderReceipt)
	}
	var updatedID string
	_, err := dbx.WithOrgTx(ctx, w.pool, input.OrgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `
			UPDATE public.outbox_messages
			SET status = $3,
			    provider_receipt = $4::jsonb,
			    last_error = $5,
			    lease_owner = NULL,
			    lease_expires_at = NULL,
			    completed_at = clock_timestamp(),
			    updated_at = clock_timestamp()
			WHERE id = $1::uuid
			  AND org_id = $2::uuid
			  AND kind = 'webhook'
			  AND status = 'unknown'
			RETURNING id::text`,
			input.OutboxID, input.OrgID, input.Status, receipt, input.Note,
		).Scan(&updatedID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (w *Worker) Run(ctx context.Context) error {
	for {
		processed, err := w.ProcessOne(ctx)
		if err != nil {
			return err
		}
		if processed {
			continue
		}
		timer := time.NewTimer(DefaultPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
