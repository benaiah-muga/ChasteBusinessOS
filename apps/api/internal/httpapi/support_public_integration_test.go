package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoPublicSupportWidgetContractUsesOrgRLSAndVisitorSecret(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed public support fixtures")
		}
		t.Skip("DATABASE_URL is required to seed public support fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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

	orgID, foreignOrgID := readContractUUID(t), readContractUUID(t)
	token, foreignToken := "go-widget-"+readContractUUID(t), "go-widget-"+readContractUUID(t)
	visitorEmail := "victim@widget.test"
	_, err = owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Go widget fixture', $2), ($3::uuid, 'Go foreign widget fixture', $4)`, orgID, "go-widget-"+orgID[:8], foreignOrgID, "go-widget-other-"+foreignOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO customers (org_id, name, email) VALUES ($1::uuid, 'Existing customer', $2)`, orgID, visitorEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO support_settings (org_id, embed_token, auto_reply_enabled, greeting)
		VALUES ($1::uuid, $2, false, 'Welcome to the Go widget.'), ($3::uuid, $4, false, 'Foreign greeting.')`, orgID, token, foreignOrgID, foreignToken); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_verification WHERE identifier LIKE $1 AND value = ANY($2::text[])`, publicSupportRatePrefix+"%", []string{orgID, foreignOrgID}); err != nil {
			t.Errorf("remove public support rate fixtures: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, foreignOrgID); err != nil {
			t.Errorf("remove public support fixtures: %v", err)
		}
	})

	handler, err := NewSupportPublicHandler(runtime, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := MountSupportPublicRoute(http.NotFoundHandler(), handler)
	request := func(method, rawURL, body, remoteAddr, forwarded string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, rawURL, strings.NewReader(body))
		req.RemoteAddr = remoteAddr
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if forwarded != "" {
			req.Header.Set("X-Forwarded-For", forwarded)
		}
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, req)
		return recorder
	}
	post := func(body any, remoteAddr string) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return request(http.MethodPost, "/api/support/public", string(encoded), remoteAddr, "")
	}
	decode := func(recorder *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var value map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
			t.Fatalf("decode response body %q: %v", recorder.Body.String(), err)
		}
		return value
	}
	oversizedBody := fmt.Sprintf(`{"action":"start","token":%q,"email":"large-body@widget.test","unknown":"%s"}`, token, strings.Repeat("x", publicSupportBodyLimit+1))
	oversized := request(http.MethodPost, "/api/support/public", oversizedBody, "198.51.100.30:4310", "")
	if oversized.Code != http.StatusBadRequest {
		t.Fatalf("oversized public support body status=%d, want 400", oversized.Code)
	}

	started := post(map[string]any{"action": "start", "token": token, "email": visitorEmail, "name": "Untrusted visitor name"}, "198.51.100.31:4310")
	if started.Code != http.StatusOK {
		t.Fatalf("start status=%d body=%s", started.Code, started.Body.String())
	}
	startBody := decode(started)
	conversationID, _ := startBody["conversationId"].(string)
	secret, _ := startBody["secret"].(string)
	if conversationID == "" || len(secret) != 48 {
		t.Fatalf("start response=%v, want conversation id and one-time secret", startBody)
	}
	var storedHash string
	var customerID *string
	if err := owner.QueryRow(ctx, `SELECT visitor_secret_hash, customer_id::text FROM support_conversations WHERE id = $1::uuid AND org_id = $2::uuid`, conversationID, orgID).Scan(&storedHash, &customerID); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(secret))
	if storedHash != hex.EncodeToString(hash[:]) || customerID != nil {
		t.Fatalf("stored visitor identity hash=%q customerID=%v, expected hashed secret and unbound customer", storedHash, customerID)
	}
	if got := started.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("start cache policy=%q, want no-store", got)
	}

	postPoll := post(map[string]any{"action": "poll", "token": token, "conversationId": conversationID, "secret": secret}, "198.51.100.31:4310")
	if postPoll.Code != http.StatusOK {
		t.Fatalf("POST poll status=%d body=%s", postPoll.Code, postPoll.Body.String())
	}
	pollBody := decode(postPoll)
	if pollBody["status"] != "open" {
		t.Fatalf("POST poll response=%v, want open", pollBody)
	}
	messages, ok := pollBody["messages"].([]any)
	if !ok || len(messages) != 1 || messages[0].(map[string]any)["body"] != "Welcome to the Go widget." {
		t.Fatalf("POST poll messages=%v, want scoped greeting", pollBody["messages"])
	}
	legacyGet := request(http.MethodGet, "/api/support/public?token="+token+"&conversationId="+conversationID+"&secret="+secret, "", "198.51.100.31:4310", "")
	if legacyGet.Code != http.StatusMethodNotAllowed || legacyGet.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET poll status=%d allow=%q body=%s, want POST only", legacyGet.Code, legacyGet.Header().Get("Allow"), legacyGet.Body.String())
	}

	foreignStart := post(map[string]any{"action": "start", "token": foreignToken, "email": "other@widget.test"}, "198.51.100.32:4310")
	foreignBody := decode(foreignStart)
	missingThread := post(map[string]any{"action": "poll", "token": token, "conversationId": foreignBody["conversationId"], "secret": foreignBody["secret"]}, "198.51.100.31:4310")
	wrongSecret := post(map[string]any{"action": "poll", "token": token, "conversationId": conversationID, "secret": strings.Repeat("0", 48)}, "198.51.100.31:4310")
	unknownWidget := post(map[string]any{"action": "poll", "token": "missing-widget-token-0000", "conversationId": conversationID, "secret": secret}, "198.51.100.31:4310")
	if missingThread.Code != http.StatusNotFound || wrongSecret.Code != http.StatusNotFound || unknownWidget.Code != http.StatusNotFound ||
		missingThread.Body.String() != wrongSecret.Body.String() || wrongSecret.Body.String() != unknownWidget.Body.String() {
		t.Fatalf("not-found responses differ: foreign=%d %q wrong-secret=%d %q unknown-token=%d %q", missingThread.Code, missingThread.Body.String(), wrongSecret.Code, wrongSecret.Body.String(), unknownWidget.Code, unknownWidget.Body.String())
	}

	message := post(map[string]any{"action": "message", "token": token, "conversationId": conversationID, "secret": secret, "body": "hello from the visitor"}, "198.51.100.31:4310")
	messageBody := decode(message)
	if message.Code != http.StatusOK || messageBody["ok"] != true || messageBody["replied"] != false {
		t.Fatalf("message status=%d response=%v", message.Code, messageBody)
	}
	incrementalPoll := post(map[string]any{"action": "poll", "token": token, "conversationId": conversationID, "secret": secret, "after": "2000-01-01T00:00:00Z"}, "198.51.100.31:4310")
	incrementalBody := decode(incrementalPoll)
	incrementalMessages, ok := incrementalBody["messages"].([]any)
	if incrementalPoll.Code != http.StatusOK || !ok || len(incrementalMessages) != 2 {
		t.Fatalf("incremental poll status=%d response=%v", incrementalPoll.Code, incrementalBody)
	}
	human := post(map[string]any{"action": "human", "token": token, "conversationId": conversationID, "secret": secret}, "198.51.100.31:4310")
	if human.Code != http.StatusOK || decode(human)["status"] != "escalated" {
		t.Fatalf("human status=%d body=%s", human.Code, human.Body.String())
	}
	var status string
	if err := owner.QueryRow(ctx, `SELECT status FROM support_conversations WHERE id = $1::uuid AND org_id = $2::uuid`, conversationID, orgID).Scan(&status); err != nil || status != "escalated" {
		t.Fatalf("stored conversation status=%q err=%v", status, err)
	}
	if _, err := owner.Exec(ctx, `UPDATE support_conversations SET status = 'resolved' WHERE id = $1::uuid AND org_id = $2::uuid`, conversationID, orgID); err != nil {
		t.Fatal(err)
	}
	closed := post(map[string]any{"action": "message", "token": token, "conversationId": conversationID, "secret": secret, "body": "too late"}, "198.51.100.31:4310")
	if closed.Code != http.StatusConflict {
		t.Fatalf("resolved conversation message status=%d, want 409", closed.Code)
	}

	// The trusted peer, not spoofed forwarded values, owns one shared POST
	// quota across start, message, and human actions, including API instances.
	ratePeer := "198.51.100.31:4310"
	writeRequestsBeforeQuota := 4 // start, message, human, and closed-thread message above
	for i := 0; i < publicSupportWriteLimit-writeRequestsBeforeQuota; i++ {
		recorder := request(http.MethodPost, "/api/support/public", fmt.Sprintf(`{"action":"start","token":%q,"email":"visitor-%d@widget.test"}`, token, i), ratePeer, fmt.Sprintf("203.0.113.%d", i+1))
		if recorder.Code != http.StatusOK {
			t.Fatalf("rate-limited start %d status=%d body=%s", i, recorder.Code, recorder.Body.String())
		}
	}
	secondHandler, err := NewSupportPublicHandler(runtime, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	secondServer := MountSupportPublicRoute(http.NotFoundHandler(), secondHandler)
	lastRequest := httptest.NewRequest(http.MethodPost, "/api/support/public", strings.NewReader(fmt.Sprintf(`{"action":"start","token":%q,"email":"last@widget.test"}`, token)))
	lastRequest.RemoteAddr = ratePeer
	lastRequest.Header.Set("X-Forwarded-For", "203.0.113.250")
	lastResponse := httptest.NewRecorder()
	secondServer.ServeHTTP(lastResponse, lastRequest)
	if lastResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("shared public support quota status=%d, want 429", lastResponse.Code)
	}
}
