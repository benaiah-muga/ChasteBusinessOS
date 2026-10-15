package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMarketingEmailPayloadValidationIsStrict(t *testing.T) {
	valid := marketingEmailPayload{To: "person@example.test", Subject: "Campaign", Text: "Hello", CustomerID: "11111111-1111-4111-8111-111111111111"}
	if !validMarketingEmailPayload(valid) {
		t.Fatal("valid campaign email rejected")
	}
	for name, mutate := range map[string]func(*marketingEmailPayload){
		"invalid recipient": func(p *marketingEmailPayload) { p.To = "not an address" },
		"header injection":  func(p *marketingEmailPayload) { p.Subject = "hello\r\nBcc: victim@example.test" },
		"oversized subject": func(p *marketingEmailPayload) { p.Subject = string(make([]byte, 999)) },
		"oversized body":    func(p *marketingEmailPayload) { p.Text = string(make([]byte, 10001)) },
		"missing customer":  func(p *marketingEmailPayload) { p.CustomerID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			mutate(&candidate)
			if validMarketingEmailPayload(candidate) {
				t.Fatal("invalid campaign payload accepted")
			}
		})
	}
}

func TestMarketingEmailSubjectPreservesUnicodeAndStripsHeaderControls(t *testing.T) {
	encoded := marketingEmailSubject("Café\tupdate")
	decoded, err := new(mime.WordDecoder).DecodeHeader(encoded)
	if err != nil {
		t.Fatalf("decode encoded subject: %v", err)
	}
	if decoded != "Café update" {
		t.Fatalf("subject = %q, want Unicode text with control characters stripped", decoded)
	}
}

