package jobs

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRoutineJobRunsGovernedAgentAndFinalizesOccurrence(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the Go routine agent database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := envOr("CHASTE_APP_DB_PASSWORD", "chaste_app_dev_only")
	workerPassword := envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatal(err)
	}
	tag := fmt.Sprintf("go-routine-agent-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	otherOrgID := insertJobsTestOrg(t, ctx, owner, tag+"-other")
	defer cleanupJobsTestOrgs(t, owner, otherOrgID)
	updatedAt := time.Date(2026, 9, 30, 10, 11, 12, 345000000, time.UTC)
	seedDocument := func(documentOrgID, title string) string {
		t.Helper()
		var id string
		if err := owner.QueryRow(ctx, `
			INSERT INTO authored_docs (org_id, title, content_json, html, status, created_by_actor_type, updated_at, folder,
			                          document_type, linked_record_type, linked_record_label)
			VALUES ($1::uuid, $2, '{}'::jsonb, '', 'draft', 'human', $3, 'Finance', 'invoice', 'customer', 'Acme')
			RETURNING id::text`, documentOrgID, title, updatedAt).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	localDocumentID := seedDocument(orgID, "Routine local proof")
	foreignDocumentID := seedDocument(otherOrgID, "Routine foreign proof")
	firstVersionAt := time.Date(2026, 9, 30, 10, 11, 12, 345000000, time.UTC)
	secondVersionAt := time.Date(2026, 9, 30, 10, 12, 13, 456000000, time.UTC)
	if _, err := owner.Exec(ctx, `
		INSERT INTO authored_doc_versions (org_id, document_id, version, content_json, html, note, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, 1, '{}'::jsonb, '', NULL, 'human', $3),
		       ($1::uuid, $2::uuid, 2, '{}'::jsonb, '', 'Routine proof second version', 'agent', $4)`, orgID, localDocumentID, firstVersionAt, secondVersionAt); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO authored_doc_versions (org_id, document_id, version, content_json, html, note, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 1, '{}'::jsonb, '', 'Foreign version', 'human')`, otherOrgID, foreignDocumentID); err != nil {
		t.Fatal(err)
	}
	secret := "routine-test-encryption-secret"
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", secret)
	serverCalls := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("provider request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer integration-provider-key" {
			t.Errorf("provider authorization was not applied")
		}
		call := serverCalls.Add(1)
		if call%2 == 1 {
			localVersionArgs, err := json.Marshal(map[string]string{"documentId": localDocumentID})
			if err != nil {
				t.Errorf("encode local document version arguments: %v", err)
				return
			}
			foreignVersionArgs, err := json.Marshal(map[string]string{"documentId": foreignDocumentID})
			if err != nil {
				t.Errorf("encode foreign document version arguments: %v", err)
				return
			}
			providerResponse, err := json.Marshal(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": nil, "tool_calls": []any{
					map[string]any{"id": "call-routine-1", "type": "function", "function": map[string]any{"name": "crm_listCustomers", "arguments": "{}"}},
					map[string]any{"id": "call-routine-tasks", "type": "function", "function": map[string]any{"name": "crm_listTasks", "arguments": `{"openOnly":true}`}},
					map[string]any{"id": "call-routine-inventory", "type": "function", "function": map[string]any{"name": "inventory_stockReport", "arguments": `{"belowReorderOnly":false}`}},
					map[string]any{"id": "call-routine-documents", "type": "function", "function": map[string]any{"name": "documents_listDocs", "arguments": "{}"}},
					map[string]any{"id": "call-routine-document-versions", "type": "function", "function": map[string]any{"name": "documents_listDocVersions", "arguments": string(localVersionArgs)}},
					map[string]any{"id": "call-routine-foreign-document-versions", "type": "function", "function": map[string]any{"name": "documents_listDocVersions", "arguments": string(foreignVersionArgs)}},
				}}}},
				"usage": map[string]int{"prompt_tokens": 12, "completion_tokens": 3},
			})
			if err != nil {
				t.Errorf("encode routine tool-call response: %v", err)
				return
			}
			_, _ = w.Write(providerResponse)
			return
		}
		var request struct {
			Messages []struct {
				Role       string          `json:"role"`
				ToolCallID string          `json:"tool_call_id"`
				Content    json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode routine follow-up request: %v", err)
			return
		}
		foundDocumentResult := false
		foundLocalVersionResult := false
		foundForeignVersionResult := false
		for _, message := range request.Messages {
			if message.Role != "tool" {
				continue
			}
			switch message.ToolCallID {
			case "call-routine-documents":
				foundDocumentResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Documents []struct {
							ID        string  `json:"id"`
							Title     string  `json:"title"`
							Status    string  `json:"status"`
							Versions  int     `json:"versions"`
							Template  *string `json:"templateId"`
							Folder    *string `json:"folder"`
							DocType   *string `json:"documentType"`
							Linked    *string `json:"linkedRecordType"`
							Label     *string `json:"linkedRecordLabel"`
							UpdatedAt string  `json:"updatedAt"`
						} `json:"documents"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode documents.listDocs tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Documents) != 1 {
					t.Errorf("documents.listDocs result = %+v, want only this organization's document", result)
					continue
				}
				document := result.Data.Documents[0]
				if document.ID != localDocumentID || document.Title != "Routine local proof" || document.Status != "draft" ||
					document.Versions != 2 || document.Template != nil || document.Folder == nil || *document.Folder != "Finance" ||
					document.DocType == nil || *document.DocType != "invoice" || document.Linked == nil || *document.Linked != "customer" ||
					document.Label == nil || *document.Label != "Acme" || document.UpdatedAt != "2026-09-30T10:11:12.345Z" {
					t.Errorf("documents.listDocs document = %+v, want the seeded metadata and version count", document)
				}
			case "call-routine-document-versions", "call-routine-foreign-document-versions":
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Versions []struct {
							Version   int     `json:"version"`
							Note      *string `json:"note"`
							CreatedBy *string `json:"createdBy"`
							CreatedAt string  `json:"createdAt"`
						} `json:"versions"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode documents.listDocVersions tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK {
					t.Errorf("documents.listDocVersions result = %+v, want a successful read", result)
					continue
				}
				if message.ToolCallID == "call-routine-document-versions" {
					foundLocalVersionResult = true
					versions := result.Data.Versions
					if len(versions) != 2 || versions[0].Version != 1 || versions[0].Note != nil || versions[0].CreatedBy != nil ||
						versions[0].CreatedAt != "2026-09-30T10:11:12.345Z" || versions[1].Version != 2 || versions[1].Note == nil ||
						*versions[1].Note != "Routine proof second version" || versions[1].CreatedBy == nil || *versions[1].CreatedBy != "workmate" ||
						versions[1].CreatedAt != "2026-09-30T10:12:13.456Z" {
						t.Errorf("documents.listDocVersions local result = %+v, want ordered nullable and agent-authored summaries", versions)
					}
				} else {
					foundForeignVersionResult = true
					if len(result.Data.Versions) != 0 {
						t.Errorf("documents.listDocVersions leaked foreign tenant data: %+v", result.Data.Versions)
					}
				}
			}
		}
		if !foundDocumentResult {
			t.Errorf("follow-up provider request omitted the documents.listDocs tool result")
		}
		if !foundLocalVersionResult || !foundForeignVersionResult {
			t.Errorf("follow-up provider request omitted document version tool results, local=%v foreign=%v", foundLocalVersionResult, foundForeignVersionResult)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Routine reviewed customer, task, stock, and authored-document data."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`))
	}))
	defer server.Close()
	settings, err := json.Marshal(map[string]any{"ai": map[string]any{"provider": "custom", "baseUrl": server.URL + "/v1", "models": map[string]string{"primary": "routine-test-model", "fast": "routine-test-model", "reasoning": "routine-test-model", "embeddings": "routine-test-model"}, "encryptedApiKey": encryptRoutineKey(t, secret, "integration-provider-key"), "keyHint": "••••key", "updatedAt": time.Now().UTC().Format(time.RFC3339)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET settings=$2::jsonb WHERE id=$1::uuid`, orgID, string(settings)); err != nil {
		t.Fatal(err)
	}
	var routineID, occurrenceID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Test digest','Count customers', '{"kind":"daily","atTime":"08:00"}', true, 'schedule') RETURNING id::text`, orgID).Scan(&routineID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO routine_occurrences(org_id,routine_id,scheduled_at,status) VALUES($1::uuid,$2::uuid,clock_timestamp(),'queued') RETURNING id::text`, orgID, routineID).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "schedule", OccurrenceID: &occurrenceID})
	jobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, payload, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	executor := capability.NewExecutor(appPool, "", "", "")
	runner := newRoutineAgent(appPool, executor)
	runner.client = server.Client()
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-routine-agent-integration", LeaseDuration: time.Second, RoutineRunner: runner, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("routine worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, jobID, "done", 1)
	if got := serverCalls.Load(); got != 2 {
		t.Fatalf("provider calls=%d, want one tool turn and one final turn", got)
	}
	var status, lastError string
	if err := owner.QueryRow(ctx, `SELECT last_status,COALESCE(last_error,'') FROM routines WHERE id=$1::uuid AND org_id=$2::uuid`, routineID, orgID).Scan(&status, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "ok" || lastError != "" {
		t.Fatalf("routine outcome status=%q error=%q", status, lastError)
	}
	var occurrenceStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM routine_occurrences WHERE id=$1::uuid AND org_id=$2::uuid`, occurrenceID, orgID).Scan(&occurrenceStatus); err != nil {
		t.Fatal(err)
	}
	if occurrenceStatus != "done" {
		t.Fatalf("scheduled occurrence status=%q", occurrenceStatus)
	}
	var sessionID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM agent_sessions WHERE org_id=$1::uuid AND title='Routine: Test digest' ORDER BY created_at DESC LIMIT 1`, orgID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM session_events WHERE session_id=$1::uuid AND role IN ('user','assistant')`, sessionID); got != 2 {
		t.Fatalf("routine session events=%d, want user and assistant", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked CRM system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listTasks' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked CRM task-list system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='inventory.stockReport' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked inventory system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='documents.listDocs' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked document-list system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='documents.listDocVersions' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 2 {
		t.Fatalf("session-linked document-version system capability audit events=%d, want local and tenant-scoped empty reads", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='routine.run' AND href='/sessions'`, orgID); got != 1 {
		t.Fatalf("routine finding notifications=%d", got)
	}
	var inputUsage, outputUsage int
	if err := owner.QueryRow(ctx, `SELECT (token_usage->>'input')::int,(token_usage->>'output')::int FROM agent_sessions WHERE id=$1::uuid`, sessionID).Scan(&inputUsage, &outputUsage); err != nil {
		t.Fatal(err)
	}
	if inputUsage != 22 || outputUsage != 8 {
		t.Fatalf("routine token usage in=%d out=%d", inputUsage, outputUsage)
	}
	manualPayload, _ := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "manual"})
	manualJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, manualPayload, 3, time.Date(1901, 1, 1, 0, 0, 0, 0, time.UTC))
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("manual routine worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, manualJobID, "done", 1)
	if got := serverCalls.Load(); got != 4 {
		t.Fatalf("provider calls after manual run=%d, want two tool turns and two final turns", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='routine.run' AND href='/sessions'`, orgID); got != 2 {
		t.Fatalf("scheduled plus manual notifications=%d, want two", got)
	}
	var disabledRoutineID, disabledOccurrenceID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Disabled digest','Do not run','{"kind":"daily","atTime":"08:00"}',false,'schedule') RETURNING id::text`, orgID).Scan(&disabledRoutineID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO routine_occurrences(org_id,routine_id,scheduled_at,status) VALUES($1::uuid,$2::uuid,clock_timestamp(),'queued') RETURNING id::text`, orgID, disabledRoutineID).Scan(&disabledOccurrenceID); err != nil {
		t.Fatal(err)
	}
	disabledPayload, _ := json.Marshal(routinePayload{RoutineID: disabledRoutineID, Trigger: "schedule", OccurrenceID: &disabledOccurrenceID})
	disabledJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, disabledPayload, 3, time.Date(1902, 1, 1, 0, 0, 0, 0, time.UTC))
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("disabled schedule worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, disabledJobID, "done", 1)
	var disabledRoutineStatus, disabledOccurrenceStatus string
	if err := owner.QueryRow(ctx, `SELECT last_status FROM routines WHERE id=$1::uuid`, disabledRoutineID).Scan(&disabledRoutineStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM routine_occurrences WHERE id=$1::uuid`, disabledOccurrenceID).Scan(&disabledOccurrenceStatus); err != nil {
		t.Fatal(err)
	}
	if disabledRoutineStatus != "cancelled" || disabledOccurrenceStatus != "cancelled" {
		t.Fatalf("disabled scheduled routine outcome status=%q occurrence=%q", disabledRoutineStatus, disabledOccurrenceStatus)
	}
	if got := serverCalls.Load(); got != 4 {
		t.Fatalf("disabled routine called provider, count=%d", got)
	}
}

func encryptRoutineKey(t *testing.T, secret, plain string) string {
	t.Helper()
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]
	return "v1:" + base64.RawURLEncoding.EncodeToString(iv) + ":" + base64.RawURLEncoding.EncodeToString(tag) + ":" + base64.RawURLEncoding.EncodeToString(ciphertext)
}
