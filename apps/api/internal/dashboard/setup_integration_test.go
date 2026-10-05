package dashboard

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSetupPostgresReaderWidgetCompletionRequiresEmbedToken(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed setup integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed setup fixtures")
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

	orgID := dashboardUUID(t)
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Go setup fixture', $2)`, orgID, "go-setup-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1::uuid`, orgID); err != nil {
			t.Errorf("purge setup fixture: %v", err)
		}
	})
	if _, err := owner.Exec(ctx, `INSERT INTO support_settings (org_id, embed_token, auto_reply_enabled, greeting) VALUES ($1::uuid, '', false, 'Setup fixture')`, orgID); err != nil {
		t.Fatal(err)
	}

	reader := NewSetupPostgresReader(runtime)
	withoutToken, err := reader.ForOrg(ctx, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if setupItemDone(withoutToken, "widget") {
		t.Fatal("widget setup should remain incomplete when embed_token is empty")
	}
	if _, err := owner.Exec(ctx, `UPDATE support_settings SET embed_token = $2 WHERE org_id = $1::uuid`, orgID, "go-setup-token-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}
	withToken, err := reader.ForOrg(ctx, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if !setupItemDone(withToken, "widget") {
		t.Fatal("widget setup should be complete when embed_token is nonempty")
	}
}

func setupItemDone(payload SetupPayload, id string) bool {
	for _, item := range payload.Items {
		if item.ID == id {
			return item.Done
		}
	}
	return false
}
