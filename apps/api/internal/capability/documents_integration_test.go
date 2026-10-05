package capability

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// documentsResult mirrors the executor's Result for a single call so the
// integration test reads the same way the HTTP layer does.
type documentsResult struct {
	OK    bool
	Data  json.RawMessage
	Error string
	// Err is set when the call failed for a reason other than a business-rule
	// refusal, so a test can tell a rejection from a broken query.
	Err error
}

// documentsExecute runs one documents capability the way the executor will:
// the same parser, the same handler, and the same org-scoped transaction from
// dbx.WithOrgTx against the RLS-enforced runtime role. Only the permission
// gate and the ledger receipt are skipped, because those live in executor.go
// and the metadata they read is pinned against the manifest by
// TestDocumentsCapabilitiesMatchManifest.
func documentsExecute(t *testing.T, fx *executorFixture, capabilityID, orgID, input string) documentsResult {
	t.Helper()
	parsed, err := ParseDocumentsInput(capabilityID, json.RawMessage(input))
	if err != nil {
		return documentsResult{Error: "invalid input: " + err.Error(), Err: err}
	}
	actorID := fx.userID
	claims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: fx.userID,
		OrganizationID: orgID, CapabilityID: capabilityID, ActorID: &actorID,
		ActorType: "human", Permissions: []string{"documents.read"},
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	data, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (json.RawMessage, error) {
		ctx := withDocumentsImageParser(fx.ctx, fx.executor.documentsOCR)
		return executeDocumentsCapability(ctx, tx, claims, capabilityID, parsed, now)
	})
	if err != nil {
		if message, rejected := DocumentsRejectionMessage(err); rejected {
			return documentsResult{Error: message}
		}
		return documentsResult{Error: err.Error(), Err: err}
	}
	return documentsResult{OK: true, Data: data}
}

// documentsExecuteFor is the common case: the acting organization's own rows.
func documentsExecuteFor(t *testing.T, fx *executorFixture, capabilityID, input string) documentsResult {
	t.Helper()
	return documentsExecute(t, fx, capabilityID, fx.orgID, input)
}

func documentsSeedIngested(t *testing.T, fx *executorFixture, orgID, title, rawText string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, raw_text, status, created_by_actor_type)
		VALUES ($1::uuid, $2, 'text', $3, 'received', 'human')
		RETURNING id::text`, orgID, title, rawText).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func documentsSeedAuthored(t *testing.T, fx *executorFixture, orgID, title, folder string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO authored_docs (org_id, title, content_json, html, status, folder, created_by_actor_type)
		VALUES ($1::uuid, $2, '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, '<p>seed</p>', 'draft', $3, 'human')
		RETURNING id::text`, orgID, title, folder).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func documentsCleanup(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		for _, statement := range []string{
			`DELETE FROM document_suggestions WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM document_versions WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM memories WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM documents WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM doc_drafts WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM authored_doc_versions WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM doc_templates WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM doc_folders WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM authored_docs WHERE org_id IN ($1::uuid, $2::uuid)`,
		} {
			if _, err := fx.owner.Exec(fx.ctx, statement, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("clean up documents fixture (%s): %v", statement, err)
				return
			}
		}
	})
}

// TestGoDocumentsIngestionAndVersions covers the ingested-document side of the
// module end to end: create, list, version, delete, and tenant isolation.
func TestGoDocumentsIngestionAndVersions(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)

	local := documentsSeedIngested(t, fx, fx.orgID, "Local bill", "first text")
	foreign := documentsSeedIngested(t, fx, fx.otherOrgID, "Foreign bill", "secret text")

	created := documentsExecuteFor(t, fx, documentsCreateDocumentCapabilityID,
		`{"title":"Created bill","text":"pasted text","folder":"Finance"}`)
	if !created.OK {
		t.Fatalf("createDocument result=%+v", created)
	}
	var createdOut IngestDocumentOutput
	if err := json.Unmarshal(created.Data, &createdOut); err != nil {
		t.Fatal(err)
	}
	if !isUUID(createdOut.DocumentID) {
		t.Fatalf("createDocument documentId = %q", createdOut.DocumentID)
	}

	listed := documentsExecuteFor(t, fx, documentsListDocumentsCapabilityID, `{}`)
	if !listed.OK {
		t.Fatalf("listDocuments result=%+v", listed)
	}
	var listedOut ListIngestedDocumentsOutput
	if err := json.Unmarshal(listed.Data, &listedOut); err != nil {
		t.Fatal(err)
	}
	titles := make([]string, 0, len(listedOut.Documents))
	for _, document := range listedOut.Documents {
		titles = append(titles, document.Title)
		if document.OpenSuggestions != 0 {
			t.Errorf("document %q reported %d open suggestions, want 0", document.ID, document.OpenSuggestions)
		}
		if _, err := time.Parse("2006-01-02T15:04:05.000Z", document.CreatedAt); err != nil {
			t.Errorf("createdAt %q is not ISO 8601 with milliseconds: %v", document.CreatedAt, err)
		}
	}
	if len(titles) != 2 || !documentsContainsString(titles, "Local bill") || !documentsContainsString(titles, "Created bill") {
		t.Fatalf("listDocuments titles = %v, want the two local documents and no foreign rows", titles)
	}
	for _, document := range listedOut.Documents {
		if document.Title == "Foreign bill" {
			t.Fatal("listDocuments leaked a document from another organization")
		}
	}

	// The base64 length cap is the bound that actually fires: at
	// documentsMaxUploadBase64 characters the decoded size is exactly 5MiB,
	// which is not greater than 5 * 1024 * 1024, so the module's own decoded
	// size check never trips. One character more is refused by the schema.
	atCap := documentsExecuteFor(t, fx, documentsCreateDocumentCapabilityID,
		`{"title":"At cap","fileBase64":"`+documentsRepeat("A", documentsMaxUploadBase64)+`","mimeType":"application/pdf"}`)
	if !atCap.OK {
		t.Fatalf("upload at the base64 cap = %+v, want acceptance", atCap)
	}
	overCap := documentsExecuteFor(t, fx, documentsCreateDocumentCapabilityID,
		`{"title":"Over cap","fileBase64":"`+documentsRepeat("A", documentsMaxUploadBase64+1)+`","mimeType":"application/pdf"}`)
	if overCap.OK || overCap.Error == "" || !strings.Contains(overCap.Error, "fileBase64") {
		t.Fatalf("an upload past the base64 cap = %+v, want the parser to refuse it", overCap)
	}

	firstVersion := documentsExecuteFor(t, fx, documentsAddVersionCapabilityID,
		`{"documentId":"`+local+`","rawText":"second text","note":"revision one"}`)
	if !firstVersion.OK {
		t.Fatalf("addVersion result=%+v", firstVersion)
	}
	var versionOut DocumentVersionOutput
	if err := json.Unmarshal(firstVersion.Data, &versionOut); err != nil {
		t.Fatal(err)
	}
	if versionOut.Version != 1 {
		t.Fatalf("first version = %d, want 1", versionOut.Version)
	}
	var storedText string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT raw_text FROM documents WHERE id=$1::uuid`, local).Scan(&storedText); err != nil {
		t.Fatal(err)
	}
	if storedText != "second text" {
		t.Fatalf("documents.raw_text = %q, want the new content", storedText)
	}
	var archived string
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT raw_text FROM document_versions WHERE document_id=$1::uuid AND version=1`, local).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if archived != "first text" {
		t.Fatalf("archived version text = %q, want the replaced content", archived)
	}

	versions := documentsExecuteFor(t, fx, documentsListVersionsCapabilityID, `{"documentId":"`+local+`"}`)
	if !versions.OK {
		t.Fatalf("listVersions result=%+v", versions)
	}
	var versionsOut ListIngestedDocumentVersionsOutput
	if err := json.Unmarshal(versions.Data, &versionsOut); err != nil {
		t.Fatal(err)
	}
	if len(versionsOut.Versions) != 1 || versionsOut.Versions[0].Version != 1 ||
		versionsOut.Versions[0].Note == nil || *versionsOut.Versions[0].Note != "revision one" {
		t.Fatalf("listVersions = %+v", versionsOut.Versions)
	}

	// Cross-tenant access must not read, version, or delete.
	foreignVersions := documentsExecuteFor(t, fx, documentsListVersionsCapabilityID, `{"documentId":"`+foreign+`"}`)
	if !foreignVersions.OK {
		t.Fatalf("listVersions result=%+v", foreignVersions)
	}
	var foreignList ListIngestedDocumentVersionsOutput
	if err := json.Unmarshal(foreignVersions.Data, &foreignList); err != nil {
		t.Fatal(err)
	}
	if len(foreignList.Versions) != 0 {
		t.Fatalf("listVersions leaked %d foreign versions", len(foreignList.Versions))
	}
	foreignAdd := documentsExecuteFor(t, fx, documentsAddVersionCapabilityID,
		`{"documentId":"`+foreign+`","rawText":"tampered"}`)
	if foreignAdd.OK || foreignAdd.Error != "document not found" {
		t.Fatalf("addVersion on a foreign document = %+v, want document not found", foreignAdd)
	}
	// A foreign delete reports deleted:false rather than refusing, because the
	// module's delete is a plain scoped delete with no existence check.
	foreignDelete := documentsExecuteFor(t, fx, documentsDeleteDocumentCapabilityID,
		`{"documentId":"`+foreign+`"}`)
	if !foreignDelete.OK {
		t.Fatalf("deleteDocument on a foreign document = %+v", foreignDelete)
	}
	var deleteOut DeleteIngestedDocumentOutput
	if err := json.Unmarshal(foreignDelete.Data, &deleteOut); err != nil {
		t.Fatal(err)
	}
	if deleteOut.Deleted {
		t.Fatal("deleteDocument reported success against another organization's document")
	}

	emptyVersion := documentsExecuteFor(t, fx, documentsAddVersionCapabilityID,
		`{"documentId":"`+local+`"}`)
	if emptyVersion.OK || emptyVersion.Error != "a version needs contentBase64 or rawText" {
		t.Fatalf("addVersion without content = %+v", emptyVersion)
	}

	deleted := documentsExecuteFor(t, fx, documentsDeleteDocumentCapabilityID, `{"documentId":"`+local+`"}`)
	if !deleted.OK {
		t.Fatalf("deleteDocument result=%+v", deleted)
	}
	if err := json.Unmarshal(deleted.Data, &deleteOut); err != nil {
		t.Fatal(err)
	}
	if !deleteOut.Deleted {
		t.Fatal("deleteDocument reported deleted=false for an owned document")
	}
}

