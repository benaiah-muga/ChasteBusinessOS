package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	teamTestUserID = "11111111-1111-4111-8111-111111111111"
	teamTestOrgID  = "22222222-2222-4222-8222-222222222222"
)

type teamResolverStub struct {
	resolved         *session.ResolvedUser
	err              error
	resolvedCookie   string
	resolvedSelector string
	bearer           string
	bearerSelector   string
}

func (s *teamResolverStub) Resolve(_ context.Context, cookie, activeOrg string) (*session.ResolvedUser, error) {
	s.resolvedCookie = cookie
	s.resolvedSelector = activeOrg
	return s.resolved, s.err
}

func (s *teamResolverStub) ResolveBearerToken(_ context.Context, bearer, activeOrg string) (*session.ResolvedUser, error) {
	s.bearer = bearer
	s.bearerSelector = activeOrg
	return s.resolved, s.err
}

func teamTestResolved(permissions map[string]bool) *session.ResolvedUser {
	orgID := teamTestOrgID
	return &session.ResolvedUser{
		UserID: teamTestUserID, Email: "owner@example.test", OrgID: &orgID,
		Permissions: permissions, EmailVerified: true, AllOrgIDs: []string{orgID},
	}
}

func teamTestHandler(resolved *session.ResolvedUser, load teamReadLoadFunc) (*GoTeamHandler, *teamResolverStub) {
	resolver := &teamResolverStub{resolved: resolved}
	handler := &GoTeamHandler{
		resolver: resolver,
		load:     load,
		catalog:  normalizeTeamCatalog([]string{"crm.read", "iam.read", "crm.read", "  ", "accounting.read"}),
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	return handler, resolver
}

func teamRequest() *http.Request {
	return httptest.NewRequest(http.MethodGet, "/api/team", nil)
}

func TestGoTeamHandlerReturnsViteTeamContractForActiveSession(t *testing.T) {
	name := "Ada Owner"
	var gotUserID, gotOrgID string
	handler, resolver := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), func(_ context.Context, userID, orgID string) (teamReadData, bool, error) {
		gotUserID, gotOrgID = userID, orgID
		return teamReadData{
			Members: []teamReadMember{{UserID: teamTestUserID, Name: &name, Email: "owner@example.test", RoleKeys: []string{"owner"}}},
			Roles:   []teamReadRole{{ID: "role-id", Key: "owner", Name: "Owner", IsSystem: true, Permissions: []string{"iam.read", "iam.admin"}}},
		}, true, nil
	})
	request := teamRequest()
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: teamTestOrgID})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if gotUserID != teamTestUserID || gotOrgID != teamTestOrgID {
		t.Fatalf("loader identity = %s/%s, want %s/%s", gotUserID, gotOrgID, teamTestUserID, teamTestOrgID)
	}
	if resolver.resolvedCookie != "signed-session-cookie" || resolver.resolvedSelector != teamTestOrgID {
		t.Fatalf("resolver received cookie=%q active organization=%q", resolver.resolvedCookie, resolver.resolvedSelector)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
	var body struct {
		Members []teamReadMember `json:"members"`
		Roles   []teamReadRole   `json:"roles"`
		Catalog []string         `json:"catalog"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Members) != 1 || body.Members[0].UserID != teamTestUserID || body.Members[0].RoleKeys[0] != "owner" {
		t.Fatalf("members contract = %+v", body.Members)
	}
	if len(body.Roles) != 1 || body.Roles[0].Permissions[0] != "iam.read" || !body.Roles[0].IsSystem {
		t.Fatalf("roles contract = %+v", body.Roles)
	}
	if want := []string{"accounting.read", "crm.read", "iam.read"}; !reflect.DeepEqual(body.Catalog, want) {
		t.Fatalf("catalog = %v, want %v", body.Catalog, want)
	}
}

func TestGoTeamHandlerResolvesBearerAndExplicitOrganization(t *testing.T) {
	handler, resolver := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), func(context.Context, string, string) (teamReadData, bool, error) {
		return teamReadData{}, true, nil
	})
	request := teamRequest()
	request.Header.Set("Authorization", "Bearer api-token")
	request.Header.Set("X-Organization-ID", teamTestOrgID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.bearer != "api-token" || resolver.bearerSelector != teamTestOrgID {
		t.Fatalf("bearer resolver received token=%q selector=%q", resolver.bearer, resolver.bearerSelector)
	}
}

func TestGoTeamHandlerRequiresVerifiedActiveOrganizationAndPermission(t *testing.T) {
	cases := []struct {
		name       string
		resolved   *session.ResolvedUser
		wantStatus int
	}{
		{name: "anonymous", resolved: nil, wantStatus: http.StatusUnauthorized},
		{name: "unverified email", resolved: &session.ResolvedUser{UserID: teamTestUserID, EmailVerified: false}, wantStatus: http.StatusUnauthorized},
		{name: "no active organization", resolved: &session.ResolvedUser{UserID: teamTestUserID, EmailVerified: true}, wantStatus: http.StatusUnauthorized},
		{name: "missing permission", resolved: teamTestResolved(map[string]bool{"crm.read": true}), wantStatus: http.StatusForbidden},
		{name: "wildcard permission", resolved: teamTestResolved(map[string]bool{"*": true}), wantStatus: http.StatusOK},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			called := false
			handler, _ := teamTestHandler(test.resolved, func(context.Context, string, string) (teamReadData, bool, error) {
				called = true
				return teamReadData{}, true, nil
			})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, teamRequest())
			if response.Code != test.wantStatus {
				t.Fatalf("status=%d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
			if test.name == "missing permission" && !strings.Contains(response.Body.String(), `"error":"forbidden: missing permission: iam.read"`) {
				t.Fatalf("missing permission error=%s", response.Body.String())
			}
			if called != (test.wantStatus == http.StatusOK) {
				t.Fatalf("loader called = %t, want request authorized = %t", called, test.wantStatus == http.StatusOK)
			}
		})
	}
}

func TestGoTeamHandlerRejectsMismatchedOrganizationAndDatabaseAuthorization(t *testing.T) {
	t.Run("mismatched explicit organization", func(t *testing.T) {
		called := false
		handler, _ := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), func(context.Context, string, string) (teamReadData, bool, error) {
			called = true
			return teamReadData{}, true, nil
		})
		request := teamRequest()
		request.Header.Set("X-Organization-ID", "33333333-3333-4333-8333-333333333333")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || called {
			t.Fatalf("status=%d loaderCalled=%t body=%s", response.Code, called, response.Body.String())
		}
	})

	t.Run("membership or database grant revoked", func(t *testing.T) {
		handler, _ := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), func(context.Context, string, string) (teamReadData, bool, error) {
			return teamReadData{}, false, nil
		})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, teamRequest())
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s, want forbidden", response.Code, response.Body.String())
		}
	})

	t.Run("invalid organization selector", func(t *testing.T) {
		called := false
		handler, _ := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), func(context.Context, string, string) (teamReadData, bool, error) {
			called = true
			return teamReadData{}, true, nil
		})
		request := teamRequest()
		request.Header.Add("X-Organization-ID", teamTestOrgID)
		request.Header.Add("X-Organization-ID", teamTestOrgID)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || called {
			t.Fatalf("status=%d loaderCalled=%t", response.Code, called)
		}
	})
}

func TestGoTeamHandlerHidesDatabaseErrorsAndAllowsOnlyGet(t *testing.T) {
	t.Run("database details hidden", func(t *testing.T) {
		handler, _ := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), func(context.Context, string, string) (teamReadData, bool, error) {
			return teamReadData{}, false, errors.New("private database password")
		})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, teamRequest())
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database password") {
			t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
		}
	})

	t.Run("mutation method refused", func(t *testing.T) {
		handler, _ := teamTestHandler(teamTestResolved(map[string]bool{"iam.read": true}), nil)
		request := httptest.NewRequest(http.MethodPost, "/api/team", strings.NewReader(`{}`))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("status=%d allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
		}
	})
}

func TestGoTeamHandlerMatchesLegacyIAMListMembersContractAndScopesOrganizations(t *testing.T) {
	ctx := context.Background()
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
			t.Fatal("DATABASE_URL is required to seed team integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed team integration fixtures")
	}
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

	orgID, otherOrgID := teamUUID(t), teamUUID(t)
	ownerID, memberID, foreignMemberID := teamUUID(t), teamUUID(t), teamUUID(t)
	ownerRoleID, memberRoleID, foreignRoleID := teamUUID(t), teamUUID(t), teamUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go team parity fixture', $2),
		($3::uuid, 'Go team foreign fixture', $4)`,
		orgID, "go-team-"+orgID[:8], otherOrgID, "go-team-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("remove team fixture organizations: %v", err)
		}
		if _, err := owner.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{ownerID, memberID, foreignMemberID}); err != nil {
			t.Errorf("remove team fixture users: %v", err)
		}
	})
	_, err = owner.Exec(ctx, `
		INSERT INTO users (id, email, name) VALUES
		($1::uuid, $2, 'Ada Owner'),
		($3::uuid, $4, NULL),
		($5::uuid, $6, 'Foreign Member')`,
		ownerID, "a-owner-"+orgID[:8]+"@fixture.test",
		memberID, "b-member-"+orgID[:8]+"@fixture.test",
		foreignMemberID, "z-foreign-"+otherOrgID[:8]+"@fixture.test")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid), ($4::uuid, $5::uuid)`, orgID, ownerID, memberID, otherOrgID, foreignMemberID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'owner', 'Owner', true), ($3::uuid, $2::uuid, 'reader', 'Reader', false), ($4::uuid, $5::uuid, 'foreign-owner', 'Foreign Owner', true)`, ownerRoleID, orgID, memberRoleID, foreignRoleID, otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'iam.admin', $2::uuid), ($1::uuid, 'iam.read', $2::uuid), ($3::uuid, 'crm.read', $2::uuid), ($4::uuid, 'iam.read', $5::uuid)`, ownerRoleID, orgID, memberRoleID, foreignRoleID, otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid), ($4::uuid, $5::uuid, $6::uuid)`, ownerID, ownerRoleID, orgID, foreignMemberID, foreignRoleID, otherOrgID); err != nil {
		t.Fatal(err)
	}

	resolved := &session.ResolvedUser{
		UserID: ownerID, Email: "a-owner-" + orgID[:8] + "@fixture.test", OrgID: &orgID,
		Permissions: map[string]bool{"iam.read": true}, EmailVerified: true,
	}
	handler := NewGoTeamHandler(runtime, &teamResolverStub{resolved: resolved}, capability.PermissionCatalog(), nil)
	request := httptest.NewRequest(http.MethodGet, "/api/team", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "team-parity-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("private team data lacks no-store headers: %v", response.Header())
	}
	var body struct {
		Members []teamReadMember `json:"members"`
		Roles   []teamReadRole   `json:"roles"`
		Catalog []string         `json:"catalog"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := struct {
		Members []teamReadMember
		Roles   []teamReadRole
	}{
		Members: []teamReadMember{
			{UserID: ownerID, Name: stringPtr("Ada Owner"), Email: "a-owner-" + orgID[:8] + "@fixture.test", RoleKeys: []string{"owner"}},
			{UserID: memberID, Name: nil, Email: "b-member-" + orgID[:8] + "@fixture.test", RoleKeys: []string{}},
		},
		Roles: []teamReadRole{
			{ID: ownerRoleID, Key: "owner", Name: "Owner", IsSystem: true, Permissions: []string{"iam.admin", "iam.read"}},
			{ID: memberRoleID, Key: "reader", Name: "Reader", IsSystem: false, Permissions: []string{"crm.read"}},
		},
	}
	if !reflect.DeepEqual(body.Members, want.Members) || !reflect.DeepEqual(body.Roles, want.Roles) {
		t.Fatalf("Go team response differs from legacy iam.listMembers contract: members=%+v roles=%+v", body.Members, body.Roles)
	}
	if !reflect.DeepEqual(body.Catalog, capability.PermissionCatalog()) {
		t.Fatalf("permission catalog=%v, want capability registry catalog %v", body.Catalog, capability.PermissionCatalog())
	}
	for _, member := range body.Members {
		if member.UserID == foreignMemberID || strings.Contains(member.Email, "foreign-") {
			t.Fatalf("team response leaked a foreign-organization member: %+v", member)
		}
	}
	for _, role := range body.Roles {
		if role.ID == foreignRoleID || role.Key == "foreign-owner" {
			t.Fatalf("team response leaked a foreign-organization role: %+v", role)
		}
	}
}

func teamUUID(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

func stringPtr(value string) *string {
	return &value
}