func TestMarketingEmailSMTPDeliveryToLocalSink(t *testing.T) {
	if os.Getenv("MARKETING_EMAIL_SMTP_SINK_TEST") != "1" {
		t.Skip("set MARKETING_EMAIL_SMTP_SINK_TEST=1 to deliver to the local SMTP sink")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	proofID := fmt.Sprintf("%d", time.Now().UnixNano())
	recipient := "proof+" + proofID + "@example.test"
	claim := ClaimedMessage{ProviderOperationID: "smtp-proof-" + proofID}
	payload := marketingEmailPayload{To: recipient, Subject: "Go marketing delivery proof " + proofID, Text: "This message was delivered by the Go SMTP worker."}
	receipt, err := sendMarketingEmailSMTP(ctx, MarketingEmailConfig{
		Host: "127.0.0.1", Port: 1025, Secure: true, From: "Chaste Local <noreply@chaste.test>",
	}, claim, payload)
	if err != nil {
		t.Fatalf("send through local SMTP sink: %v", err)
	}
	var got struct {
		MessageID string `json:"messageId"`
	}
	if err := json.Unmarshal(receipt, &got); err != nil || got.MessageID != "<"+claim.ProviderOperationID+"@chaste.local>" {
		t.Fatalf("SMTP receipt = %s, err=%v", receipt, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8025", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("read local SMTP sink capture: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("SMTP sink status = %d", response.StatusCode)
	}
	var capture struct {
		Messages []string `json:"messages"`
	}
	if err := json.NewDecoder(response.Body).Decode(&capture); err != nil {
		t.Fatalf("decode local SMTP sink capture: %v", err)
	}
	want := []string{"To: <" + recipient + ">", "Subject: " + payload.Subject, "Message-ID: " + got.MessageID, "This message was delivered by the Go SMTP worker."}
	for _, message := range capture.Messages {
		if !strings.Contains(message, "To: <"+recipient+">") || !strings.Contains(message, payload.Subject) {
			continue
		}
		for _, fragment := range want {
			if !strings.Contains(message, fragment) {
				t.Fatalf("SMTP capture missing %q: %s", fragment, message)
			}
		}
		return
	}
	t.Fatal("local SMTP sink did not capture the Go marketing email")
}

func TestGoMarketingEmailOutboxWorkerEnforcesEligibilityAndRoleBoundary(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the marketing email worker proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	workerPassword := os.Getenv("CHASTE_MARKETING_EMAIL_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		workerPassword = "chaste_marketing_email_worker_dev_only"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner database: %v", err)
	}
	defer owner.Close()
	workerURL := roleURL(t, ownerURL, dbx.MarketingEmailWorkerRoleName, workerPassword)
	workerPool, err := pgxpool.New(ctx, workerURL)
	if err != nil {
		t.Fatalf("connect marketing email worker database: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyMarketingEmailWorkerRole(ctx, workerPool); err != nil {
		t.Fatalf("verify dedicated role: %v", err)
	}

	tag := fmt.Sprintf("marketing:%d", time.Now().UnixNano())
	orgID := insertWorkerTestOrg(t, ctx, owner, tag)
	defer func() { _, _ = owner.Exec(context.Background(), `DELETE FROM organizations WHERE id=$1::uuid`, orgID) }()
	var customerID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id,name,email,marketing_opt_out) VALUES ($1::uuid,'Recipient','recipient@example.test',true) RETURNING id::text`, orgID).Scan(&customerID); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	insertMarketingEmailFixture(t, ctx, owner, orgID, tag+":ineligible", customerID)
	var genericID string
	if err := owner.QueryRow(ctx, `INSERT INTO outbox_messages (org_id,kind,dedupe_key,provider_operation_id,payload) VALUES ($1::uuid,'email',$2,gen_random_uuid(),'{}'::jsonb) RETURNING id::text`, orgID, fmt.Sprintf("generic:%d", time.Now().UnixNano())).Scan(&genericID); err != nil {
		t.Fatalf("seed generic email: %v", err)
	}
	var sendCount int
	worker, err := NewMarketingEmailWorker(workerPool, workerPool, MarketingEmailOptions{WorkerID: "marketing-proof", Config: MarketingEmailConfig{Host: "smtp.example.test"}, Send: func(_ context.Context, _ MarketingEmailConfig, _ ClaimedMessage, payload marketingEmailPayload) (json.RawMessage, error) {
		sendCount++
		if payload.To != "recipient@example.test" {
			t.Fatalf("unexpected recipient: %q", payload.To)
		}
		return json.RawMessage(`{"messageId":"<proof@chaste.local>"}`), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	var hiddenPayload []byte
	_, err = dbx.WithOrgTx(ctx, workerPool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT payload FROM outbox_messages WHERE id=$1::uuid`, genericID).Scan(&hiddenPayload)
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("worker could see non-marketing email inside tenant scope: err=%v", err)
	}
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process ineligible campaign row: worked=%v err=%v", worked, err)
	}
	assertStatus(t, ctx, owner, orgID, mustOutboxID(t, ctx, owner, orgID, tag+":ineligible"), "failed")
	if sendCount != 0 {
		t.Fatalf("ineligible campaign recipient was sent: sends=%d", sendCount)
	}
	if _, err := owner.Exec(ctx, `UPDATE customers SET marketing_opt_out=false WHERE id=$1::uuid`, customerID); err != nil {
		t.Fatal(err)
	}
	insertMarketingEmailFixture(t, ctx, owner, orgID, tag+":eligible", customerID)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process eligible campaign row: worked=%v err=%v", worked, err)
	}
	assertStatus(t, ctx, owner, orgID, mustOutboxID(t, ctx, owner, orgID, tag+":eligible"), "sent")
	if sendCount != 1 {
		t.Fatalf("eligible campaign sends=%d, want one", sendCount)
	}
	var denied []byte
	err = workerPool.QueryRow(ctx, `SELECT payload FROM outbox_messages WHERE id=$1::uuid`, genericID).Scan(&denied)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("worker could read non-marketing email payload: err=%v", err)
	}
	var customerName string
	err = workerPool.QueryRow(ctx, `SELECT name FROM customers WHERE id=$1::uuid`, customerID).Scan(&customerName)
	if err == nil {
		t.Fatal("worker could read customer name outside its eligibility columns")
	}
}

func insertMarketingEmailFixture(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, dedupeKey, customerID string) {
	t.Helper()
	payload, _ := json.Marshal(marketingEmailPayload{To: "recipient@example.test", Subject: "Campaign", Text: "Hello", CustomerID: customerID})
	if _, err := owner.Exec(ctx, `INSERT INTO outbox_messages (org_id,kind,dedupe_key,provider_operation_id,payload) VALUES ($1::uuid,'email',$2,gen_random_uuid(),$3::jsonb)`, orgID, dedupeKey, payload); err != nil {
		t.Fatalf("seed marketing email: %v", err)
	}
}

func mustOutboxID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, dedupeKey string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM outbox_messages WHERE org_id=$1::uuid AND dedupe_key=$2`, orgID, dedupeKey).Scan(&id); err != nil {
		t.Fatalf("lookup outbox fixture: %v", err)
	}
	return id
}