func TestGoDocumentsParsePastedTextAndPreserveFailedUploadState(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)
	t.Setenv("NVIDIA_API_KEY", "")
	grantWavePermission(t, fx, "documents.write")

	executeParse := func(documentID, intentID string) Result {
		t.Helper()
		raw := json.RawMessage(`{"documentId":"` + documentID + `"}`)
		result, err := fx.executor.Execute(fx.ctx,
			waveModuleClaims(fx, documentsParseDocumentCapabilityID, "documents.write", raw, "human", "", intentID),
			documentsParseDocumentCapabilityID, raw)
		if err != nil {
			t.Fatalf("parseDocument executor error: %v", err)
		}
		return result
	}

	localID := documentsSeedIngested(t, fx, fx.orgID, "Local parse", "Reconcile the bank statement every Friday. 🧾")
	foreignID := documentsSeedIngested(t, fx, fx.otherOrgID, "Foreign parse", "foreign text")
	localSource := "document:" + localID
	foreignSource := "document:" + foreignID
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO memories (org_id, kind, source, content, metadata)
		VALUES ($1::uuid, 'doc_chunk', $2, 'old local chunk', '{}'::jsonb),
		       ($3::uuid, 'doc_chunk', $4, 'foreign chunk', '{}'::jsonb)`,
		fx.orgID, localSource, fx.otherOrgID, foreignSource); err != nil {
		t.Fatal(err)
	}

	parsed := executeParse(localID, "parse-text-"+localID)
	if !parsed.OK {
		t.Fatalf("parseDocument result=%+v", parsed)
	}
	var output ParseDocumentOutput
	if err := json.Unmarshal(parsed.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.Status != "parsed" || output.Chars != documentsParseJSLength("Reconcile the bank statement every Friday. 🧾") {
		t.Fatalf("parseDocument output=%+v", output)
	}
	var status, markdown string
	var parseError *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, parsed_markdown, parse_error FROM documents
		WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, localID).Scan(&status, &markdown, &parseError); err != nil {
		t.Fatal(err)
	}
	if status != "parsed" || markdown != "Reconcile the bank statement every Friday. 🧾" || parseError != nil {
		t.Fatalf("stored parse state status=%q markdown=%q parseError=%v", status, markdown, parseError)
	}
	var localMemories int
	var memoryContent, memoryKind string
	var metadata []byte
	var hasEmbedding bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*) OVER (), content, kind, metadata, embedding IS NOT NULL
		FROM memories WHERE org_id=$1::uuid AND source=$2`, fx.orgID, localSource).
		Scan(&localMemories, &memoryContent, &memoryKind, &metadata, &hasEmbedding); err != nil {
		t.Fatal(err)
	}
	if localMemories != 1 || memoryContent != markdown || memoryKind != "doc_chunk" || !hasEmbedding {
		t.Fatalf("replacement memory count=%d content=%q kind=%q hasEmbedding=%t", localMemories, memoryContent, memoryKind, hasEmbedding)
	}
	var memoryMetadata map[string]string
	if err := json.Unmarshal(metadata, &memoryMetadata); err != nil {
		t.Fatal(err)
	}
	if memoryMetadata["documentId"] != localID || memoryMetadata["title"] != "Local parse" {
		t.Fatalf("memory metadata=%v", memoryMetadata)
	}
	var foreignMemoryCount int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM memories WHERE org_id=$1::uuid AND source=$2`, fx.otherOrgID, foreignSource).Scan(&foreignMemoryCount); err != nil {
		t.Fatal(err)
	}
	if foreignMemoryCount != 1 {
		t.Fatalf("foreign memory count=%d, want 1", foreignMemoryCount)
	}

	foreignParse := executeParse(foreignID, "parse-foreign-"+foreignID)
	if foreignParse.OK || !strings.Contains(foreignParse.Error, "no document") {
		t.Fatalf("parseDocument for foreign organization row=%+v", foreignParse)
	}

	var recognizedUploadID string
	ocrCalled := false
	fx.executor.documentsOCR = documentsImageParserFunc(func(_ context.Context, mimeType string, image []byte) (string, error) {
		ocrCalled = true
		if mimeType != "application/pdf" || string(image) != "JVBERi0x" {
			t.Fatalf("OCR input mime=%q image=%q", mimeType, image)
		}
		return "Scanned invoice\nTotal: 42", nil
	})
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, mime_type, content_base64, status, created_by_actor_type)
		VALUES ($1::uuid, 'Scanned upload', 'upload', 'application/pdf', 'SlZCRVJpMHg=', 'received', 'human')
		RETURNING id::text`, fx.orgID).Scan(&recognizedUploadID); err != nil {
		t.Fatal(err)
	}
	ocrResult := executeParse(recognizedUploadID, "parse-ocr-"+recognizedUploadID)
	if !ocrResult.OK || !ocrCalled {
		t.Fatalf("mock OCR parse result=%+v called=%t", ocrResult, ocrCalled)
	}
	var recognizedMarkdown string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT parsed_markdown FROM documents WHERE id=$1::uuid`, recognizedUploadID).Scan(&recognizedMarkdown); err != nil {
		t.Fatal(err)
	}
	if recognizedMarkdown != "Scanned invoice\nTotal: 42" {
		t.Fatalf("OCR markdown=%q", recognizedMarkdown)
	}

	var uploadID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, mime_type, content_base64, status, created_by_actor_type)
		VALUES ($1::uuid, 'Unsupported upload', 'upload', 'application/pdf', 'JVBERi0x', 'received', 'human')
		RETURNING id::text`, fx.orgID).Scan(&uploadID); err != nil {
		t.Fatal(err)
	}
	fx.executor.documentsOCR = nil
	failedIntent := "parse-failed-" + uploadID
	failed := executeParse(uploadID, failedIntent)
	if failed.OK || !strings.Contains(failed.Error, "parse failed: OCR provider is not configured") {
		t.Fatalf("unsupported upload parse result=%+v, want committed failed result", failed)
	}
	var failedOutput ParseDocumentOutput
	if err := json.Unmarshal(failed.Data, &failedOutput); err != nil {
		t.Fatal(err)
	}
	if failedOutput.Status != "failed" || failedOutput.Chars != 0 {
		t.Fatalf("unsupported upload output=%+v", failedOutput)
	}
	var failedStatus, failedMessage string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, parse_error FROM documents WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, uploadID).
		Scan(&failedStatus, &failedMessage); err != nil {
		t.Fatal(err)
	}
	if failedStatus != "failed" || !strings.Contains(failedMessage, "OCR provider is not configured") {
		t.Fatalf("unsupported upload stored state status=%q parseError=%q", failedStatus, failedMessage)
	}
	var receiptOK bool
	var receiptError string
	var receiptData []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT ok, error, data FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`,
		fx.orgID, fx.orgID+":"+failedIntent).Scan(&receiptOK, &receiptError, &receiptData); err != nil {
		t.Fatal(err)
	}
	var receiptOutput ParseDocumentOutput
	if err := json.Unmarshal(receiptData, &receiptOutput); err != nil {
		t.Fatal(err)
	}
	if receiptOK || receiptError != failed.Error || receiptOutput.Status != "failed" {
		t.Fatalf("failure receipt ok=%t error=%q data=%s", receiptOK, receiptError, receiptData)
	}
}

func TestGoDocumentsParseConcurrentFailureCannotOverwriteSuccess(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)
	grantWavePermission(t, fx, "documents.write")

	var documentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, mime_type, content_base64, status, created_by_actor_type)
		VALUES ($1::uuid, 'Concurrent parse', 'upload', 'application/pdf', 'JVBERi0x', 'received', 'human')
		RETURNING id::text`, fx.orgID).Scan(&documentID); err != nil {
		t.Fatal(err)
	}

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var parserCalls int
	var parserMu sync.Mutex
	fx.executor.documentsOCR = documentsImageParserFunc(func(ctx context.Context, _ string, _ []byte) (string, error) {
		parserMu.Lock()
		parserCalls++
		call := parserCalls
		parserMu.Unlock()
		if call == 1 {
			close(firstStarted)
			select {
			case <-releaseFirst:
				return "", context.DeadlineExceeded
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return "Successful OCR", nil
	})

	execute := func(intentID string) Result {
		raw := json.RawMessage(`{"documentId":"` + documentID + `"}`)
		result, err := fx.executor.Execute(fx.ctx,
			waveModuleClaims(fx, documentsParseDocumentCapabilityID, "documents.write", raw, "human", "", intentID),
			documentsParseDocumentCapabilityID, raw)
		if err != nil {
			return Result{Error: err.Error()}
		}
		return result
	}

	firstResult := make(chan Result, 1)
	go func() { firstResult <- execute("parse-race-first-" + documentID) }()
	select {
	case <-firstStarted:
	case <-fx.ctx.Done():
		t.Fatal("first parse did not reach OCR")
	}
	second := execute("parse-race-second-" + documentID)
	if !second.OK {
		close(releaseFirst)
		t.Fatalf("second parse result=%+v", second)
	}
	close(releaseFirst)
	first := <-firstResult
	if first.OK || !strings.Contains(first.Error, "document changed while it was being parsed") {
		t.Fatalf("stale first parse result=%+v, want concurrency rejection", first)
	}

	var status, markdown string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, parsed_markdown FROM documents WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, documentID).Scan(&status, &markdown); err != nil {
		t.Fatal(err)
	}
	if status != "parsed" || markdown != "Successful OCR" {
		t.Fatalf("stored parse state status=%q markdown=%q, want successful result", status, markdown)
	}
}

