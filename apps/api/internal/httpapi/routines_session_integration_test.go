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

func TestPgRoutinesWebhookTokenReaderScopesTokensByOrganization(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed routines integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed routines integration fixtures")
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

	orgID, otherOrgID := readContractUUID(t), readContractUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go routines token fixture', $2),
		($3::uuid, 'Go routines token foreign fixture', $4)`,
		orgID, "go-routines-token-"+orgID[:8], otherOrgID, "go-routines-token-foreign-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete routines token fixture organizations: %v", err)
		}
	})

	localToken := "go-routines-local-" + orgID[:8]
	foreignToken := "go-routines-foreign-" + otherOrgID[:8]
	for _, fixture := range []struct {
		orgID string
		token string
		name  string
	}{
		{orgID: orgID, token: localToken, name: "Local routine"},
		{orgID: otherOrgID, token: foreignToken, name: "Foreign routine"},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO routines (org_id, name, prompt, schedule, enabled, trigger_type, webhook_token)
			VALUES ($1::uuid, $2, 'Routine fixture prompt', '{"kind":"interval","everyMinutes":60}'::jsonb, true, 'webhook', $3)`,
			fixture.orgID, fixture.name, fixture.token); err != nil {
			t.Fatalf("insert %s: %v", fixture.name, err)
		}
	}

	tokens, err := (pgRoutinesWebhookTokenReader{pool: runtime}).ForOrganization(ctx, orgID)
	if err != nil {
		t.Fatalf("read scoped webhook tokens: %v", err)
	}
	if len(tokens) != 1 {
		t.Fatalf("scoped token count = %d, want 1: %#v", len(tokens), tokens)
	}
	if tokensValue := tokensValueForToken(tokens, localToken); tokensValue == "" {
		t.Fatalf("local token not returned: %#v", tokens)
	}
	if tokensValue := tokensValueForToken(tokens, foreignToken); tokensValue != "" {
		t.Fatalf("foreign token leaked into organization result: %#v", tokens)
	}
}

func tokensValueForToken(tokens map[string]string, token string) string {
	for _, value := range tokens {
		if value == token {
			return value
		}
	}
	return ""
}
