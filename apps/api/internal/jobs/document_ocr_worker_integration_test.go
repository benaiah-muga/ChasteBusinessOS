package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5/pgxpool"
)

type documentImageParserFunc func(context.Context, string, []byte) (string, error)

func (parse documentImageParserFunc) ParseDocumentImage(ctx context.Context, mimeType string, image []byte) (string, error) {
	return parse(ctx, mimeType, image)
}

func TestGoDocumentUploadOCRJobParsesThroughConfiguredProvider(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the uploaded document OCR worker proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := envOr("CHASTE_APP_DB_PASSWORD", "chaste_app_dev_only")
	workerPassword := envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect database owner: %v", err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatalf("connect app runtime: %v", err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatalf("connect jobs worker: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("go-document-ocr-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	foreignOrgID := insertJobsTestOrg(t, ctx, owner, tag+"-foreign")
	defer cleanupJobsTestOrgs(t, owner, orgID, foreignOrgID)

	const imageBase64 = "JVBERi0x"
	const recognizedMarkdown = "Scanned invoice\nInvoice total: 42.00"
	parserCalls := 0
	executor := capability.NewExecutorWithDocumentImageParser(appPool, "", "", "", documentImageParserFunc(
		func(parseCtx context.Context, mimeType string, image []byte) (string, error) {
			parserCalls++
			if err := parseCtx.Err(); err != nil {
				return "", err
			}
			if mimeType != "application/pdf" || string(image) != "%PDF-1" {
				t.Fatalf("configured OCR input mime=%q image=%q", mimeType, image)
			}
			return recognizedMarkdown, nil
		},
	))
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{
		WorkerID:      "go-document-ocr-integration-worker",
		LeaseDuration: 5 * time.Second,
		PollInterval:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	var documentID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO documents (org_id, title, source_type, mime_type, content_base64, status, created_by_actor_type)
		VALUES ($1::uuid, 'Go OCR worker upload proof', 'upload', 'application/pdf', $2, 'queued', 'human')
		RETURNING id::text`, orgID, imageBase64).Scan(&documentID); err != nil {
		t.Fatalf("insert uploaded document: %v", err)
	}
	payload, err := json.Marshal(map[string]string{"documentId": documentID})
	if err != nil {
		t.Fatal(err)
	}
	jobID := insertJobsTestJob(t, ctx, owner, orgID, "documents.parseDocument", payload, 3, time.Date(1907, 1, 1, 0, 0, 0, 0, time.UTC))
	lockTx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatalf("begin unrelated job lock transaction: %v", err)
	}
	defer lockTx.Rollback(context.Background())
	lockedRows, err := lockTx.Query(ctx, `
		SELECT id
		FROM jobs
		WHERE id <> $1::uuid
		  AND ((status = 'pending' AND attempts < max_attempts AND available_at <= clock_timestamp())
		    OR (status = 'processing' AND lease_expires_at <= clock_timestamp() AND attempts < max_attempts))
		FOR UPDATE SKIP LOCKED`, jobID)
	if err != nil {
		t.Fatalf("lock other eligible queue jobs: %v", err)
	}
	for lockedRows.Next() {
		var lockedJobID string
		if err := lockedRows.Scan(&lockedJobID); err != nil {
			lockedRows.Close()
			t.Fatalf("read locked queue job: %v", err)
		}
	}
	if err := lockedRows.Err(); err != nil {
		lockedRows.Close()
		t.Fatalf("iterate locked queue jobs: %v", err)
	}
	lockedRows.Close()

	worked, err := worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("uploaded document job process worked=%v err=%v", worked, err)
	}
	if err := lockTx.Commit(ctx); err != nil {
		t.Fatalf("release unrelated queue job locks: %v", err)
	}
	if parserCalls != 1 {
		t.Fatalf("configured OCR parser calls=%d, want one", parserCalls)
	}
	assertJobsTestState(t, ctx, owner, jobID, "done", 1)

	var documentOrgID, documentStatus, parsedMarkdown string
	var parseError *string
	if err := owner.QueryRow(ctx, `
		SELECT org_id::text, status, parsed_markdown, parse_error
		FROM documents WHERE id=$1::uuid`, documentID).
		Scan(&documentOrgID, &documentStatus, &parsedMarkdown, &parseError); err != nil {
		t.Fatalf("read parsed upload: %v", err)
	}
	if documentOrgID != orgID || documentStatus != "parsed" || parsedMarkdown != recognizedMarkdown || parseError != nil {
		t.Fatalf("parsed upload org=%q status=%q markdown=%q error=%v", documentOrgID, documentStatus, parsedMarkdown, parseError)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM memories
		WHERE org_id=$1::uuid AND source=$2 AND content=$3`, orgID, "document:"+documentID, recognizedMarkdown); got != 1 {
		t.Fatalf("uploaded document produced %d organization-scoped memory chunks, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM memories WHERE org_id=$1::uuid AND source=$2`, foreignOrgID, "document:"+documentID); got != 0 {
		t.Fatalf("uploaded document produced %d memory chunks in a foreign organization", got)
	}
	receiptKey := orgID + ":" + jobID
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, receiptKey); got != 1 {
		t.Fatalf("uploaded document wrote %d organization-scoped action receipts, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, foreignOrgID, receiptKey); got != 0 {
		t.Fatalf("uploaded document wrote %d action receipts in a foreign organization", got)
	}
}
