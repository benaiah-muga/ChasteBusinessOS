package authn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
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
	pool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var queued int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE expires_at > now()`).Scan(&queued); err != nil {
		t.Fatal("check local auth outbox isolation")
	}
	if queued != 0 {
		t.Skip("local auth outbox contains unrelated pending work; drain it before running the SMTP proof")
	}

	proofEmail := fmt.Sprintf("go-mail-proof-%d@example.test", time.Now().UTC().UnixNano())
	var deliveryAttempts int
	service, err := NewService(pool, "auth-email-outbox-test-secret-0123456789", Options{
		BaseURL: "http://localhost:3000/api/auth",
		VerificationLinkSender: func(ctx context.Context, email, link string) error {
			if email == proofEmail {
				deliveryAttempts++
			}
			if email == proofEmail && deliveryAttempts == 1 {
				return errors.New("injected transient SMTP delivery failure")
			}
			return sender(ctx, email, link)
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
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_email_outbox WHERE recipient = $1`, proofEmail)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_verification WHERE value = $1`, user.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, user.ID)
	})

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
	var pending int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE recipient = $1`, proofEmail).Scan(&pending); err != nil {
		t.Fatal("read completed outbox state")
	}
	if pending != 0 {
		t.Fatalf("successfully delivered email remains queued: count=%d", pending)
	}

	messageID, textBody := waitForSMTPVerificationMessage(t, ctx, sinkURL, proofEmail)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cleanupCancel()
		request, err := http.NewRequestWithContext(cleanupCtx, http.MethodDelete, sinkURL+"/api/v1/message/"+url.PathEscape(messageID), nil)
		if err == nil {
			response, err := http.DefaultClient.Do(request)
			if err == nil {
				_ = response.Body.Close()
			}
		}
	})
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

func waitForSMTPVerificationMessage(t *testing.T, ctx context.Context, sinkURL, recipient string) (string, string) {
	t.Helper()
	type messageSummary struct {
		ID string
		To []struct {
			Address string
		}
	}
	client := &http.Client{Timeout: 3 * time.Second}
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, sinkURL+"/api/v1/messages?limit=100", nil)
		if err != nil {
			t.Fatal("create local SMTP sink query")
		}
		response, err := client.Do(request)
		if err == nil {
			var page struct {
				Messages []messageSummary
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&page)
			_ = response.Body.Close()
			if decodeErr == nil && response.StatusCode == http.StatusOK {
				for _, message := range page.Messages {
					for _, to := range message.To {
						if strings.EqualFold(to.Address, recipient) {
							text, fetchErr := fetchSMTPMessageText(ctx, client, sinkURL, message.ID)
							if fetchErr == nil {
								return message.ID, text
							}
						}
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
		_, _ = io.Copy(io.Discard, response.Body)
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
	for _, field := range strings.Fields(text) {
		candidate := strings.TrimRight(field, ".,);]")
		parsed, err := url.Parse(candidate)
		if err == nil && parsed.Query().Get("token") != "" {
			return parsed.Query().Get("token")
		}
	}
	t.Fatal("delivered email did not contain a verification link")
	return ""
}
