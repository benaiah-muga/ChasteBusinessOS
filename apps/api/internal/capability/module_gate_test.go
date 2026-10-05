package capability

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
)

// ownerDatabaseURL returns the schema-owner connection used to seed org rows,
// or skips when no database is configured.
func ownerDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed module gate fixtures")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	return url
}

// TypeScript's createDbModuleGate (apps/web/src/server/kernel.ts) always allows
// settings, and always allows the protected spine modules iam, signals, and
// routines, regardless of a saved enabled_modules list. Go had no such bypass,
// so any organization that had ever saved a module list silently lost IAM
// governance in Go while TypeScript still allowed it. These tests fail if the
// always-enabled set regresses.
func TestAlwaysEnabledModulesIgnoreASavedModuleList(t *testing.T) {
	ctx := context.Background()
	ownerURL := ownerDatabaseURL(t)
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)

	orgID := executorUUID(t)
	if _, err := owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, enabled_modules)
		VALUES ($1::uuid, 'Go module gate fixture', $2, '["crm"]'::jsonb)`,
		orgID, "go-module-gate-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}

	// A restricted list must still not disable settings or the spine, and must
	// still disable a module that is genuinely absent from the saved list.
	for _, tc := range []struct {
		module string
		want   bool
	}{
		{"settings", true},
		{"iam", true},
		{"signals", true},
		{"routines", true},
		{"crm", true},
		{"manufacturing", false},
	} {
		got, err := dbx.WithOrgTx(ctx, owner, orgID, func(tx pgx.Tx) (bool, error) {
			return isModuleEnabled(ctx, tx, orgID, tc.module)
		})
		if err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Errorf("isModuleEnabled(%q) = %v, want %v", tc.module, got, tc.want)
		}
	}
}

// A NULL enabled_modules column means every module is available, and that
// behavior must not change because of the always-enabled bypass.
func TestNullModuleListStillEnablesEveryModule(t *testing.T) {
	ctx := context.Background()
	ownerURL := ownerDatabaseURL(t)
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)

	orgID := executorUUID(t)
	if _, err := owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, enabled_modules)
		VALUES ($1::uuid, 'Go null module fixture', $2, NULL)`,
		orgID, "go-null-modules-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}

	for _, module := range []string{"crm", "manufacturing", "marketing", "support", "skills"} {
		enabled, err := dbx.WithOrgTx(ctx, owner, orgID, func(tx pgx.Tx) (bool, error) {
			return isModuleEnabled(ctx, tx, orgID, module)
		})
		if err != nil {
			t.Fatal(err)
		}
		if !enabled {
			t.Errorf("isModuleEnabled(%q) = false, want true for a NULL module list", module)
		}
	}
}

// The always-enabled set must stay a subset of the TypeScript catalog, so a
// typo cannot silently invent an always-on module.
func TestAlwaysEnabledSetIsKnownToTheTypeScriptCatalog(t *testing.T) {
	known := map[string]bool{
		"accounting": true, "analytics": true, "marketing": true, "projects": true,
		"pos": true, "inventory": true, "manufacturing": true, "purchasing": true,
		"crm": true, "sales": true, "documents": true, "hr": true, "messaging": true,
		"support": true, "skills": true, "creator": true, "iam": true,
		"routines": true, "signals": true, "settings": true,
	}
	for module := range alwaysEnabledModuleIDs {
		if !known[module] {
			t.Errorf("alwaysEnabledModuleIDs contains %q, which is not a known module id", module)
		}
	}

	encoded, err := json.Marshal(alwaysEnabledModuleIDs)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) == 0 {
		t.Fatal("alwaysEnabledModuleIDs must not be empty")
	}
}