func TestGoDocumentsParseReleasesTransactionDuringOCRAndRejectsStaleConcurrentParse(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)
	grantWavePermission(t, fx, "documents.write")

	config := fx.runtime.Config().Copy()
	config.MaxConns = 1
	limitedRuntime, err := pgxpool.NewWithConfig(fx.ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(limitedRuntime.Close)
	previousPool := fx.executor.pool
	fx.executor.pool = limitedRuntime
	t.Cleanup(func() { fx.executor.pool = previousPool })

	var documentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, mime_type, content_base64, status, created_by_actor_type)
		VALUES ($1::uuid, 'Concurrent OCR', 'upload', 'image/png', 'aW1hZ2U=', 'received', 'human')
		RETURNING id::text`, fx.orgID).Scan(&documentID); err != nil {
		t.Fatal(err)
	}

	started := make(chan int, 2)
	releaseFirst := make(chan struct{})
	releaseSecond := make(chan struct{})
	var releaseFirstOnce, releaseSecondOnce sync.Once
	releaseFirstOCR := func() { releaseFirstOnce.Do(func() { close(releaseFirst) }) }
	releaseSecondOCR := func() { releaseSecondOnce.Do(func() { close(releaseSecond) }) }
	var callCount int
	var callMu sync.Mutex
	fx.executor.documentsOCR = documentsImageParserFunc(func(context.Context, string, []byte) (string, error) {
		callMu.Lock()
		callCount++
		call := callCount
		callMu.Unlock()
		started <- call
		if call == 1 {
			<-releaseFirst
			return "first parse", nil
		}
		<-releaseSecond
		return "stale parse", nil
	})
	t.Cleanup(func() {
		releaseFirstOCR()
		releaseSecondOCR()
	})

	type parseOutcome struct {
		call   int
		result Result
		err    error
	}
	outcomes := make(chan parseOutcome, 2)
	startParse := func(call int, intentID string) {
		raw := json.RawMessage(`{"documentId":"` + documentID + `"}`)
		claims := waveModuleClaims(fx, documentsParseDocumentCapabilityID, "documents.write", raw, "human", "", intentID)
		go func() {
			result, err := fx.executor.Execute(fx.ctx, claims, documentsParseDocumentCapabilityID, raw)
			outcomes <- parseOutcome{call: call, result: result, err: err}
		}()
	}

	startParse(1, "parse-concurrent-first-"+documentID)
	select {
	case call := <-started:
		if call != 1 {
			t.Fatalf("first OCR call number=%d", call)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first OCR request did not start")
	}
	startParse(2, "parse-concurrent-second-"+documentID)
	select {
	case call := <-started:
		if call != 2 {
			t.Fatalf("second OCR call number=%d", call)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second OCR request did not start while the first was waiting")
	}

	queryCtx, cancel := context.WithTimeout(fx.ctx, 2*time.Second)
	defer cancel()
	if _, err := dbx.WithOrgTx(queryCtx, limitedRuntime, fx.orgID, func(tx pgx.Tx) (int, error) {
		var one int
		err := tx.QueryRow(queryCtx, `SELECT 1`).Scan(&one)
		return one, err
	}); err != nil {
		t.Fatalf("single-connection org database operation blocked during OCR: %v", err)
	}

	releaseFirstOCR()
	var first parseOutcome
	select {
	case first = <-outcomes:
	case <-time.After(5 * time.Second):
		t.Fatal("first parse did not finish after OCR was released")
	}
	if first.call != 1 || first.err != nil || !first.result.OK {
		t.Fatalf("first parse outcome=%+v, want committed success", first)
	}
	releaseSecondOCR()
	var second parseOutcome
	select {
	case second = <-outcomes:
	case <-time.After(5 * time.Second):
		t.Fatal("second parse did not finish after OCR was released")
	}
	if second.call != 2 || second.err != nil || second.result.OK || !strings.Contains(second.result.Error, "document changed while it was being parsed") {
		t.Fatalf("second parse outcome=%+v, want stale-source rejection", second)
	}

	var markdown string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT parsed_markdown FROM documents WHERE id=$1::uuid`, documentID).Scan(&markdown); err != nil {
		t.Fatal(err)
	}
	if markdown != "first parse" {
		t.Fatalf("parsed markdown=%q, want first committed parse", markdown)
	}
}

