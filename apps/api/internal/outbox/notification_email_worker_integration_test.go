package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoNotificationEmailWorkerEnforcesRoleScopeAndDispatch(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the notification email worker proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	workerPassword := os.Getenv("CHASTE_NOTIFICATION_EMAIL_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		workerPassword = "chaste_notification_email_worker_dev_only"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner database: %v", err)
	}
	defer owner.Close()
	workerURL := roleURL(t, ownerURL, dbx.NotificationEmailWorkerRoleName, workerPassword)
	workerPool, err := pgxpool.New(ctx, workerURL)
	if err != nil {
		t.Fatalf("connect notification email worker database: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyNotificationEmailWorkerRole(ctx, workerPool); err != nil {
		t.Fatalf("verify dedicated notification email role: %v", err)
	}
	var pending int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM outbox_messages
		WHERE kind='email' AND dedupe_key LIKE 'notification:approval.email:%'
		AND status='pending' AND attempts < max_attempts AND available_at <= clock_timestamp()`).Scan(&pending); err != nil {
		t.Fatalf("check isolated notification queue: %v", err)
	}
	if pending != 0 {
		t.Skipf("notification email proof requires an isolated queue; found %d due approval email(s)", pending)
	}

	tag := fmt.Sprintf("notification-email:%d", time.Now().UnixNano())
	orgID := insertWorkerTestOrg(t, ctx, owner, tag)
	defer func() { _, _ = owner.Exec(context.Background(), `DELETE FROM organizations WHERE id=$1::uuid`, orgID) }()
	dedupeKey := "notification:approval.email:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	var messageID string
	payload := json.RawMessage(`{"to":"approver@example.test","subject":"[Chaste] Approval needed: crm.createCustomer","text":"An action is waiting for human approval."}`)
	if err := owner.QueryRow(ctx, `INSERT INTO outbox_messages (org_id,kind,dedupe_key,provider_operation_id,payload,available_at)
		VALUES ($1::uuid,'email',$2,gen_random_uuid(),$3::jsonb,'1900-01-01T00:00:00Z') RETURNING id::text`, orgID, dedupeKey, payload).Scan(&messageID); err != nil {
		t.Fatalf("seed approval email: %v", err)
	}
	var otherClassID string
	if err := owner.QueryRow(ctx, `INSERT INTO outbox_messages (org_id,kind,dedupe_key,provider_operation_id,payload)
		VALUES ($1::uuid,'email',$2,gen_random_uuid(),'{}'::jsonb) RETURNING id::text`, orgID, tag+":ticket.email").Scan(&otherClassID); err != nil {
		t.Fatalf("seed unrelated generic email: %v", err)
	}
	var sends int
	worker, err := NewNotificationEmailWorker(workerPool, workerPool, NotificationEmailWorkerOptions{
		WorkerID: "notification-email-proof",
		Config:   MarketingEmailConfig{Host: "smtp.example.test"},
		Send: func(_ context.Context, _ MarketingEmailConfig, message ClaimedMessage, body marketingEmailPayload) (json.RawMessage, error) {
			sends++
			if message.ID != messageID || message.OrgID != orgID || body.To != "approver@example.test" {
				t.Fatalf("unexpected dispatched claim or payload: claim=%+v body=%+v", message, body)
			}
			return json.RawMessage(`{"messageId":"<notification-proof@chaste.local>"}`), nil
		},
	})
	if err != nil {
		t.Fatalf("construct notification email worker: %v", err)
	}
	var hidden []byte
	_, err = dbx.WithOrgTx(ctx, workerPool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT payload FROM public.outbox_messages WHERE id=$1::uuid`, otherClassID).Scan(&hidden)
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("worker could read a different notification class: err=%v", err)
	}
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process approval notification email: worked=%v err=%v", worked, err)
	}
	assertStatus(t, ctx, owner, orgID, messageID, "sent")
	if sends != 1 {
		t.Fatalf("notification sends=%d, want one", sends)
	}
	var attempts, fence int
	var receipt []byte
	if err := owner.QueryRow(ctx, `SELECT attempts,fencing_token,provider_receipt FROM outbox_messages WHERE id=$1::uuid`, messageID).Scan(&attempts, &fence, &receipt); err != nil {
		t.Fatal(err)
	}
	var delivered struct {
		MessageID string `json:"messageId"`
	}
	if err := json.Unmarshal(receipt, &delivered); err != nil {
		t.Fatalf("decode provider receipt: %v", err)
	}
	if attempts != 1 || fence != 1 || delivered.MessageID != "<notification-proof@chaste.local>" {
		t.Fatalf("approval notification delivery metadata attempts=%d fence=%d receipt=%s", attempts, fence, receipt)
	}
}
