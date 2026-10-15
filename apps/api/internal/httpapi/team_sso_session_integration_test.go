package httpapi

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoTeamSSORepositoryUsesOrganizationRLS(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the SSO connection fixture")
		}
		t.Skip("DATABASE_URL is required to seed the SSO connection fixture")
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
	slug := "go-team-sso-" + orgID[:8]
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'SSO fixture', $2), ($3::uuid, 'SSO other fixture', $4)`, orgID, slug, otherOrgID, slug+"-other"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM sso_connections WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SSO connection fixtures: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SSO fixture organizations: %v", err)
		}
	})
	otherConnectionID, ownConnectionID := integrationUUID(t), integrationUUID(t)
	if _, err := owner.Exec(ctx, `
		INSERT INTO sso_connections (id, org_id, protocol, label, idp_entity_id, sso_url, domain)
		VALUES ($1::uuid, $2::uuid, 'oidc', 'Other org IdP', 'https://issuer.example.test', 'https://idp.example.test/login', 'other.example.test'),
		($3::uuid, $4::uuid, 'saml', 'Local IdP', 'urn:fixture:local-idp', 'https://idp.example.test/sso', 'example.test')`,
		otherConnectionID, otherOrgID, ownConnectionID, orgID); err != nil {
		t.Fatal(err)
	}

	repo := postgresTeamSSORepository{pool: runtime}
	orgRows, err := repo.List(ctx, orgID)
	if err != nil {
		t.Fatalf("list own organization's SSO connections: %v", err)
	}
	if len(orgRows) != 1 || orgRows[0].ID != ownConnectionID {
		t.Fatalf("org connections=%+v; want only seeded row %s", orgRows, ownConnectionID)
	}
	otherRows, err := repo.List(ctx, otherOrgID)
	if err != nil {
		t.Fatalf("list other organization's SSO connections: %v", err)
	}
	if len(otherRows) != 1 || otherRows[0].ID != otherConnectionID {
		t.Fatalf("other org connections=%+v; want only its seeded row %s", otherRows, otherConnectionID)
	}
}