func documentsRepeat(value string, count int) string {
	out := make([]byte, 0, len(value)*count)
	for index := 0; index < count; index++ {
		out = append(out, value...)
	}
	return string(out)
}

// TestGoDocumentsAuthoredLifecycle covers create, publish, list versions,
// restore, metadata update, and delete for authored documents.
func TestGoDocumentsAuthoredLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)

	template := documentsExecuteFor(t, fx, documentsCreateTemplateCapabilityID,
		`{"name":"Invoice template","description":"House style","content":{"type":"doc","text":"Bill {{customer.name}} at {{invoice.total}}"}}`)
	if !template.OK {
		t.Fatalf("createTemplate result=%+v", template)
	}
	var templateOut CreateDocumentTemplateOutput
	if err := json.Unmarshal(template.Data, &templateOut); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(templateOut.Placeholders, []string{"customer.name", "invoice.total"}) {
		t.Fatalf("placeholders = %v, want both tokens in content order", templateOut.Placeholders)
	}

	document := documentsExecuteFor(t, fx, documentsCreateDocCapabilityID,
		`{"title":"Quotation","content":{"type":"doc"},"html":"<p>draft</p>","templateId":"`+templateOut.TemplateID+
			`","folder":" Finance / 2026 ","pageSettings":{"size":"Letter"},"linkedRecordType":"customer"}`)
	if !document.OK {
		t.Fatalf("createDoc result=%+v", document)
	}
	var documentOut CreateAuthoredDocumentOutput
	if err := json.Unmarshal(document.Data, &documentOut); err != nil {
		t.Fatal(err)
	}
	var storedFolder, storedSize string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(folder, ''), page_settings->>'size' FROM authored_docs WHERE id=$1::uuid`, documentOut.DocumentID).
		Scan(&storedFolder, &storedSize); err != nil {
		t.Fatal(err)
	}
	if storedFolder != "Finance/2026" {
		t.Fatalf("stored folder = %q, want the normalized path", storedFolder)
	}
	if storedSize != "Letter" {
		t.Fatalf("stored page size = %q, want Letter with the other two fields defaulted", storedSize)
	}

	published := documentsExecuteFor(t, fx, documentsSaveDocVersionCapabilityID,
		`{"documentId":"`+documentOut.DocumentID+`","title":"Quotation v1","content":{"type":"doc","version":1},"html":"<p>v1</p>","note":"first release"}`)
	if !published.OK {
		t.Fatalf("saveDocVersion result=%+v", published)
	}
	var publishOut DocumentVersionOutput
	if err := json.Unmarshal(published.Data, &publishOut); err != nil {
		t.Fatal(err)
	}
	if publishOut.Version != 1 {
		t.Fatalf("published version = %d, want 1", publishOut.Version)
	}
	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM authored_docs WHERE id=$1::uuid`, documentOut.DocumentID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "published" {
		t.Fatalf("status after publish = %q, want published", status)
	}

	second := documentsExecuteFor(t, fx, documentsSaveDocVersionCapabilityID,
		`{"documentId":"`+documentOut.DocumentID+`","content":{"type":"doc","version":2},"html":"<p>v2</p>","note":"second release"}`)
	if !second.OK {
		t.Fatalf("saveDocVersion result=%+v", second)
	}
	if err := json.Unmarshal(second.Data, &publishOut); err != nil {
		t.Fatal(err)
	}
	if publishOut.Version != 2 {
		t.Fatalf("second published version = %d, want 2", publishOut.Version)
	}

	// documents.listDocVersions belongs to a prior wave and is covered by
	// documents_versions_test.go, so only the two snapshots this test wrote are
	// counted here.
	var publishedCount int
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT count(*)::int FROM authored_doc_versions WHERE org_id=$1::uuid AND document_id=$2::uuid`,
		fx.orgID, documentOut.DocumentID).Scan(&publishedCount); err != nil {
		t.Fatal(err)
	}
	if publishedCount != 2 {
		t.Fatalf("published versions = %d, want 2", publishedCount)
	}

	// Version 1 is the snapshot the first publish took, which is the draft
	// createDoc stored; version 2 is the first published body.
	restored := documentsExecuteFor(t, fx, documentsRestoreDocVersionCapabilityID,
		`{"documentId":"`+documentOut.DocumentID+`","sourceVersion":2}`)
	if !restored.OK {
		t.Fatalf("restoreDocVersion result=%+v", restored)
	}
	var restoreOut DocumentVersionOutput
	if err := json.Unmarshal(restored.Data, &restoreOut); err != nil {
		t.Fatal(err)
	}
	if restoreOut.Version != 3 {
		t.Fatalf("restore created version %d, want 3", restoreOut.Version)
	}
	var restoredHTML string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT html FROM authored_docs WHERE id=$1::uuid`, documentOut.DocumentID).Scan(&restoredHTML); err != nil {
		t.Fatal(err)
	}
	if restoredHTML != "<p>v1</p>" {
		t.Fatalf("restored html = %q, want the version 1 body", restoredHTML)
	}
	var restoreNote string
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT note FROM authored_doc_versions WHERE document_id=$1::uuid AND version=3`, documentOut.DocumentID).Scan(&restoreNote); err != nil {
		t.Fatal(err)
	}
	if restoreNote != "Restored from version 2" {
		t.Fatalf("restore snapshot note = %q", restoreNote)
	}

	missingVersion := documentsExecuteFor(t, fx, documentsRestoreDocVersionCapabilityID,
		`{"documentId":"`+documentOut.DocumentID+`","sourceVersion":99}`)
	if missingVersion.OK || missingVersion.Error != "no version 99" {
		t.Fatalf("restore of a missing version = %+v", missingVersion)
	}

	updated := documentsExecuteFor(t, fx, documentsUpdateDocMetadataCapabilityID,
		`{"documentId":"`+documentOut.DocumentID+`","title":"  Renamed  ","folder":null,"linkedRecordLabel":"Ada"}`)
	if !updated.OK {
		t.Fatalf("updateDocMetadata result=%+v", updated)
	}
	var updatedOut UpdateAuthoredDocumentMetadataOutput
	if err := json.Unmarshal(updated.Data, &updatedOut); err != nil {
		t.Fatal(err)
	}
	if updatedOut.DocumentID != documentOut.DocumentID {
		t.Fatalf("updateDocMetadata documentId = %q", updatedOut.DocumentID)
	}
	if updatedOut.Previous.Title != "Quotation v1" {
		t.Fatalf("previous title = %q, want the title before the update", updatedOut.Previous.Title)
	}
	if updatedOut.Previous.Folder == nil || *updatedOut.Previous.Folder != "Finance/2026" {
		t.Fatalf("previous folder = %v, want the folder before the clear", updatedOut.Previous.Folder)
	}
	var renamed, clearedFolder, label string
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT title, coalesce(folder, '<null>'), coalesce(linked_record_label, '') FROM authored_docs WHERE id=$1::uuid`,
		documentOut.DocumentID).Scan(&renamed, &clearedFolder, &label); err != nil {
		t.Fatal(err)
	}
	if renamed != "Renamed" {
		t.Fatalf("title = %q, want the trimmed update", renamed)
	}
	if clearedFolder != "<null>" {
		t.Fatalf("folder = %q, want the explicit null to clear it", clearedFolder)
	}
	if label != "Ada" {
		t.Fatalf("linked record label = %q", label)
	}
	// linkedRecordType was absent, so it must be untouched.
	var linkType string
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT coalesce(linked_record_type, '<null>') FROM authored_docs WHERE id=$1::uuid`, documentOut.DocumentID).Scan(&linkType); err != nil {
		t.Fatal(err)
	}
	if linkType != "customer" {
		t.Fatalf("linked record type = %q, want the absent field left alone", linkType)
	}

	foreignDoc := documentsSeedAuthored(t, fx, fx.otherOrgID, "Foreign", "Finance")
	foreignUpdate := documentsExecuteFor(t, fx, documentsUpdateDocMetadataCapabilityID,
		`{"documentId":"`+foreignDoc+`","title":"Hijacked"}`)
	if foreignUpdate.OK || foreignUpdate.Error != "document not found" {
		t.Fatalf("updateDocMetadata on a foreign document = %+v", foreignUpdate)
	}
	foreignDelete := documentsExecuteFor(t, fx, documentsDeleteDocCapabilityID,
		`{"documentId":"`+foreignDoc+`"}`)
	if !foreignDelete.OK {
		t.Fatalf("deleteDoc result=%+v", foreignDelete)
	}
	var foreignDeleteOut DeleteAuthoredDocumentOutput
	if err := json.Unmarshal(foreignDelete.Data, &foreignDeleteOut); err != nil {
		t.Fatal(err)
	}
	if foreignDeleteOut.Deleted {
		t.Fatal("deleteDoc reported success against another organization's document")
	}

	deleted := documentsExecuteFor(t, fx, documentsDeleteDocCapabilityID, `{"documentId":"`+documentOut.DocumentID+`"}`)
	if !deleted.OK {
		t.Fatalf("deleteDoc result=%+v", deleted)
	}
	if err := json.Unmarshal(deleted.Data, &foreignDeleteOut); err != nil {
		t.Fatal(err)
	}
	if !foreignDeleteOut.Deleted {
		t.Fatal("deleteDoc reported deleted=false for an owned document")
	}
}

// TestGoDocumentsFolders covers folder creation with ancestors, the refusal to
// orphan documents or nested folders, and an atomic rename.
func TestGoDocumentsFolders(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)

	created := documentsExecuteFor(t, fx, documentsCreateFolderCapabilityID, `{"path":"  Finance / 2026 / Q1  "}`)
	if !created.OK {
		t.Fatalf("createFolder result=%+v", created)
	}
	var createdOut CreateDocumentFolderOutput
	if err := json.Unmarshal(created.Data, &createdOut); err != nil {
		t.Fatal(err)
	}
	if createdOut.Path != "Finance/2026/Q1" || !isUUID(createdOut.FolderID) {
		t.Fatalf("createFolder = %+v", createdOut)
	}
	// Every ancestor is materialized so the tree is navigable.
	for _, path := range []string{"Finance", "Finance/2026", "Finance/2026/Q1"} {
		var count int
		if err := fx.owner.QueryRow(fx.ctx,
			`SELECT count(*)::int FROM doc_folders WHERE org_id=$1::uuid AND path=$2`, fx.orgID, path).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Errorf("folder %q exists %d times, want 1", path, count)
		}
	}
	duplicate := documentsExecuteFor(t, fx, documentsCreateFolderCapabilityID, `{"path":"Finance/2026/Q1"}`)
	if duplicate.OK || duplicate.Error != "a folder with that path already exists" {
		t.Fatalf("duplicate createFolder = %+v", duplicate)
	}
	blank := documentsExecuteFor(t, fx, documentsCreateFolderCapabilityID, `{"path":"   "}`)
	if blank.OK || blank.Error != "folder name is required" {
		t.Fatalf("blank createFolder = %+v", blank)
	}

	listed := documentsExecuteFor(t, fx, documentsListFoldersCapabilityID, `{}`)
	if !listed.OK {
		t.Fatalf("listFolders result=%+v", listed)
	}
	var listedOut ListDocumentFoldersOutput
	if err := json.Unmarshal(listed.Data, &listedOut); err != nil {
		t.Fatal(err)
	}
	if len(listedOut.Folders) != 3 {
		t.Fatalf("listFolders returned %d folders, want 3", len(listedOut.Folders))
	}
	for index := 1; index < len(listedOut.Folders); index++ {
		if listedOut.Folders[index-1].Path > listedOut.Folders[index].Path {
			t.Fatalf("listFolders is not ordered by path: %+v", listedOut.Folders)
		}
	}

	// A folder that still holds documents must not be removed.
	documentsSeedAuthored(t, fx, fx.orgID, "Held", "Finance/2026/Q1")
	occupied := documentsExecuteFor(t, fx, documentsDeleteFolderCapabilityID, `{"path":"Finance/2026/Q1"}`)
	if occupied.OK || occupied.Error != "move the documents and nested folders before deleting this folder" {
		t.Fatalf("deleteFolder on an occupied folder = %+v", occupied)
	}
	// Nor may a folder that has a nested folder.
	nested := documentsExecuteFor(t, fx, documentsDeleteFolderCapabilityID, `{"path":"Finance/2026"}`)
	if nested.OK || nested.Error != "move the documents and nested folders before deleting this folder" {
		t.Fatalf("deleteFolder on a parent folder = %+v", nested)
	}

	renamed := documentsExecuteFor(t, fx, documentsRenameFolderCapabilityID,
		`{"path":"Finance/2026/Q1","newPath":"Money/2026/Q1"}`)
	if !renamed.OK {
		t.Fatalf("renameFolder result=%+v", renamed)
	}
	var renamedOut RenameDocumentFolderOutput
	if err := json.Unmarshal(renamed.Data, &renamedOut); err != nil {
		t.Fatal(err)
	}
	if renamedOut.Path != "Finance/2026/Q1" || renamedOut.MovedTo != "Money/2026/Q1" {
		t.Fatalf("renameFolder = %+v", renamedOut)
	}
	var movedDocumentFolder string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT folder FROM authored_docs WHERE title='Held' AND org_id=$1::uuid`, fx.orgID).
		Scan(&movedDocumentFolder); err != nil {
		t.Fatal(err)
	}
	if movedDocumentFolder != "Money/2026/Q1" {
		t.Fatalf("renamed document folder = %q, want the moved path", movedDocumentFolder)
	}
	samePath := documentsExecuteFor(t, fx, documentsRenameFolderCapabilityID,
		`{"path":"Money/2026/Q1","newPath":"  Money / 2026 / Q1  "}`)
	if samePath.OK || samePath.Error != "choose a different folder path" {
		t.Fatalf("renameFolder to the same path = %+v", samePath)
	}
	insideItself := documentsExecuteFor(t, fx, documentsRenameFolderCapabilityID,
		`{"path":"Money","newPath":"Money/nested"}`)
	if insideItself.OK || insideItself.Error != "a folder cannot be moved inside itself" {
		t.Fatalf("renameFolder inside itself = %+v", insideItself)
	}

	// The rename moved the target subtree and nothing else, so the old
	// ancestors still exist while Money itself never did.
	for _, path := range []string{"Finance", "Finance/2026"} {
		var stillThere int
		if err := fx.owner.QueryRow(fx.ctx,
			`SELECT count(*)::int FROM doc_folders WHERE org_id=$1::uuid AND path=$2`, fx.orgID, path).Scan(&stillThere); err != nil {
			t.Fatal(err)
		}
		if stillThere != 1 {
			t.Errorf("folder %q was moved by a rename of a sibling subtree", path)
		}
	}

	// With the document gone the leaf folder deletes, and the report is honest
	// about a folder that never existed.
	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM authored_docs WHERE org_id=$1::uuid AND title='Held'`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"Money/2026/Q1"} {
		deleted := documentsExecuteFor(t, fx, documentsDeleteFolderCapabilityID, `{"path":"`+path+`"}`)
		if !deleted.OK {
			t.Fatalf("deleteFolder %s = %+v", path, deleted)
		}
		var deletedOut DeleteDocumentFolderOutput
		if err := json.Unmarshal(deleted.Data, &deletedOut); err != nil {
			t.Fatal(err)
		}
		if !deletedOut.Deleted || deletedOut.Path != path {
			t.Fatalf("deleteFolder %s = %+v", path, deletedOut)
		}
	}
	// Finance/2026 has no document and no nested folder any more, so it goes.
	for _, path := range []string{"Finance/2026", "Finance"} {
		deleted := documentsExecuteFor(t, fx, documentsDeleteFolderCapabilityID, `{"path":"`+path+`"}`)
		if !deleted.OK {
			t.Fatalf("deleteFolder %s = %+v", path, deleted)
		}
		var deletedOut DeleteDocumentFolderOutput
		if err := json.Unmarshal(deleted.Data, &deletedOut); err != nil {
			t.Fatal(err)
		}
		if !deletedOut.Deleted {
			t.Fatalf("deleteFolder %s reported deleted=false", path)
		}
	}
	// Only the target subtree moved, so Money/2026 and Money never existed.
	missing := documentsExecuteFor(t, fx, documentsDeleteFolderCapabilityID, `{"path":"Money/2026"}`)
	if !missing.OK {
		t.Fatalf("deleteFolder on a missing folder = %+v", missing)
	}
	var missingOut DeleteDocumentFolderOutput
	if err := json.Unmarshal(missing.Data, &missingOut); err != nil {
		t.Fatal(err)
	}
	if missingOut.Deleted {
		t.Fatal("deleteFolder reported deleted=true for a folder that never existed")
	}
}

// TestGoDocumentsTemplatesAndMemory covers template listing, the built-in
// deletion guard, memory search, and memory deletion.
func TestGoDocumentsTemplatesAndMemory(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)

	systemID := documentsSeedTemplate(t, fx, fx.orgID, "System letter", "system", `{"type":"doc","text":"Dear {{sender.name}}"}`)
	ownID := documentsSeedTemplate(t, fx, fx.orgID, "Own note", "", `{"type":"doc","text":"Note for {{employee.name}}"}`)
	foreignID := documentsSeedTemplate(t, fx, fx.otherOrgID, "Foreign", "", `{"type":"doc"}`)

	listed := documentsExecuteFor(t, fx, documentsListTemplatesCapabilityID, `{}`)
	if !listed.OK {
		t.Fatalf("listTemplates result=%+v", listed)
	}
	var listedOut ListDocumentTemplatesOutput
	if err := json.Unmarshal(listed.Data, &listedOut); err != nil {
		t.Fatal(err)
	}
	if len(listedOut.Templates) != 2 {
		t.Fatalf("listTemplates returned %d templates, want 2 local ones", len(listedOut.Templates))
	}
	// desc(is_system) in PostgreSQL orders NULLs first, so a tenant's own
	// template leads and the built-in follows. Both orderings come straight
	// from the module's orderBy, so this pins the SQL rather than a preference.
	if listedOut.Templates[0].ID != ownID || listedOut.Templates[1].ID != systemID {
		t.Fatalf("listTemplates order = %s, %s; want the tenant template then the system one",
			listedOut.Templates[0].ID, listedOut.Templates[1].ID)
	}
	if !reflect.DeepEqual(listedOut.Templates[1].Placeholders, []string{"sender.name"}) {
		t.Fatalf("stored placeholders = %v", listedOut.Templates[1].Placeholders)
	}

	fetched := documentsExecuteFor(t, fx, documentsGetTemplateCapabilityID, `{"templateId":"`+ownID+`"}`)
	if !fetched.OK {
		t.Fatalf("getTemplate result=%+v", fetched)
	}
	var fetchedOut GetDocumentTemplateOutput
	if err := json.Unmarshal(fetched.Data, &fetchedOut); err != nil {
		t.Fatal(err)
	}
	if fetchedOut.Template.ID != ownID || fetchedOut.Template.Name != "Own note" {
		t.Fatalf("getTemplate = %+v", fetchedOut.Template)
	}
	var contentText string
	if err := json.Unmarshal(fetchedOut.Template.Content, &contentText); err == nil {
		t.Fatalf("template content decoded as a string, want an object: %s", fetchedOut.Template.Content)
	}
	foreignGet := documentsExecuteFor(t, fx, documentsGetTemplateCapabilityID, `{"templateId":"`+foreignID+`"}`)
	if foreignGet.OK || foreignGet.Error != "template not found" {
		t.Fatalf("getTemplate on a foreign template = %+v", foreignGet)
	}

	guarded := documentsExecuteFor(t, fx, documentsDeleteTemplateCapabilityID, `{"templateId":"`+systemID+`"}`)
	if guarded.OK || guarded.Error != "built-in templates cannot be deleted" {
		t.Fatalf("deleteTemplate on a system template = %+v", guarded)
	}
	foreignDelete := documentsExecuteFor(t, fx, documentsDeleteTemplateCapabilityID, `{"templateId":"`+foreignID+`"}`)
	if foreignDelete.OK || foreignDelete.Error != "template not found" {
		t.Fatalf("deleteTemplate on a foreign template = %+v", foreignDelete)
	}
	deleted := documentsExecuteFor(t, fx, documentsDeleteTemplateCapabilityID, `{"templateId":"`+ownID+`"}`)
	if !deleted.OK {
		t.Fatalf("deleteTemplate result=%+v", deleted)
	}
	var deletedOut DeleteDocumentTemplateOutput
	if err := json.Unmarshal(deleted.Data, &deletedOut); err != nil {
		t.Fatal(err)
	}
	if !deletedOut.Deleted {
		t.Fatal("deleteTemplate reported deleted=false for an owned template")
	}

	localMemory := documentsSeedMemory(t, fx, fx.orgID, "sop", "The ledger is reconciled every Friday 100% of the time")
	documentsSeedMemory(t, fx, fx.otherOrgID, "sop", "The foreign ledger mentions a needle that must not leak")

	searched := documentsExecuteFor(t, fx, documentsSearchMemoryCapabilityID, `{"query":"ledger","limit":5}`)
	if !searched.OK {
		t.Fatalf("searchMemory result=%+v", searched)
	}
	var searchedOut SearchOrgMemoryOutput
	if err := json.Unmarshal(searched.Data, &searchedOut); err != nil {
		t.Fatal(err)
	}
	if searchedOut.Mode != "text" {
		t.Fatalf("searchMemory mode = %q, want the deterministic text path", searchedOut.Mode)
	}
	if len(searchedOut.Results) != 1 || searchedOut.Results[0].Content != localMemory.content {
		t.Fatalf("searchMemory results = %+v, want only the local memory", searchedOut.Results)
	}

	rememberDeleted := documentsExecuteFor(t, fx, documentsDeleteOrgMemoryCapabilityID, `{"memoryId":"`+localMemory.id+`"}`)
	if !rememberDeleted.OK {
		t.Fatalf("deleteOrgMemory result=%+v", rememberDeleted)
	}
	var memoryOut DeleteOrgMemoryOutput
	if err := json.Unmarshal(rememberDeleted.Data, &memoryOut); err != nil {
		t.Fatal(err)
	}
	if !memoryOut.Deleted || memoryOut.Kind != "sop" {
		t.Fatalf("deleteOrgMemory = %+v", memoryOut)
	}
	var remaining int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*)::int FROM memories WHERE id=$1::uuid`, localMemory.id).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatal("the memory row survived deletion")
	}
}

