package outbox

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const marketingEmailPollInterval = 2 * time.Second

var ErrInvalidMarketingEmail = errors.New("invalid marketing email outbox payload")

type marketingEmailPayload struct {
	To         string `json:"to"`
	Subject    string `json:"subject"`
	Text       string `json:"text"`
	CustomerID string `json:"customerId"`
}

type MarketingEmailConfig struct {
	Host   string
	Port   int
	Secure bool
	User   string
	Pass   string
	From   string
}

type MarketingEmailSender func(context.Context, MarketingEmailConfig, ClaimedMessage, marketingEmailPayload) (json.RawMessage, error)

type MarketingEmailWorker struct {
	pool     dbx.Beginner
	claim    QueryRower
	workerID string
	lease    time.Duration
	config   MarketingEmailConfig
	send     MarketingEmailSender
	now      func() time.Time
}

type MarketingEmailOptions struct {
	WorkerID      string
	LeaseDuration time.Duration
	Config        MarketingEmailConfig
	Send          MarketingEmailSender
	Now           func() time.Time
}

func NewMarketingEmailWorker(pool dbx.Beginner, claim QueryRower, options MarketingEmailOptions) (*MarketingEmailWorker, error) {
	if pool == nil || claim == nil {
		return nil, errors.New("marketing email worker requires a database pool")
	}
	workerID := options.WorkerID
	if workerID == "" {
		workerID = fmt.Sprintf("go-marketing-email:%d", time.Now().UnixNano())
	}
	lease := options.LeaseDuration
	if lease == 0 {
		lease = DefaultLeaseDuration
	}
	if lease < time.Second || lease > 5*time.Minute {
		return nil, errors.New("marketing email lease must be between 1 second and 5 minutes")
	}
	if options.Config.Port == 0 {
		options.Config.Port = 587
	}
	if options.Config.From == "" {
		options.Config.From = "chaste@localhost"
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	sender := options.Send
	if sender == nil {
		sender = sendMarketingEmailSMTP
	}
	return &MarketingEmailWorker{pool: pool, claim: claim, workerID: workerID, lease: lease, config: options.Config, send: sender, now: now}, nil
}

func (w *MarketingEmailWorker) ClaimOne(ctx context.Context) (*ClaimedMessage, error) {
	var claimed ClaimedMessage
	err := w.claim.QueryRow(ctx, `
		SELECT id, org_id, kind, provider_operation_id, attempts, max_attempts,
		       fencing_token, lease_owner, lease_expires_at
		FROM outbox_worker.claim_marketing_email($1, $2)`, w.workerID, w.lease.Milliseconds()).Scan(
		&claimed.ID, &claimed.OrgID, &claimed.Kind, &claimed.ProviderOperationID,
		&claimed.Attempts, &claimed.MaxAttempts, &claimed.FencingToken, &claimed.LeaseOwner, &claimed.LeaseExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if claimed.Kind != "email" || claimed.OrgID == "" || claimed.ID == "" || claimed.LeaseOwner != w.workerID {
		return nil, errors.New("marketing email claim returned invalid lease metadata")
	}
	return &claimed, nil
}

func (w *MarketingEmailWorker) payloadAndEligibility(ctx context.Context, claim ClaimedMessage) (marketingEmailPayload, bool, error) {
	var payload marketingEmailPayload
	eligible := false
	_, err := dbx.WithOrgTx(ctx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT payload FROM public.outbox_messages
			WHERE id=$1::uuid AND org_id=$2::uuid AND kind='email' AND dedupe_key LIKE 'marketing:%'
			AND status='processing' AND lease_owner=$3 AND fencing_token=$4
			AND lease_expires_at > clock_timestamp()`, claim.ID, claim.OrgID, claim.LeaseOwner, claim.FencingToken).Scan(&raw); err != nil {
			return struct{}{}, err
		}
		if len(raw) > 16*1024 {
			return struct{}{}, fmt.Errorf("%w: payload too large", ErrInvalidMarketingEmail)
		}
		decoder := json.NewDecoder(io.LimitReader(strings.NewReader(string(raw)), 16*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !validMarketingEmailPayload(payload) {
			return struct{}{}, fmt.Errorf("%w: decode fields", ErrInvalidMarketingEmail)
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			return struct{}{}, fmt.Errorf("%w: trailing data", ErrInvalidMarketingEmail)
		}
		var email *string
		var optedOut, deactivated bool
		err := tx.QueryRow(ctx, `SELECT email, marketing_opt_out, deactivated_at IS NOT NULL
			FROM public.customers WHERE id=$1::uuid AND org_id=$2::uuid`, payload.CustomerID, claim.OrgID).Scan(&email, &optedOut, &deactivated)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, nil
		}
		if err != nil {
			return struct{}{}, err
		}
		eligible = email != nil && *email == payload.To && !optedOut && !deactivated
		return struct{}{}, nil
	})
	return payload, eligible, err
}

func validMarketingEmailPayload(payload marketingEmailPayload) bool {
	if len(payload.To) == 0 || len(payload.To) > 254 || strings.TrimSpace(payload.To) != payload.To || strings.ContainsAny(payload.To, "\r\n\x00") {
		return false
	}
	parsed, err := mail.ParseAddress(payload.To)
	if err != nil || parsed.Address != payload.To || strings.Count(payload.To, "@") != 1 || !strings.Contains(strings.SplitN(payload.To, "@", 2)[1], ".") {
		return false
	}
	if len(payload.Subject) == 0 || len(payload.Subject) > 998 || strings.ContainsAny(payload.Subject, "\r\n\x00") || len(payload.Text) > 10000 {
		return false
	}
	if len(payload.CustomerID) != 36 || strings.Count(payload.CustomerID, "-") != 4 {
		return false
	}
	for _, r := range payload.CustomerID {
		if r != '-' && !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func sendMarketingEmailSMTP(ctx context.Context, config MarketingEmailConfig, claim ClaimedMessage, payload marketingEmailPayload) (json.RawMessage, error) {
	from, err := mail.ParseAddress(config.From)
	if err != nil {
		return nil, errors.New("invalid SMTP sender address")
	}
	to, err := mail.ParseAddress(payload.To)
	if err != nil || to.Address != payload.To {
		return nil, errors.New("invalid marketing recipient address")
	}
	if strings.TrimSpace(config.Host) == "" || strings.ContainsAny(config.Host, "/\r\n") || config.Port < 1 || config.Port > 65535 {
		return nil, errors.New("invalid SMTP endpoint")
	}
	address := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	if config.Secure {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		conn = tlsConn
	}
	client, err := smtp.NewClient(conn, config.Host)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	if !config.Secure {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return nil, errors.New("marketing email delivery requires TLS")
		}
		if err := client.StartTLS(&tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return nil, err
		}
	}
	if config.User != "" || config.Pass != "" {
		if config.User == "" || config.Pass == "" {
			return nil, errors.New("SMTP_USER and SMTP_PASS must both be set")
		}
		if err := client.Auth(smtp.PlainAuth("", config.User, config.Pass, config.Host)); err != nil {
			return nil, err
		}
	}
	if err := client.Mail(from.Address); err != nil {
		return nil, err
	}
	if err := client.Rcpt(to.Address); err != nil {
		return nil, err
	}
	writer, err := client.Data()
	if err != nil {
		return nil, err
	}
	messageID := fmt.Sprintf("<%s@chaste.local>", claim.ProviderOperationID)
	subject := marketingEmailSubject(payload.Subject)
	message := "To: " + to.String() + "\r\nFrom: " + from.String() + "\r\nSubject: " + subject + "\r\nMessage-ID: " + messageID + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + payload.Text + "\r\n"
	if _, err := writer.Write([]byte(message)); err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if err := client.Quit(); err != nil {
		return nil, err
	}
	receipt, _ := json.Marshal(map[string]string{"messageId": messageID})
	return receipt, nil
}

func marketingEmailSubject(subject string) string {
	safe := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, subject)
	return mime.QEncoding.Encode("UTF-8", safe)
}

func (w *MarketingEmailWorker) ProcessOne(ctx context.Context) (bool, error) {
	claim, err := w.ClaimOne(ctx)
	if err != nil || claim == nil {
		return claim != nil, err
	}
	deliveryCtx, cancel := context.WithCancel(ctx)
	stopHeartbeat := w.maintainLease(ctx, *claim, cancel)
	payload, eligible, err := w.payloadAndEligibility(deliveryCtx, *claim)
	if err != nil {
		cancel()
		if stopHeartbeat() {
			return true, nil
		}
		status, message := "unknown", unknownOutcome+": marketing email payload could not be safely delivered"
		if errors.Is(err, ErrInvalidMarketingEmail) {
			status = "failed"
			message = err.Error()
		}
		return true, w.finalize(ctx, *claim, DeliveryResult{Status: status, LastError: &message})
	}
	result := DeliveryResult{Status: "failed"}
	if !eligible {
		message := "marketing recipient is no longer eligible at dispatch time"
		result.LastError = &message
	} else if w.config.Host == "" {
		message := "SMTP is not configured"
		result.LastError = &message
	} else {
		receipt, sendErr := w.send(deliveryCtx, w.config, *claim, payload)
		if sendErr != nil {
			message := unknownOutcome + ": " + sendErr.Error()
			result.Status = "unknown"
			result.LastError = &message
		} else {
			result.Status = "sent"
			result.ProviderReceipt = receipt
		}
	}
	cancel()
	if stopHeartbeat() {
		return true, nil
	}
	return true, w.finalize(ctx, *claim, result)
}

func (w *MarketingEmailWorker) finalize(ctx context.Context, claim ClaimedMessage, result DeliveryResult) error {
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
		return struct{}{}, tx.QueryRow(ctx, `UPDATE public.outbox_messages SET status=$5, provider_receipt=$6::jsonb, last_error=$7,
			lease_owner=NULL, lease_expires_at=NULL, completed_at=$8, updated_at=clock_timestamp()
			WHERE id=$1::uuid AND org_id=$2::uuid AND kind='email' AND dedupe_key LIKE 'marketing:%'
			AND status='processing' AND lease_owner=$3 AND fencing_token=$4 AND lease_expires_at > clock_timestamp()
			RETURNING id::text`, claim.ID, claim.OrgID, claim.LeaseOwner, claim.FencingToken, result.Status, receipt, result.LastError, completedAt).Scan(&updated)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("marketing email acknowledgement was fenced or its lease expired")
	}
	return err
}

func (w *MarketingEmailWorker) maintainLease(ctx context.Context, claim ClaimedMessage, cancel context.CancelFunc) func() bool {
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
			}
		}
	}()
	return func() bool { close(stop); <-done; return lost }
}

func (w *MarketingEmailWorker) renewLease(ctx context.Context, claim ClaimedMessage) (bool, error) {
	var updated string
	_, err := dbx.WithOrgTx(ctx, w.pool, claim.OrgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `UPDATE public.outbox_messages SET lease_expires_at=clock_timestamp()+($5*interval '1 millisecond'), updated_at=clock_timestamp()
			WHERE id=$1::uuid AND org_id=$2::uuid AND kind='email' AND dedupe_key LIKE 'marketing:%' AND status='processing'
			AND lease_owner=$3 AND fencing_token=$4 AND lease_expires_at > clock_timestamp() RETURNING id::text`,
			claim.ID, claim.OrgID, claim.LeaseOwner, claim.FencingToken, w.lease.Milliseconds()).Scan(&updated)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (w *MarketingEmailWorker) Run(ctx context.Context) error {
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
