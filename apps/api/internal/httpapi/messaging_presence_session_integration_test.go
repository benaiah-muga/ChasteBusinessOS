package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
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

func TestMessagingPresenceHTTPUsesOrgScopedMembershipAndEphemeralState(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for messaging presence integration coverage")
		}
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed messaging presence fixtures")
		}
		t.Skip("DATABASE_URL is required to seed messaging presence fixtures")
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

	orgID, foreignOrgID := integrationUUID(t), integrationUUID(t)
	userID, otherUserID, outsiderID := integrationUUID(t), integrationUUID(t), integrationUUID(t)
	conversationID, foreignConversationID := integrationUUID(t), integrationUUID(t)
	roleID := integrationUUID(t)
	authUserID, authSessionID := "go-presence-auth-"+integrationUUID(t), "go-presence-session-"+integrationUUID(t)
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id,name,slug) VALUES ($1::uuid,'Go messaging presence fixture',$2),($3::uuid,'Go messaging presence foreign fixture',$4)`, orgID, "go-presence-"+orgID[:8], foreignOrgID, "go-presence-other-"+foreignOrgID[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin presence fixture cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance','on',true)`); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("enable presence fixture ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM ledger_events WHERE org_id IN ($1::uuid,$2::uuid)`, orgID, foreignOrgID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete presence fixture ledger events: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid,$2::uuid)`, orgID, foreignOrgID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete presence fixture organizations: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM users WHERE id IN ($1::uuid,$2::uuid,$3::uuid)`, userID, otherUserID, outsiderID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete presence fixture users: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id=$1`, authUserID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete presence fixture auth user: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit presence fixture cleanup: %v", err)
		}
	})
	for i, id := range []string{userID, otherUserID, outsiderID} {
		if _, err := owner.Exec(ctx, `INSERT INTO users (id,email,name) VALUES ($1::uuid,$2,$3)`, id, fmt.Sprintf("go-presence-%d-%s@fixture.test", i, id[:8]), fmt.Sprintf("Presence user %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id,user_id) VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid),($1::uuid,$4::uuid)`, orgID, userID, otherUserID, outsiderID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Presence actor',$2,true)`, authUserID, fmt.Sprintf("go-presence-0-%s@fixture.test", userID[:8])); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO auth_session (id,expires_at,token,user_id) VALUES ($1,$2,$3,$4)`, authSessionID, time.Now().Add(time.Hour), "go-presence-token-"+integrationUUID(t), authUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id,org_id,key,name,is_system) VALUES ($1::uuid,$2::uuid,'presence_fixture','Presence fixture',true)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id,permission_key,org_id) VALUES ($1::uuid,'messaging.write',$2::uuid)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id,role_id,org_id) VALUES ($1::uuid,$2::uuid,$3::uuid)`, userID, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO conversations (id,org_id,title) VALUES ($1::uuid,$2::uuid,'presence conversation'),($3::uuid,$4::uuid,'foreign conversation')`, conversationID, orgID, foreignConversationID, foreignOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid),($1::uuid,$4::uuid),($5::uuid,$2::uuid)`, conversationID, userID, otherUserID, outsiderID, foreignConversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO conversation_presence (org_id,conversation_id,user_id,last_seen_at,typing_until) VALUES
		($1::uuid,$2::uuid,$3::uuid,now(),now()+interval '5 seconds'),
		($1::uuid,$2::uuid,$4::uuid,now()-interval '1 minute',NULL),
		($1::uuid,$2::uuid,$5::uuid,now(),NULL)`, orgID, conversationID, otherUserID, outsiderID, userID); err != nil {
		t.Fatal(err)
	}

	identity := &session.ResolvedUser{UserID: userID, OrgID: &orgID, EmailVerified: true, AuthSessionID: authSessionID, Permissions: map[string]bool{"messaging.read": true, "messaging.write": true}}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := capability.NewExecutor(runtime, "", "", "")
	handler := MountGoMessagingPresenceRoute(http.NotFoundHandler(), NewMessagingPresenceHandler(runtime, resolver, executor, nil))
	request := func(method, id, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/api/conversations/"+id+"/presence", strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		r.Header.Set("Origin", "https://app.example.test")
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session"})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}

	response := request(http.MethodGet, conversationID, "")
	if response.Code != http.StatusOK {
		t.Fatalf("presence read status=%d body=%s", response.Code, response.Body.String())
	}
	var listed messagingPresenceResponse
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.People) != 1 || listed.People[0].UserID != otherUserID || !listed.People[0].Typing || listed.People[0].Name != "Presence user 1" {
		t.Fatalf("presence list=%+v", listed)
	}
	response = request(http.MethodGet, foreignConversationID, "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign conversation status=%d body=%s", response.Code, response.Body.String())
	}

	response = request(http.MethodPost, conversationID, `{"typing":true,"intentId":"test-intent"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("typing update status=%d body=%s", response.Code, response.Body.String())
	}
	var receiptCapability string
	var receiptOK bool
	var receiptData string
	if err := owner.QueryRow(ctx, `SELECT capability_id,ok,data::text FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":test-intent").Scan(&receiptCapability, &receiptOK, &receiptData); err != nil {
		t.Fatalf("governed presence action receipt missing: %v", err)
	}
	if receiptCapability != messagingPresenceCapabilityID || !receiptOK {
		t.Fatalf("presence receipt capability=%q ok=%t", receiptCapability, receiptOK)
	}
	var receiptOutput capability.MessagingConversationPresenceOutput
	if err := json.Unmarshal([]byte(receiptData), &receiptOutput); err != nil {
		t.Fatalf("decode presence receipt inverse data %q: %v", receiptData, err)
	}
	if receiptOutput.PreviousLastSeenAt == nil || receiptOutput.PreviousTypingUntil != nil {
		t.Fatalf("presence receipt should retain the prior seen timestamp and null typing state: %+v", receiptOutput)
	}
	var typingUntil *time.Time
	if err := owner.QueryRow(ctx, `SELECT typing_until FROM conversation_presence WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND user_id=$3::uuid`, orgID, conversationID, userID).Scan(&typingUntil); err != nil || typingUntil == nil || !typingUntil.After(time.Now()) {
		t.Fatalf("typing_until=%v err=%v", typingUntil, err)
	}
	response = request(http.MethodPost, conversationID, `{"typing":false,"intentId":"presence-stop-1"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("stop typing status=%d body=%s", response.Code, response.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT typing_until FROM conversation_presence WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND user_id=$3::uuid`, orgID, conversationID, userID).Scan(&typingUntil); err != nil || typingUntil != nil {
		t.Fatalf("typing_until after stop=%v err=%v", typingUntil, err)
	}
	var ownRows, colleagueRows int
	if err := owner.QueryRow(ctx, `SELECT count(*) FILTER (WHERE user_id=$3::uuid), count(*) FILTER (WHERE user_id=$4::uuid) FROM conversation_presence WHERE org_id=$1::uuid AND conversation_id=$2::uuid`, orgID, conversationID, userID, otherUserID).Scan(&ownRows, &colleagueRows); err != nil {
		t.Fatal(err)
	}
	if ownRows != 1 || colleagueRows != 1 {
		t.Fatalf("presence after typing stop own=%d colleague=%d", ownRows, colleagueRows)
	}
	var priorSeen time.Time
	if err := owner.QueryRow(ctx, `SELECT last_seen_at FROM conversation_presence WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND user_id=$3::uuid`, orgID, conversationID, userID).Scan(&priorSeen); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm"]'::jsonb WHERE id=$1::uuid`, orgID); err != nil {
		t.Fatal(err)
	}
	response = request(http.MethodGet, conversationID, "")
	if response.Code != http.StatusOK {
		t.Fatalf("presence read with Messaging disabled status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodPost, conversationID, `{"typing":true,"intentId":"presence-disabled-1"}`)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "disabled for this organization") {
		t.Fatalf("presence update with Messaging disabled status=%d body=%s", response.Code, response.Body.String())
	}
	var afterSeen time.Time
	if err := owner.QueryRow(ctx, `SELECT last_seen_at FROM conversation_presence WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND user_id=$3::uuid`, orgID, conversationID, userID).Scan(&afterSeen); err != nil {
		t.Fatal(err)
	}
	if !afterSeen.Equal(priorSeen) {
		t.Fatalf("disabled Messaging POST changed last_seen_at from %s to %s", priorSeen, afterSeen)
	}
}
