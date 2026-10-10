package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMessageAttachmentDownloadHTTPUsesOrgScopedStorageAndGuardsVisibility(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for message attachment integration coverage")
		}
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed message attachment integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed message attachment integration fixtures")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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

	orgID, otherOrgID := integrationUUID(t), integrationUUID(t)
	userID, outsiderID := integrationUUID(t), integrationUUID(t)
	conversationID, outsiderConversationID, foreignConversationID := integrationUUID(t), integrationUUID(t), integrationUUID(t)
	messageID, deletedMessageID := integrationUUID(t), integrationUUID(t)
	visibleAttachmentID, pendingOwnedID := integrationUUID(t), integrationUUID(t)
	pendingForeignID, deletedAttachmentID, foreignOrgAttachmentID, mismatchedConversationAttachmentID := integrationUUID(t), integrationUUID(t), integrationUUID(t), integrationUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go attachment fixture', $2), ($3::uuid, 'Go attachment other fixture', $4)`,
		orgID, "go-attachment-"+orgID[:8], otherOrgID, "go-attachment-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete attachment fixture organizations: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id IN ($1::uuid, $2::uuid)`, userID, outsiderID); err != nil {
			t.Errorf("delete attachment fixture users: %v", err)
		}
	})
	for i, user := range []string{userID, outsiderID} {
		if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, $3)`, user,
			fmt.Sprintf("go-attachment-%s@fixture.test", user[:8]), fmt.Sprintf("Attachment user %d", i+1)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO conversations (id, org_id, title) VALUES
		($1::uuid, $2::uuid, 'attachment conversation'), ($3::uuid, $2::uuid, 'outsider conversation'),
		($4::uuid, $5::uuid, 'foreign org conversation')`, conversationID, orgID, outsiderConversationID, foreignConversationID, otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)`, conversationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)`, foreignConversationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO messages (id, org_id, conversation_id, sender_type, sender_user_id, body, deleted_at) VALUES
		($1::uuid, $2::uuid, $3::uuid, 'human', $4::uuid, 'visible attachment message', NULL),
		($5::uuid, $2::uuid, $3::uuid, 'human', $4::uuid, 'deleted attachment message', now())`,
		messageID, orgID, conversationID, userID, deletedMessageID); err != nil {
		t.Fatal(err)
	}
	content := []byte{0, 1, 2, 128, 255}
	for _, fixture := range []struct {
		id, org, conversation string
		message               *string
		uploader              string
		filename              string
	}{
		{visibleAttachmentID, orgID, conversationID, &messageID, userID, "visible.bin"},
		{pendingOwnedID, orgID, conversationID, nil, userID, "pending-owned.bin"},
		{pendingForeignID, orgID, conversationID, nil, outsiderID, "pending-foreign.bin"},
		{deletedAttachmentID, orgID, conversationID, &deletedMessageID, userID, "deleted.bin"},
		{foreignOrgAttachmentID, otherOrgID, foreignConversationID, &messageID, userID, "foreign-org.bin"},
		{mismatchedConversationAttachmentID, orgID, foreignConversationID, nil, userID, "mismatched-conversation.bin"},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO message_attachments (id, org_id, conversation_id, message_id, filename, mime_type, size_bytes, content, uploaded_by_user_id)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'application/octet-stream', $6, $7, $8::uuid)`,
			fixture.id, fixture.org, fixture.conversation, fixture.message, fixture.filename, len(content), content, fixture.uploader); err != nil {
			t.Fatal(err)
		}
	}

	identity := &session.ResolvedUser{UserID: userID, OrgID: &orgID, EmailVerified: true, AuthSessionID: "verified-session", Permissions: map[string]bool{"messaging.read": true}}
	handler := MountGoMessageAttachmentDownloadRoute(http.NotFoundHandler(), NewMessageAttachmentDownloadHandler(runtime, &fakeDirectSessionResolver{resolved: identity}, nil))
	request := func(id string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/message-attachments/"+id, nil)
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session"})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}
	response := request(visibleAttachmentID)
	if response.Code != http.StatusOK || string(response.Body.Bytes()) != string(content) {
		t.Fatalf("visible attachment response status=%d body=%v", response.Code, response.Body.Bytes())
	}
	if response.Header().Get("Content-Disposition") != "attachment; filename*=UTF-8''visible.bin" || response.Header().Get("Content-Length") != fmt.Sprint(len(content)) {
		t.Fatalf("visible attachment headers=%v", response.Header())
	}
	for _, id := range []string{pendingOwnedID} {
		response = request(id)
		if response.Code != http.StatusOK {
			t.Fatalf("expected visible attachment %s status 200, got %d: %s", id, response.Code, response.Body.String())
		}
	}
	for _, id := range []string{pendingForeignID, deletedAttachmentID, foreignOrgAttachmentID, mismatchedConversationAttachmentID} {
		response = request(id)
		if response.Code != http.StatusNotFound {
			t.Fatalf("hidden attachment %s status=%d, want privacy 404", id, response.Code)
		}
	}
}
