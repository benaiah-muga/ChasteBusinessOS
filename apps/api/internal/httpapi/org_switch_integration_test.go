package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/orgswitch"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoOrgSwitchHandlerRechecksMembershipUnderRuntimeRLS(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the org-switch integration test")
		}
		t.Skip("DATABASE_URL is required to seed org-switch fixture rows")
	}

	ctx := context.Background()
	ownerPool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ownerPool.Close)
	runtimePool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtimePool.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtimePool); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	memberOrgID := integrationUUID(t)
	otherOrgID := integrationUUID(t)
	userID := integrationUUID(t)
	_, err = ownerPool.Exec(ctx,
		`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Go org-switch member fixture', $2), ($3, 'Go org-switch other fixture', $4)`,
		memberOrgID, "go-org-switch-"+memberOrgID[:8], otherOrgID, "go-org-switch-other-"+otherOrgID[:8],
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := ownerPool.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1, $2)`, memberOrgID, otherOrgID); err != nil {
			t.Errorf("delete org-switch fixtures: %v", err)
		}
		if _, err := ownerPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("delete org-switch user fixture: %v", err)
		}
	})
	email := "go-org-switch-" + userID[:8] + "@fixture.test"
	_, err = ownerPool.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Go org-switch fixture')`, userID, email)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ownerPool.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1, $2)`, memberOrgID, userID)
	if err != nil {
		t.Fatal(err)
	}

	handler := NewGoOrgSwitchHandler(assertionSecret, orgswitch.NewPostgresMembershipChecker(runtimePool), nil)
	for _, test := range []struct {
		name       string
		orgID      string
		wantStatus int
		wantCookie bool
	}{
		{name: "member can switch", orgID: memberOrgID, wantStatus: http.StatusOK, wantCookie: true},
		{name: "membership in another org does not grant access", orgID: otherOrgID, wantStatus: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			claims := validOrgSwitchClaims()
			claims.Subject = userID
			claims.OrganizationID = test.orgID
			request := orgSwitchRequest(t, `{"orgId":"`+test.orgID+`"}`, claims)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
			if got := response.Header().Get("Set-Cookie"); test.wantCookie != (got != "") {
				t.Fatalf("Set-Cookie = %q, want cookie present=%t", got, test.wantCookie)
			}
			if test.wantCookie {
				cookies := response.Result().Cookies()
				if len(cookies) != 1 || cookies[0].Name != "chaste_active_org" || cookies[0].Value != test.orgID {
					t.Fatalf("cookies = %#v, want selected org cookie", cookies)
				}
			}
		})
	}
}

func integrationUUID(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}
