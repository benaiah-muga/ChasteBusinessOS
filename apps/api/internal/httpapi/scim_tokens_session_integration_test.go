package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
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

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

type scimTokenFixtureResolver struct {
	identity *session.ResolvedUser
	orgs     map[string]bool
}

func (r *scimTokenFixtureResolver) Resolve(_ context.Context, _, activeOrg string) (*session.ResolvedUser, error) {
	return r.resolve(activeOrg)
}

func (r *scimTokenFixtureResolver) ResolveBearerToken(_ context.Context, _, activeOrg string) (*session.ResolvedUser, error) {
	return r.resolve(activeOrg)
}

func (r *scimTokenFixtureResolver) resolve(activeOrg string) (*session.ResolvedUser, error) {
	if !r.orgs[activeOrg] {
		return nil, errors.New("fixture user is not a member of requested organization")
	}
	resolved := *r.identity
	resolvedOrg := activeOrg
	resolved.OrgID = &resolvedOrg
	return &resolved, nil
}

func TestGoSCIMTokenManagementRouteHashesAndScopesTokens(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed SCIM token fixtures")
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
		t.Fatalf("verify runtime role: %v", err)
	}

	orgID, otherOrgID, userID, roleID := readContractUUID(t), readContractUUID(t), readContractUUID(t), readContractUUID(t)
	authUserID := "go-scim-token-user-" + orgID[:8]
	authSessionID := "go-scim-token-session-" + orgID[:8]
	slug := "go-scim-token-" + orgID[:8]
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin SCIM token fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable SCIM token fixture ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM scim_tokens WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SCIM token fixture tokens: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM ledger_events WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SCIM token fixture ledger events: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SCIM token fixture organizations: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit SCIM token fixture cleanup: %v", err)
			return
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, userID); err != nil {
			t.Errorf("delete SCIM token fixture user: %v", err)
			return
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE id = $1`, authSessionID); err != nil {
			t.Errorf("delete SCIM token fixture auth session: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, authUserID); err != nil {
			t.Errorf("delete SCIM token fixture auth user: %v", err)
		}
	})
	_, err = owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go SCIM token fixture', $2), ($3::uuid, 'Go SCIM token other fixture', $4)`,
		orgID, slug, otherOrgID, slug+"-other")
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'SCIM token admin', $2, true)`, authUserID, "scim-admin-"+orgID[:8]+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO auth_session (id, expires_at, token, user_id) VALUES ($1, $2, $3, $4)`, authSessionID, time.Now().Add(time.Hour), "token-"+orgID[:8], authUserID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'SCIM token admin')`, userID, "scim-admin-"+orgID[:8]+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid), ($3::uuid, $2::uuid)`, orgID, userID, otherOrgID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'scim_fixture_admin', 'SCIM fixture admin', true)`, roleID, orgID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'iam.admin', $2::uuid)`, roleID, orgID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, userID, roleID, orgID)
	if err != nil {
		t.Fatal(err)
	}
	permissions := map[string]bool{"iam.admin": true}
	identity := &session.ResolvedUser{
		UserID: userID, OrgID: &orgID, Permissions: permissions, EmailVerified: true,
		AuthSessionID: authSessionID,
	}
	resolver := &scimTokenFixtureResolver{identity: identity, orgs: map[string]bool{orgID: true, otherOrgID: true}}
	executor := capability.NewExecutor(runtime, "", "", "")
	route := NewSCIMTokenSessionHandler(runtime, resolver, executor, nil, nil)
	handler := MountGoSCIMTokenManagementRoute(http.NotFoundHandler(), route)
	request := func(method, target, body, activeOrg string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req.TLS = &tls.ConnectionState{}
		req.Host = "app.example.test"
		req.Header.Set("Origin", "https://app.example.test")
		req.Header.Set("Content-Type", "application/json")
		switch method {
		case http.MethodPost:
			req.Header.Set("Idempotency-Key", "66666666-6666-4666-8666-666666666666")
		case http.MethodDelete:
			req.Header.Set("Idempotency-Key", "77777777-7777-4777-8777-777777777777")
		}
		req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session"})
		req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: activeOrg})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}

	response := request(http.MethodGet, "/api/scim/tokens", "", orgID)
	if response.Code != http.StatusOK || response.Body.String() != "{\"tokens\":[]}\n" {
		t.Fatalf("empty list status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodPost, "/api/scim/tokens", `{"label":"Integration IdP","expiresInDays":1}`, orgID)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var created struct {
		Token     string    `json:"token"`
		ID        string    `json:"id"`
		Label     string    `json:"label"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Token, "scim_") || created.Label != "Integration IdP" || created.ExpiresAt.IsZero() {
		t.Fatalf("unexpected creation response: %+v", created)
	}
	digest := sha256.Sum256([]byte(created.Token))
	wantHash := hex.EncodeToString(digest[:])
	var storedHash string
	if err := owner.QueryRow(ctx, `SELECT token_hash FROM scim_tokens WHERE id = $1::uuid AND org_id = $2::uuid`, created.ID, orgID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != wantHash || storedHash == created.Token {
		t.Fatalf("stored hash=%q does not match raw token hash", storedHash)
	}
	var tokenActorID string
	if err := owner.QueryRow(ctx, `
		SELECT actor_id::text FROM ledger_events
		WHERE org_id = $1::uuid AND capability_id = $2
		ORDER BY seq DESC LIMIT 1`, orgID, capability.SCIMTokenCreateCapabilityID).Scan(&tokenActorID); err != nil {
		t.Fatal(err)
	}
	if tokenActorID != userID {
		t.Fatalf("SCIM token capability actor=%s, want initiating user %s", tokenActorID, userID)
	}
	memberIdentity := *identity
	memberIdentity.Permissions = map[string]bool{}
	memberRoute := NewSCIMTokenSessionHandler(runtime, &scimTokenFixtureResolver{
		identity: &memberIdentity, orgs: map[string]bool{orgID: true},
	}, executor, nil, nil)
	memberHandler := MountGoSCIMTokenManagementRoute(http.NotFoundHandler(), memberRoute)
	memberRequest := httptest.NewRequest(http.MethodGet, "/api/scim/tokens", nil)
	memberRequest.TLS = &tls.ConnectionState{}
	memberRequest.Host = "app.example.test"
	memberRequest.Header.Set("Origin", "https://app.example.test")
	memberRequest.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session"})
	memberRequest.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
	memberResponse := httptest.NewRecorder()
	memberHandler.ServeHTTP(memberResponse, memberRequest)
	if memberResponse.Code != http.StatusOK || !strings.Contains(memberResponse.Body.String(), created.ID) {
		t.Fatalf("non-admin member token list status=%d body=%s", memberResponse.Code, memberResponse.Body.String())
	}
	response = request(http.MethodPost, "/api/scim/tokens", `{"label":"Integration IdP","expiresInDays":1}`, orgID)
	if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), created.Token) || strings.Contains(response.Body.String(), `"token"`) {
		t.Fatalf("same idempotency key retry status=%d body=%s", response.Code, response.Body.String())
	}
	var tokenCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM scim_tokens WHERE org_id = $1::uuid`, orgID).Scan(&tokenCount); err != nil {
		t.Fatal(err)
	}
	if tokenCount != 1 {
		t.Fatalf("same idempotency key retry minted %d tokens, want one", tokenCount)
	}
	response = request(http.MethodGet, "/api/scim/tokens", "", otherOrgID)
	if response.Code != http.StatusOK || response.Body.String() != "{\"tokens\":[]}\n" {
		t.Fatalf("other organization list status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodGet, "/api/scim/tokens", "", orgID)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), created.Token) || !strings.Contains(response.Body.String(), created.ID) {
		t.Fatalf("list response exposed token or omitted metadata: status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodDelete, "/api/scim/tokens?id="+created.ID, "", orgID)
	if response.Code != http.StatusOK || response.Body.String() != "{\"ok\":true}\n" {
		t.Fatalf("revoke status=%d body=%s", response.Code, response.Body.String())
	}
	var active bool
	if err := owner.QueryRow(ctx, `SELECT active FROM scim_tokens WHERE id = $1::uuid AND org_id = $2::uuid`, created.ID, orgID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active {
		t.Fatal(fmt.Sprintf("revoked SCIM token %s remains active", created.ID))
	}
}