// TestGoDocumentsSuggestCoding covers account suggestion, the replacement of
// any previous suggestion set, and the open-suggestion count that listDocuments
// reports.
func TestGoDocumentsSuggestCoding(t *testing.T) {
	fx := newExecutorFixture(t)
	documentsCleanup(t, fx)

	documentID := documentsSeedIngested(t, fx, fx.orgID, "Coded bill", "Office supplies and diesel")
	seedAccounts(t, fx, fx.orgID)
	foreignDocument := documentsSeedIngested(t, fx, fx.otherOrgID, "Foreign", "Office supplies")

	first := documentsExecuteFor(t, fx, documentsSuggestCodingCapabilityID,
		`{"documentId":"`+documentID+`","lines":[{"description":"Office supplies restock","quantityThousandths":2000,"unitPriceMinor":1500}]}`)
	if !first.OK {
		t.Fatalf("suggestCoding result=%+v", first)
	}
	var firstOut SuggestDocumentCodingOutput
	if err := json.Unmarshal(first.Data, &firstOut); err != nil {
		t.Fatal(err)
	}
	if len(firstOut.Suggestions) != 1 || firstOut.Suggestions[0].SuggestedAccountCode != "6100" ||
		firstOut.Suggestions[0].QuantityThousandths != 2000 || firstOut.Suggestions[0].UnitPriceMinor != 1500 {
		t.Fatalf("suggestCoding = %+v", firstOut.Suggestions)
	}
	var storedCode string
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT suggested_account_code FROM document_suggestions WHERE document_id=$1::uuid`, documentID).Scan(&storedCode); err != nil {
		t.Fatal(err)
	}
	if storedCode != "6100" {
		t.Fatalf("stored account code = %q", storedCode)
	}

	listed := documentsExecuteFor(t, fx, documentsListDocumentsCapabilityID, `{}`)
	if !listed.OK {
		t.Fatalf("listDocuments result=%+v", listed)
	}
	var listedOut ListIngestedDocumentsOutput
	if err := json.Unmarshal(listed.Data, &listedOut); err != nil {
		t.Fatal(err)
	}
	for _, document := range listedOut.Documents {
		if document.ID != documentID {
			continue
		}
		if document.OpenSuggestions != 1 {
			t.Fatalf("open suggestion count = %d, want 1", document.OpenSuggestions)
		}
	}

	// A second run replaces the first suggestion set rather than appending.
	second := documentsExecuteFor(t, fx, documentsSuggestCodingCapabilityID,
		`{"documentId":"`+documentID+`","lines":[{"description":"Diesel refuelling","unitPriceMinor":9000}]}`)
	if !second.OK {
		t.Fatalf("second suggestCoding result=%+v", second)
	}
	var storedCount int
	if err := fx.owner.QueryRow(fx.ctx,
		`SELECT count(*)::int FROM document_suggestions WHERE document_id=$1::uuid`, documentID).Scan(&storedCount); err != nil {
		t.Fatal(err)
	}
	if storedCount != 1 {
		t.Fatalf("a rerun left %d suggestions, want the previous set replaced", storedCount)
	}
	var secondOut SuggestDocumentCodingOutput
	if err := json.Unmarshal(second.Data, &secondOut); err != nil {
		t.Fatal(err)
	}
	if secondOut.Suggestions[0].SuggestedAccountCode != "6200" {
		t.Fatalf("diesel matched %+v, want account 6200", secondOut.Suggestions[0])
	}

	foreignCoding := documentsExecuteFor(t, fx, documentsSuggestCodingCapabilityID,
		`{"documentId":"`+foreignDocument+`","lines":[{"description":"Office supplies","unitPriceMinor":100}]}`)
	if foreignCoding.OK || foreignCoding.Error != "no document "+foreignDocument {
		t.Fatalf("suggestCoding on a foreign document = %+v, want the org-scoped refusal", foreignCoding)
	}

	unknown := documentsExecuteFor(t, fx, documentsSuggestCodingCapabilityID,
		`{"documentId":"`+documentID+`","lines":[{"description":"Anything","unitPriceMinor":100}]}`)
	if !unknown.OK {
		t.Fatalf("unmatched suggestCoding result=%+v", unknown)
	}
	var unknownOut SuggestDocumentCodingOutput
	if err := json.Unmarshal(unknown.Data, &unknownOut); err != nil {
		t.Fatal(err)
	}
	if unknownOut.Suggestions[0].SuggestedAccountCode != documentsCodingFallbackExpenseCode {
		t.Fatalf("unmatched line = %+v, want the fallback code", unknownOut.Suggestions[0])
	}
}

// TestGoDocumentsSearchRecords covers the template-fill lookups and their
// placeholder naming, including cross-tenant isolation.
func TestGoDocumentsSearchRecords(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "documents.read")
	documentsCleanup(t, fx)

	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, email, payment_term_days)
		VALUES ($1::uuid, 'Ada Lovelace', 'ada@example.test', 30)
		RETURNING id::text`, fx.orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	var foreignCustomerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, email)
		VALUES ($1::uuid, 'Foreign Needle', 'needle@example.test')
		RETURNING id::text`, fx.otherOrgID).Scan(&foreignCustomerID); err != nil {
		t.Fatal(err)
	}
	var employeeID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO employees (org_id, name, email, title, department, monthly_salary_minor, annual_leave_days, hired_at)
		VALUES ($1::uuid, 'Grace Hopper', 'grace@example.test', 'Engineer', 'Platform', 500_000, 25, '2020-03-01T09:00:00Z')
		RETURNING id::text`, fx.orgID).Scan(&employeeID); err != nil {
		t.Fatal(err)
	}
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, 7, 'sent', 'USD', 10_000, 1_500, 11_500, 2_000, '2026-01-05T00:00:00Z', '2026-02-04T00:00:00Z')
		RETURNING id::text`, fx.orgID, customerID).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_minor)
		VALUES ($1::uuid, 'Consulting hours', 1500, 6667), ($1::uuid, 'Travel', 1000, 12_000)`, invoiceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `
			DELETE FROM invoice_lines WHERE invoice_id IN (
				SELECT i.id FROM invoices i WHERE i.org_id IN ($1::uuid, $2::uuid))`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("clean up invoice lines: %v", err)
			return
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("clean up invoices: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("clean up customers: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM employees WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("clean up employees: %v", err)
		}
	})

	found := documentsExecuteFor(t, fx, documentsSearchRecordsCapabilityID, `{"type":"customer","query":"Ada"}`)
	if !found.OK {
		t.Fatalf("searchRecords result=%+v", found)
	}
	var foundOut SearchRecordsOutput
	if err := json.Unmarshal(found.Data, &foundOut); err != nil {
		t.Fatal(err)
	}
	if len(foundOut.Records) != 1 || foundOut.Records[0].ID != customerID {
		t.Fatalf("searchRecords customers = %+v", foundOut.Records)
	}
	values := foundOut.Records[0].Values
	if values["customer.name"] != "Ada Lovelace" || values["customer.email"] != "ada@example.test" {
		t.Fatalf("customer values = %+v", values)
	}
	if values["invoice.paymentInstructions"] != "Payment due in 30 days." {
		t.Fatalf("payment instructions = %q", values["invoice.paymentInstructions"])
	}
	var orgName string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name FROM organizations WHERE id=$1::uuid`, fx.orgID).Scan(&orgName); err != nil {
		t.Fatal(err)
	}
	if values["document.date"] == "" || values["employer.name"] != orgName {
		t.Fatalf("base values = %+v, want the organization name and the document date", values)
	}
	foreignLeak := documentsExecuteFor(t, fx, documentsSearchRecordsCapabilityID, `{"type":"customer","query":"Needle"}`)
	if !foreignLeak.OK {
		t.Fatalf("searchRecords result=%+v", foreignLeak)
	}
	var foreignOut SearchRecordsOutput
	if err := json.Unmarshal(foreignLeak.Data, &foreignOut); err != nil {
		t.Fatal(err)
	}
	if len(foreignOut.Records) != 0 {
		t.Fatalf("searchRecords leaked %d foreign customers", len(foreignOut.Records))
	}

	staff := documentsExecuteFor(t, fx, documentsSearchRecordsCapabilityID, `{"type":"employee","query":"Grace"}`)
	if !staff.OK {
		t.Fatalf("employee searchRecords result=%+v", staff)
	}
	var staffOut SearchRecordsOutput
	if err := json.Unmarshal(staff.Data, &staffOut); err != nil {
		t.Fatal(err)
	}
	if len(staffOut.Records) != 1 {
		t.Fatalf("employee searchRecords = %+v", staffOut.Records)
	}
	staffValues := staffOut.Records[0].Values
	if staffValues["employment.compensation"] != "$5,000.00" {
		t.Fatalf("employment.compensation = %q", staffValues["employment.compensation"])
	}
	if staffValues["employment.startDate"] != "2020-03-01" || staffValues["employment.leaveDays"] != "25" {
		t.Fatalf("employment values = %+v", staffValues)
	}
	if staffOut.Records[0].Detail != "Engineer | Platform" {
		t.Fatalf("employee detail = %q", staffOut.Records[0].Detail)
	}

	invoices := documentsExecuteFor(t, fx, documentsSearchRecordsCapabilityID, `{"type":"invoice","query":"7"}`)
	if !invoices.OK {
		t.Fatalf("invoice searchRecords result=%+v", invoices)
	}
	var invoiceOut SearchRecordsOutput
	if err := json.Unmarshal(invoices.Data, &invoiceOut); err != nil {
		t.Fatal(err)
	}
	if len(invoiceOut.Records) != 1 || invoiceOut.Records[0].ID != invoiceID {
		t.Fatalf("invoice searchRecords = %+v", invoiceOut.Records)
	}
	invoiceValues := invoiceOut.Records[0].Values
	if invoiceOut.Records[0].Label != "Invoice 7 | Ada Lovelace" {
		t.Fatalf("invoice label = %q", invoiceOut.Records[0].Label)
	}
	if invoiceOut.Records[0].Detail != "sent | $115.00" {
		t.Fatalf("invoice detail = %q", invoiceOut.Records[0].Detail)
	}
	if invoiceValues["invoice.total"] != "$115.00" || invoiceValues["invoice.balance"] != "$95.00" ||
		invoiceValues["invoice.subtotal"] != "$100.00" || invoiceValues["invoice.tax"] != "$15.00" {
		t.Fatalf("invoice money values = %+v", invoiceValues)
	}
	if invoiceValues["invoice.issuedAt"] != "2026-01-05" || invoiceValues["invoice.dueAt"] != "2026-02-04" {
		t.Fatalf("invoice dates = %+v", invoiceValues)
	}
	if invoiceValues["invoice.line1.description"] != "Consulting hours" ||
		invoiceValues["invoice.line1.quantity"] != "1.5" ||
		invoiceValues["invoice.line1.rate"] != "$66.67" ||
		invoiceValues["invoice.line1.amount"] != "$100.01" {
		t.Fatalf("invoice line 1 values = %+v", invoiceValues)
	}
	if invoiceValues["invoice.line2.amount"] != "$120.00" {
		t.Fatalf("invoice line 2 amount = %q", invoiceValues["invoice.line2.amount"])
	}
	if _, present := invoiceValues["invoice.line3.description"]; present {
		t.Fatal("searchRecords returned more lines than the three the module reads")
	}
}

type documentsMemoryRow struct {
	id      string
	content string
}

func documentsSeedMemory(t *testing.T, fx *executorFixture, orgID, kind, content string) documentsMemoryRow {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO memories (org_id, kind, content, metadata)
		VALUES ($1::uuid, $2, $3, '{}'::jsonb)
		RETURNING id::text`, orgID, kind, content).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return documentsMemoryRow{id: id, content: content}
}

func documentsSeedTemplate(t *testing.T, fx *executorFixture, orgID, name, isSystem, content string) string {
	t.Helper()
	var id string
	var system *string
	if isSystem != "" {
		system = &isSystem
	}
	placeholders, err := ExtractDocumentPlaceholders(json.RawMessage(content))
	if err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO doc_templates (org_id, name, is_system, content_json, placeholders)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id::text`, orgID, name, system, content, documentsPlaceholdersJSON(placeholders)).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedAccounts(t *testing.T, fx *executorFixture, orgID string) {
	t.Helper()
	for _, account := range []struct{ code, name, kind string }{
		{"1000", "Cash at bank", "asset"},
		{"4000", "Sales revenue", "income"},
		{"6000", "General expenses", "expense"},
		{"6100", "Office supplies", "expense"},
		{"6200", "Fuel and diesel", "expense"},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)
			ON CONFLICT (org_id, code) DO NOTHING`, orgID, account.code, account.name, account.kind); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM accounts WHERE org_id=$1::uuid`, orgID); err != nil {
			t.Errorf("clean up accounts: %v", err)
		}
	})
}
