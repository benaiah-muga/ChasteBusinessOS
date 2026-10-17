package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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

func TestSupportAdminIntegrationServesTheInboxThroughCapabilities(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the Support admin integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the Support admin integration proof")
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
	keySuffix := strings.ReplaceAll(readContractUUID(t), "-", "")[:12]

	grantRole := func(orgID, permission string) {
		t.Helper()
		roleID := seedRole(t, owner, orgID, "support-"+permission+"-"+keySuffix, permission)
		if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
			fixture.userID, roleID, orgID); err != nil {
			t.Fatal(err)
		}
	}
	grantRole(fixture.orgA, "support.read")
	grantRole(fixture.orgA, "support.write")

	var customerID, conversationID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Ada Lovelace') RETURNING id::text`,
		fixture.orgA).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO support_conversations (org_id, customer_id, subject, status, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, 'Printer smokes', 'open', 'human', $3::uuid) RETURNING id::text`,
		fixture.orgA, customerID, fixture.userID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO support_messages (org_id, conversation_id, sender_type, body)
		VALUES ($1::uuid, $2::uuid, 'customer', 'It smokes when printing')`, fixture.orgA, conversationID); err != nil {
		t.Fatal(err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := NewSupportAdminHandler(runtime, resolver, capability.NewExecutor(runtime, "", "", ""), logger)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, target, body, organizationID, cookie string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "https://app.example.test"+target, strings.NewReader(body))
		req.TLS = &tls.ConnectionState{}
		req.Host = "app.example.test"
		req.Header.Set("Origin", "https://app.example.test")
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
		}
		req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
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

	unauthenticated := request(http.MethodGet, "/api/support", "", fixture.orgA, "")
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	moduleDisabled := request(http.MethodGet, "/api/support", "", fixture.orgB, fixture.cookie)
	if moduleDisabled.Code != http.StatusNotFound {
		t.Fatalf("module disabled org status=%d body=%s", moduleDisabled.Code, moduleDisabled.Body.String())
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["support"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatal(err)
	}
	grantRole(fixture.orgB, "support.read")

	list := request(http.MethodGet, "/api/support", "", fixture.orgA, fixture.cookie)
	listBody := decode(list)
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	conversations, _ := listBody["conversations"].([]any)
	if len(conversations) != 1 {
		t.Fatalf("org A conversations=%v body=%s", listBody["conversations"], list.Body.String())
	}
	first, _ := conversations[0].(map[string]any)
	if first["id"] != conversationID || first["subject"] != "Printer smokes" {
		t.Fatalf("conversation=%v", first)
	}
	if _, leaked := first["customerEmail"]; leaked {
		t.Fatalf("list leaked customerEmail: %s", list.Body.String())
	}

	detail := request(http.MethodGet, "/api/support?id="+conversationID, "", fixture.orgA, fixture.cookie)
	detailBody := decode(detail)
	if detail.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", detail.Code, detail.Body.String())
	}
	conversation, _ := detailBody["conversation"].(map[string]any)
	messages, _ := detailBody["messages"].([]any)
	if conversation["customerId"] != customerID || len(messages) != 1 {
		t.Fatalf("detail conversation=%v messages=%v", conversation, messages)
	}
	if _, leaked := conversation["customerEmail"]; leaked {
		t.Fatalf("detail leaked customerEmail: %s", detail.Body.String())
	}
	firstMessage, _ := messages[0].(map[string]any)
	if firstMessage["senderType"] != "customer" || firstMessage["body"] != "It smokes when printing" {
		t.Fatalf("message=%v", firstMessage)
	}

	library := request(http.MethodGet, "/api/support?library=1", "", fixture.orgA, fixture.cookie)
	libraryBody := decode(library)
	if library.Code != http.StatusOK {
		t.Fatalf("library status=%d body=%s", library.Code, library.Body.String())
	}
	if _, ok := libraryBody["canned"].([]any); !ok {
		t.Fatalf("library body=%s", library.Body.String())
	}

	isolated := request(http.MethodGet, "/api/support", "", fixture.orgB, fixture.cookie)
	isolatedBody := decode(isolated)
	if isolated.Code != http.StatusOK || len(isolatedBody["conversations"].([]any)) != 0 {
		t.Fatalf("cross-org list status=%d body=%s", isolated.Code, isolated.Body.String())
	}
	crossOrgDetail := request(http.MethodGet, "/api/support?id="+conversationID, "", fixture.orgB, fixture.cookie)
	if crossOrgDetail.Code != http.StatusNotFound {
		t.Fatalf("cross-org detail status=%d body=%s", crossOrgDetail.Code, crossOrgDetail.Body.String())
	}
	missingWrite := request(http.MethodPost, "/api/support", `{"action":"create","customerId":"`+customerID+`","subject":"No grant"}`,
		fixture.orgB, fixture.cookie)
	if missingWrite.Code != http.StatusForbidden {
		t.Fatalf("org B write status=%d body=%s", missingWrite.Code, missingWrite.Body.String())
	}

	create := request(http.MethodPost, "/api/support",
		`{"action":"create","customerId":"`+customerID+`","subject":"Warranty claim","intentId":"`+readContractUUID(t)+`"}`,
		fixture.orgA, fixture.cookie)
	createBody := decode(create)
	if create.Code != http.StatusOK || createBody["ok"] != true {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	created, _ := createBody["data"].(map[string]any)
	createdID, _ := created["conversationId"].(string)
	if createdID == "" {
		t.Fatalf("create data=%v", createBody["data"])
	}

	send := request(http.MethodPost, "/api/support",
		`{"action":"send","conversationId":"`+createdID+`","body":"On it today","from":"customer"}`,
		fixture.orgA, fixture.cookie)
	if send.Code != http.StatusOK {
		t.Fatalf("send status=%d body=%s", send.Code, send.Body.String())
	}
	var senderType, senderUserID string
	if err := owner.QueryRow(ctx, `SELECT sender_type, sender_user_id::text FROM support_messages
		WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND body='On it today'`, fixture.orgA, createdID).Scan(&senderType, &senderUserID); err != nil {
		t.Fatal(err)
	}
	if senderType != "staff" || senderUserID != fixture.userID {
		t.Fatalf("send persisted senderType=%q senderUserID=%q, want staff provenance", senderType, senderUserID)
	}

	resolved := request(http.MethodPost, "/api/support",
		`{"action":"resolve","conversationId":"`+createdID+`"}`, fixture.orgA, fixture.cookie)
	if resolved.Code != http.StatusOK {
		t.Fatalf("resolve status=%d body=%s", resolved.Code, resolved.Body.String())
	}
	var savedStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM support_conversations WHERE id=$1::uuid`, createdID).Scan(&savedStatus); err != nil {
		t.Fatal(err)
	}
	if savedStatus != "resolved" {
		t.Fatalf("conversation status=%q, want resolved", savedStatus)
	}
}
