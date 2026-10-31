package authn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestVerificationOutboxRetriesThenDeliversThroughLocalSMTPSink(t *testing.T) {
	if os.Getenv("CHASTE_AUTH_EMAIL_E2E") != "1" {
		t.Skip("set CHASTE_AUTH_EMAIL_E2E=1 to run the local SMTP and database proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	sender := SMTPVerificationLinkSenderFromEnv()
	if sender == nil {
		t.Fatal("SMTP_HOST must be configured for the local SMTP proof")
	}
	sinkURL := strings.TrimRight(os.Getenv("CHASTE_SMTP_SINK_API_URL"), "/")
	if sinkURL == "" {
		sinkURL = "http://localhost:8025"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	poolConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	proofEmail := fmt.Sprintf("go-mail-proof-%d@example.test", time.Now().UTC().UnixNano())
	if err := createAuthEmailOutboxShadow(ctx, t, pool); err != nil {
		t.Fatalf("isolate proof outbox from public workers: %T", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		deleteSMTPMessagesForRecipient(t, cleanupCtx, sinkURL, proofEmail)
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM auth_email_outbox WHERE recipient = $1`, proofEmail); err != nil {
			reportDBCleanupFailure(t, "delete synthetic auth outbox row", err)
		}
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM auth_verification WHERE value IN (SELECT id FROM auth_user WHERE email = $1)`, proofEmail); err != nil {
			reportDBCleanupFailure(t, "delete synthetic auth verification row", err)
		}
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM auth_user WHERE email = $1`, proofEmail); err != nil {
			reportDBCleanupFailure(t, "delete synthetic auth user", err)
		}
	})

	var deliveryAttempts int
	var smtpRecipients []string
	sendToSMTP := func(ctx context.Context, email, link string) error {
		smtpRecipients = append(smtpRecipients, email)
		return sender(ctx, email, link)
	}
	service, err := NewService(pool, "auth-email-outbox-test-secret-0123456789", Options{
		BaseURL: "http://localhost:3000/api/auth",
		VerificationLinkSender: func(ctx context.Context, email, link string) error {
			if email != proofEmail {
				return errors.New("auth email proof rejected an unrelated recipient")
			}
			deliveryAttempts++
			if deliveryAttempts == 1 {
				return errors.New("injected transient SMTP delivery failure")
			}
			return sendToSMTP(ctx, email, link)
		},
		RecoveryLinkSender: func(context.Context, string, string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	user, created, err := service.SignUp(ctx, proofEmail, "correct horse battery staple", "Go Mail Proof")
	if err != nil {
		t.Fatal("create synthetic auth user")
	}
	if !created || user.EmailVerified {
		t.Fatalf("signup created=%t email_verified=%t, expected an unverified synthetic account", created, user.EmailVerified)
	}
	var shadowRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_temp.auth_email_outbox WHERE recipient = $1`, proofEmail).Scan(&shadowRows); err != nil {
		t.Fatal("verify the synthetic message is in the session-local shadow")
	}
	if shadowRows != 1 {
		t.Fatalf("session-local proof outbox rows=%d, want 1", shadowRows)
	}
	var publicRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.auth_email_outbox WHERE recipient = $1`, proofEmail).Scan(&publicRows); err != nil {
		t.Fatal("verify the public worker cannot inspect the proof outbox")
	}
	if publicRows != 0 {
		t.Fatal("proof message escaped the session-local outbox shadow")
	}

	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("first outbox attempt worked=%t err=%v", worked, err)
	}
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT attempts FROM auth_email_outbox WHERE recipient = $1`, proofEmail).Scan(&attempts); err != nil {
		t.Fatal("failed delivery was not retained for retry")
	}
	if attempts != 1 {
		t.Fatalf("first delivery attempt count=%d, want 1", attempts)
	}
	if _, err := service.ProcessEmailOutboxOnce(ctx); err != nil {
		t.Fatalf("process outbox during retry backoff: %v", err)
	}
	if deliveryAttempts != 1 {
		t.Fatalf("outbox retried before the backoff elapsed: target delivery attempts=%d", deliveryAttempts)
	}
	select {
	case <-ctx.Done():
		t.Fatal("context expired before retry backoff elapsed")
	case <-time.After(authEmailRetryDelay(1)):
	}
	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("retry delivery worked=%t err=%v", worked, err)
	}
	if deliveryAttempts != 2 {
		t.Fatalf("delivery attempts=%d, want transient failure followed by one SMTP attempt", deliveryAttempts)
	}
	for _, recipient := range smtpRecipients {
		if recipient != proofEmail {
			t.Fatalf("unrelated recipient %q was handed to the configured SMTP sender", recipient)
		}
	}
	if len(smtpRecipients) != 1 {
		t.Fatalf("configured SMTP sender calls=%d, want one for the proof recipient", len(smtpRecipients))
	}
	var pending int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE recipient = $1`, proofEmail).Scan(&pending); err != nil {
		t.Fatal("read completed outbox state")
	}
	if pending != 0 {
		t.Fatalf("successfully delivered email remains queued: count=%d", pending)
	}

	textBody := waitForSMTPVerificationMessage(t, ctx, sinkURL, proofEmail)
	verificationToken := verificationTokenFromMessage(t, textBody)
	if err := service.VerifyEmail(ctx, verificationToken); err != nil {
		t.Fatal("verification link from delivered message was rejected")
	}
	var verified bool
	if err := pool.QueryRow(ctx, `SELECT email_verified FROM auth_user WHERE id = $1`, user.ID).Scan(&verified); err != nil {
		t.Fatal("read synthetic account verification state")
	}
	if !verified {
		t.Fatal("verification link did not mark the synthetic account verified")
	}
}

func reportDBCleanupFailure(t *testing.T, operation string, err error) {
	t.Helper()
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		t.Errorf("%s failed (SQLSTATE %s)", operation, databaseError.Code)
		return
	}
	t.Errorf("%s failed (%T)", operation, err)
}

func createAuthEmailOutboxShadow(ctx context.Context, t *testing.T, pool *pgxpool.Pool) error {
	t.Helper()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `CREATE TEMP TABLE auth_email_outbox (LIKE public.auth_email_outbox INCLUDING ALL) ON COMMIT PRESERVE ROWS`); err != nil {
		return err
	}
	var shadowExists bool
	if err := connection.QueryRow(ctx, `SELECT to_regclass('pg_temp.auth_email_outbox') IS NOT NULL`).Scan(&shadowExists); err != nil {
		return err
	}
	if !shadowExists {
		return errors.New("session-local auth outbox shadow is unavailable")
	}
	return nil
}

type smtpMessageSummary struct {
	ID string
	To []struct {
		Address string
	}
}

func waitForSMTPVerificationMessage(t *testing.T, ctx context.Context, sinkURL, recipient string) string {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	for {
		messageIDs, err := listSMTPMessagesForRecipient(ctx, client, sinkURL, recipient)
		if err == nil {
			for _, messageID := range messageIDs {
				text, fetchErr := fetchSMTPMessageText(ctx, client, sinkURL, messageID)
				if fetchErr == nil {
					if _, ok := verificationTokenFromText(text); ok {
						return text
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("verification email was not received by the local SMTP sink")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func listSMTPMessagesForRecipient(ctx context.Context, client *http.Client, sinkURL, recipient string) ([]string, error) {
	const pageSize = 100
	var messageIDs []string
	for start := 0; ; {
		pageURL, err := url.Parse(sinkURL + "/api/v1/messages")
		if err != nil {
			return messageIDs, fmt.Errorf("invalid local SMTP sink URL (%T)", err)
		}
		query := pageURL.Query()
		query.Set("start", strconv.Itoa(start))
		query.Set("limit", strconv.Itoa(pageSize))
		pageURL.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
		if err != nil {
			return messageIDs, fmt.Errorf("create local SMTP sink query failed (%T)", err)
		}
		response, err := client.Do(request)
		if err != nil {
			return messageIDs, fmt.Errorf("query local SMTP sink failed (%T)", err)
		}
		if response.StatusCode != http.StatusOK {
			_ = response.Body.Close()
			return messageIDs, fmt.Errorf("local SMTP sink query returned HTTP %d", response.StatusCode)
		}
		var page struct {
			Total    int                  `json:"total"`
			Messages []smtpMessageSummary `json:"messages"`
		}
		decodeErr := json.NewDecoder(response.Body).Decode(&page)
		_ = response.Body.Close()
		if decodeErr != nil {
			return messageIDs, fmt.Errorf("decode local SMTP sink query failed (%T)", decodeErr)
		}
		for _, message := range page.Messages {
			for _, to := range message.To {
				if strings.EqualFold(to.Address, recipient) {
					messageIDs = append(messageIDs, message.ID)
					break
				}
			}
		}
		start += len(page.Messages)
		if len(page.Messages) == 0 || start >= page.Total {
			return messageIDs, nil
		}
	}
}

func deleteSMTPMessagesForRecipient(t *testing.T, ctx context.Context, sinkURL, recipient string) {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	messageIDs, listErr := listSMTPMessagesForRecipient(ctx, client, sinkURL, recipient)
	if listErr != nil {
		t.Errorf("list local SMTP messages for cleanup failed (%T)", listErr)
	}
	if len(messageIDs) == 0 {
		return
	}
	body, err := json.Marshal(struct {
		IDs []string
	}{IDs: messageIDs})
	if err != nil {
		t.Errorf("encode local SMTP sink cleanup request failed (%T)", err)
		return
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, sinkURL+"/api/v1/messages", bytes.NewReader(body))
	if err != nil {
		t.Errorf("create local SMTP sink cleanup request failed (%T)", err)
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Errorf("delete local SMTP sink messages failed (%T)", err)
		return
	}
	_ = response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		t.Errorf("delete local SMTP sink messages failed with HTTP %d", response.StatusCode)
	}
}

func fetchSMTPMessageText(ctx context.Context, client *http.Client, sinkURL, messageID string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sinkURL+"/api/v1/message/"+url.PathEscape(messageID), nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		return "", fmt.Errorf("local SMTP sink returned HTTP %d", response.StatusCode)
	}
	var message struct {
		Text string
	}
	if err := json.NewDecoder(response.Body).Decode(&message); err != nil {
		return "", err
	}
	return message.Text, nil
}

func verificationTokenFromMessage(t *testing.T, text string) string {
	t.Helper()
	if token, ok := verificationTokenFromText(text); ok {
		return token
	}
	t.Fatal("delivered email did not contain a verification link")
	return ""
}

func verificationTokenFromText(text string) (string, bool) {
	for _, field := range strings.Fields(text) {
		candidate := strings.TrimRight(field, ".,);]")
		parsed, err := url.Parse(candidate)
		if err == nil && parsed.Query().Get("token") != "" {
			return parsed.Query().Get("token"), true
		}
	}
	return "", false
}
