package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMessagingCollectionHandlerUsesRuntimeRLSAndGovernance(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for messaging collection integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for messaging collection integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}
	fixture := seedOrgParityFixture(t, owner, secret)
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		for _, orgID := range []string{fixture.orgA, fixture.orgB} {
			_, _ = owner.Exec(cleanupCtx, `DELETE FROM message_reactions WHERE org_id=$1::uuid`, orgID)
			_, _ = owner.Exec(cleanupCtx, `DELETE FROM message_attachments WHERE org_id=$1::uuid`, orgID)
			_, _ = owner.Exec(cleanupCtx, `DELETE FROM messages WHERE org_id=$1::uuid`, orgID)
			_, _ = owner.Exec(cleanupCtx, `DELETE FROM conversations WHERE org_id=$1::uuid`, orgID)
		}
	})

	messagingRole := seedRole(t, owner, fixture.orgA, "msg-collection-"+fixture.orgA, "messaging.read")
	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'messaging.write', $2::uuid)`, messagingRole, fixture.orgA); err != nil {
		t.Fatalf("grant messaging.write: %v", err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id, org_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)`, fixture.userID, messagingRole, fixture.orgA); err != nil {
		t.Fatalf("assign messaging role: %v", err)
	}

	var orgAConversation, orgBConversation, orgAMessage string
	if err := owner.QueryRow(ctx, `
		INSERT INTO conversations (org_id, kind, title, created_by_user_id)
		VALUES ($1::uuid, 'channel', 'Org A proof', $2::uuid) RETURNING id`,
		fixture.orgA, fixture.userID).Scan(&orgAConversation); err != nil {
		t.Fatalf("seed org A conversation: %v", err)
	}
	if err := owner.QueryRow(ctx, `
		INSERT INTO conversations (org_id, kind, title, created_by_user_id)
		VALUES ($1::uuid, 'channel', 'Org B secret', $2::uuid) RETURNING id`,
		fixture.orgB, fixture.userID).Scan(&orgBConversation); err != nil {
		t.Fatalf("seed org B conversation: %v", err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id)
		VALUES ($1::uuid, $2::uuid), ($3::uuid, $2::uuid)`,
		orgAConversation, fixture.userID, orgBConversation); err != nil {
		t.Fatalf("seed conversation members: %v", err)
	}
	if err := owner.QueryRow(ctx, `
		INSERT INTO messages (org_id, conversation_id, sender_type, sender_user_id, body)
		VALUES ($1::uuid, $2::uuid, 'human', $3::uuid, 'proof alpha message') RETURNING id`,
		fixture.orgA, orgAConversation, fixture.userID).Scan(&orgAMessage); err != nil {
		t.Fatalf("seed org A message: %v", err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO messages (org_id, conversation_id, sender_type, sender_user_id, body)
		VALUES ($1::uuid, $2::uuid, 'human', $3::uuid, 'secret beta message')`,
		fixture.orgB, orgBConversation, fixture.userID); err != nil {
		t.Fatalf("seed org B message: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := MountGoMessagingCollectionRoute(nil, NewMessagingCollectionHandler(resolver, capability.NewExecutor(runtime, "", "", ""), logger))

	request := func(method, target, body, cookie, activeOrg string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "https://app.example.test"+target, strings.NewReader(body))
		req.TLS = &tls.ConnectionState{}
		req.Host = "app.example.test"
		req.Header.Set("Origin", "https://app.example.test")
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
		}
		req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: activeOrg})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	decode := func(response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response %q: %v", response.Body.String(), err)
		}
		return body
	}

	list := request(http.MethodGet, "/api/conversations", "", fixture.cookie, fixture.orgA)
	listBody := decode(list)
	conversations, _ := listBody["conversations"].([]any)
	if list.Code != http.StatusOK || listBody["me"] != fixture.userID || list.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("list status=%d body=%v, want org A conversation list", list.Code, listBody)
	}
	foundOrgA, leakedOrgB := false, false
	for _, entry := range conversations {
		conversation, _ := entry.(map[string]any)
		if conversation["id"] == orgAConversation {
			foundOrgA = true
		}
		if conversation["id"] == orgBConversation {
			leakedOrgB = true
		}
	}
	if !foundOrgA || leakedOrgB {
		t.Fatalf("list foundOrgA=%t leakedOrgB=%t body=%s", foundOrgA, leakedOrgB, list.Body.String())
	}

	crossOrgThread := request(http.MethodGet, "/api/conversations/"+orgBConversation+"/messages", "", fixture.cookie, fixture.orgA)
	if crossOrgThread.Code != http.StatusNotFound || strings.Contains(crossOrgThread.Body.String(), "secret beta message") {
		t.Fatalf("cross-org thread status=%d body=%s, want isolated 404", crossOrgThread.Code, crossOrgThread.Body.String())
	}

	thread := request(http.MethodGet, "/api/conversations/"+orgAConversation+"/messages", "", fixture.cookie, fixture.orgA)
	threadBody := decode(thread)
	messages, _ := threadBody["messages"].([]any)
	if thread.Code != http.StatusOK || threadBody["me"] != fixture.userID || len(messages) != 1 {
		t.Fatalf("thread status=%d body=%v", thread.Code, threadBody)
	}
	if message, _ := messages[0].(map[string]any); message["body"] != "proof alpha message" {
		t.Fatalf("thread body=%s", thread.Body.String())
	}

	search := request(http.MethodGet, "/api/messages/search?q=proof", "", fixture.cookie, fixture.orgA)
	searchBody := decode(search)
	results, _ := searchBody["results"].([]any)
	if search.Code != http.StatusOK || len(results) != 1 {
		t.Fatalf("search status=%d body=%v, want the org A match", search.Code, searchBody)
	}
	hidden := request(http.MethodGet, "/api/messages/search?q=beta", "", fixture.cookie, fixture.orgA)
	hiddenBody := decode(hidden)
	if hiddenResults, _ := hiddenBody["results"].([]any); len(hiddenResults) != 0 {
		t.Fatalf("cross-org search leaked: %s", hidden.Body.String())
	}

	people := request(http.MethodGet, "/api/conversations/people", "", fixture.cookie, fixture.orgA)
	peopleBody := decode(people)
	peopleList, _ := peopleBody["people"].([]any)
	if people.Code != http.StatusOK || len(peopleList) == 0 {
		t.Fatalf("people status=%d body=%s", people.Code, people.Body.String())
	}

	send := request(http.MethodPost, "/api/conversations/"+orgAConversation+"/messages", `{"body":"runtime proof one"}`, fixture.cookie, fixture.orgA)
	sendBody := decode(send)
	var sentMessageID string
	if err := owner.QueryRow(ctx, `
		SELECT id::text FROM messages
		WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND body='runtime proof one'`,
		fixture.orgA, orgAConversation).Scan(&sentMessageID); err != nil {
		t.Fatalf("query sent message: %v", err)
	}
	if send.Code != http.StatusOK || sendBody["ok"] != true || sendBody["agentReply"] != nil {
		t.Fatalf("send status=%d body=%v", send.Code, sendBody)
	}
	var senderType string
	var senderUserID *string
	if err := owner.QueryRow(ctx, `SELECT sender_type, sender_user_id::text FROM messages WHERE id=$1::uuid`, sentMessageID).Scan(&senderType, &senderUserID); err != nil {
		t.Fatalf("query sender: %v", err)
	}
	if senderType != "human" || senderUserID == nil || *senderUserID != fixture.userID {
		t.Fatalf("sender type=%q user=%v", senderType, senderUserID)
	}

	idempotentIntent := "50000000-0000-4000-8000-000000000001"
	idempotentBody := `{"body":"runtime proof idempotent","intentId":"` + idempotentIntent + `"}`
	firstSend := request(http.MethodPost, "/api/conversations/"+orgAConversation+"/messages", idempotentBody, fixture.cookie, fixture.orgA)
	replayedSend := request(http.MethodPost, "/api/conversations/"+orgAConversation+"/messages", idempotentBody, fixture.cookie, fixture.orgA)
	var idempotentCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM messages WHERE org_id=$1::uuid AND body='runtime proof idempotent'`, fixture.orgA).Scan(&idempotentCount); err != nil {
		t.Fatal(err)
	}
	if firstSend.Code != http.StatusOK || replayedSend.Code != http.StatusOK || idempotentCount != 1 {
		t.Fatalf("idempotent send statuses=%d/%d rows=%d", firstSend.Code, replayedSend.Code, idempotentCount)
	}

	edit := request(http.MethodPatch, "/api/messages/"+sentMessageID, `{"body":"runtime proof one edited"}`, fixture.cookie, fixture.orgA)
	if edit.Code != http.StatusOK {
		t.Fatalf("edit status=%d body=%s", edit.Code, edit.Body.String())
	}
	var editedAt *time.Time
	if err := owner.QueryRow(ctx, `SELECT edited_at FROM messages WHERE id=$1::uuid`, sentMessageID).Scan(&editedAt); err != nil || editedAt == nil {
		t.Fatalf("edited_at=%v err=%v", editedAt, err)
	}

	editedSearch := request(http.MethodGet, "/api/messages/search?q=runtime%20proof%20one%20edited", "", fixture.cookie, fixture.orgA)
	editedSearchBody := decode(editedSearch)
	if editedResults, _ := editedSearchBody["results"].([]any); len(editedResults) != 1 {
		t.Fatalf("edited search body=%s", editedSearch.Body.String())
	}

	pin := request(http.MethodPatch, "/api/messages/"+sentMessageID+"/pin", `{"pinned":true}`, fixture.cookie, fixture.orgA)
	if pin.Code != http.StatusOK {
		t.Fatalf("pin status=%d body=%s", pin.Code, pin.Body.String())
	}
	var pinnedAt *time.Time
	if err := owner.QueryRow(ctx, `SELECT pinned_at FROM messages WHERE id=$1::uuid`, sentMessageID).Scan(&pinnedAt); err != nil || pinnedAt == nil {
		t.Fatalf("pinned_at=%v err=%v", pinnedAt, err)
	}

	reaction := request(http.MethodPost, "/api/messages/"+sentMessageID+"/reactions", `{"emoji":"🎉","active":true}`, fixture.cookie, fixture.orgA)
	if reaction.Code != http.StatusOK {
		t.Fatalf("reaction status=%d body=%s", reaction.Code, reaction.Body.String())
	}
	var reactionCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM message_reactions WHERE org_id=$1::uuid AND message_id=$2::uuid`, fixture.orgA, sentMessageID).Scan(&reactionCount); err != nil || reactionCount != 1 {
		t.Fatalf("reaction rows=%d err=%v", reactionCount, err)
	}

	readAt := "2026-10-17T09:00:00.000Z"
	read := request(http.MethodPost, "/api/conversations/"+orgAConversation+"/read", `{"readAt":"`+readAt+`"}`, fixture.cookie, fixture.orgA)
	if read.Code != http.StatusOK {
		t.Fatalf("read status=%d body=%s", read.Code, read.Body.String())
	}
	var lastReadAt *time.Time
	if err := owner.QueryRow(ctx, `SELECT last_read_at FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, orgAConversation, fixture.userID).Scan(&lastReadAt); err != nil || lastReadAt == nil {
		t.Fatalf("last_read_at=%v err=%v", lastReadAt, err)
	}
	if !lastReadAt.UTC().Equal(time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("last_read_at=%s, want the requested cursor", lastReadAt)
	}
	clearRead := request(http.MethodPost, "/api/conversations/"+orgAConversation+"/read", `{"readAt":null}`, fixture.cookie, fixture.orgA)
	if clearRead.Code != http.StatusOK {
		t.Fatalf("clear read status=%d body=%s", clearRead.Code, clearRead.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT last_read_at FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, orgAConversation, fixture.userID).Scan(&lastReadAt); err != nil || lastReadAt != nil {
		t.Fatalf("cleared last_read_at=%v err=%v", lastReadAt, err)
	}

	var uploadBuffer bytes.Buffer
	writer := multipart.NewWriter(&uploadBuffer)
	part, err := writer.CreateFormFile("file", "proof.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("proof attachment")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	uploadRequest := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/conversations/"+orgAConversation+"/attachments", &uploadBuffer)
	uploadRequest.TLS = &tls.ConnectionState{}
	uploadRequest.Host = "app.example.test"
	uploadRequest.Header.Set("Origin", "https://app.example.test")
	uploadRequest.Header.Set("Content-Type", writer.FormDataContentType())
	uploadRequest.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
	uploadRequest.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgA})
	upload := httptest.NewRecorder()
	handler.ServeHTTP(upload, uploadRequest)
	uploadBody := decode(upload)
	attachmentID, _ := uploadBody["attachmentId"].(string)
	if upload.Code != http.StatusOK || attachmentID == "" || uploadBody["sizeBytes"] != float64(16) {
		t.Fatalf("upload status=%d body=%v", upload.Code, uploadBody)
	}
	deleteUpload := request(http.MethodDelete, "/api/conversations/"+orgAConversation+"/attachments", `{"attachmentId":"`+attachmentID+`"}`, fixture.cookie, fixture.orgA)
	if deleteUpload.Code != http.StatusOK {
		t.Fatalf("delete attachment status=%d body=%s", deleteUpload.Code, deleteUpload.Body.String())
	}
	var attachmentCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM message_attachments WHERE org_id=$1::uuid AND id=$2::uuid`, fixture.orgA, attachmentID).Scan(&attachmentCount); err != nil || attachmentCount != 0 {
		t.Fatalf("attachment rows=%d err=%v", attachmentCount, err)
	}

	rename := request(http.MethodPatch, "/api/conversations/"+orgAConversation, `{"action":"update","title":"Org A renamed"}`, fixture.cookie, fixture.orgA)
	if rename.Code != http.StatusOK {
		t.Fatalf("rename status=%d body=%s", rename.Code, rename.Body.String())
	}
	var renamedTitle string
	if err := owner.QueryRow(ctx, `SELECT title FROM conversations WHERE id=$1::uuid`, orgAConversation).Scan(&renamedTitle); err != nil || renamedTitle != "Org A renamed" {
		t.Fatalf("title=%q err=%v", renamedTitle, err)
	}
	archive := request(http.MethodPatch, "/api/conversations/"+orgAConversation, `{"action":"archive"}`, fixture.cookie, fixture.orgA)
	if archive.Code != http.StatusOK {
		t.Fatalf("archive status=%d body=%s", archive.Code, archive.Body.String())
	}
	var archivedAt *time.Time
	if err := owner.QueryRow(ctx, `SELECT archived_at FROM conversations WHERE id=$1::uuid`, orgAConversation).Scan(&archivedAt); err != nil || archivedAt == nil {
		t.Fatalf("archived_at=%v err=%v", archivedAt, err)
	}

	deleteMessage := request(http.MethodDelete, "/api/messages/"+sentMessageID+"?intentId=runtime-delete-intent", "", fixture.cookie, fixture.orgA)
	if deleteMessage.Code != http.StatusOK {
		t.Fatalf("delete message status=%d body=%s", deleteMessage.Code, deleteMessage.Body.String())
	}
	var deletedAt *time.Time
	if err := owner.QueryRow(ctx, `SELECT deleted_at FROM messages WHERE id=$1::uuid`, sentMessageID).Scan(&deletedAt); err != nil || deletedAt == nil {
		t.Fatalf("deleted_at=%v err=%v", deletedAt, err)
	}
	afterDeleteSearch := request(http.MethodGet, "/api/messages/search?q=runtime%20proof%20one%20edited", "", fixture.cookie, fixture.orgA)
	afterDeleteBody := decode(afterDeleteSearch)
	if afterDeleteResults, _ := afterDeleteBody["results"].([]any); len(afterDeleteResults) != 0 {
		t.Fatalf("deleted message still searchable: %s", afterDeleteSearch.Body.String())
	}

	missingConversation := request(http.MethodPatch, "/api/conversations/99999999-9999-4999-8999-999999999999", `{"action":"leave"}`, fixture.cookie, fixture.orgA)
	if missingConversation.Code != http.StatusNotFound {
		t.Fatalf("missing conversation status=%d body=%s, want 404", missingConversation.Code, missingConversation.Body.String())
	}

	unknownField := request(http.MethodPost, "/api/conversations", `{"title":"Runtime","bogus":true}`, fixture.cookie, fixture.orgA)
	if unknownField.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d body=%s, want 400", unknownField.Code, unknownField.Body.String())
	}

	anonymous := request(http.MethodGet, "/api/conversations", "", "", fixture.orgA)
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d body=%s, want 401", anonymous.Code, anonymous.Body.String())
	}

	crossOriginRequest := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/conversations", strings.NewReader(`{"title":"Cross origin"}`))
	crossOriginRequest.TLS = &tls.ConnectionState{}
	crossOriginRequest.Host = "app.example.test"
	crossOriginRequest.Header.Set("Origin", "https://attacker.example")
	crossOriginRequest.Header.Set("Content-Type", "application/json")
	crossOriginRequest.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
	crossOriginRequest.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgA})
	crossOrigin := httptest.NewRecorder()
	handler.ServeHTTP(crossOrigin, crossOriginRequest)
	if crossOrigin.Code != http.StatusForbidden {
		t.Fatalf("cross origin status=%d body=%s, want 403", crossOrigin.Code, crossOrigin.Body.String())
	}

	restrictedOrg := request(http.MethodGet, "/api/conversations", "", fixture.cookie, fixture.orgB)
	if restrictedOrg.Code != http.StatusForbidden {
		t.Fatalf("org B status=%d body=%s, want 403 without messaging permissions", restrictedOrg.Code, restrictedOrg.Body.String())
	}
}
