package policy

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresReaderReturnsDefaultsWhenOrgHasNoPolicy(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, pool); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	value, err := NewPostgresReader(pool).ForOrg(ctx, "ffffffff-ffff-4fff-8fff-ffffffffffff")
	if err != nil {
		t.Fatal(err)
	}
	want := Value{
		MaxRiskAutonomous:   "write",
		MoneyThresholdMinor: 50_000,
		RequiresApprovalFor: json.RawMessage("[]"),
	}
	if value.MaxRiskAutonomous != want.MaxRiskAutonomous || value.MoneyThresholdMinor != want.MoneyThresholdMinor ||
		string(value.RequiresApprovalFor) != "[]" {
		t.Fatalf("policy = %+v, want %+v", value, want)
	}
}

func TestPostgresReaderReturnsConfiguredPolicyOnlyForItsOrganization(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed the configured policy integration test")
		}
		t.Skip("DATABASE_URL is required to seed the configured policy integration test")
	}

	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer adminPool.Close()

	orgID := randomTestUUID(t)
	otherOrgID := randomTestUUID(t)
	_, err = adminPool.Exec(ctx,
		`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Go policy fixture', $2), ($3, 'Go policy other org', $4)`,
		orgID, "go-policy-"+orgID[:8], otherOrgID, "go-policy-"+otherOrgID[:8],
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = adminPool.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1, $2)`, orgID, otherOrgID)
	}()
	_, err = adminPool.Exec(ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for)
		VALUES ($1, '*', 'money', 125500, '["identity", "money"]'::jsonb)`, orgID)
	if err != nil {
		t.Fatal(err)
	}

	runtimePool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimePool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, runtimePool); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	reader := NewPostgresReader(runtimePool)
	configured, err := reader.ForOrg(ctx, orgID)
	if err != nil {
		t.Fatal(err)
	}
	var configuredApproval []string
	if err := json.Unmarshal(configured.RequiresApprovalFor, &configuredApproval); err != nil {
		t.Fatal(err)
	}
	if configured.MaxRiskAutonomous != "money" || configured.MoneyThresholdMinor != 125500 ||
		len(configuredApproval) != 2 || configuredApproval[0] != "identity" || configuredApproval[1] != "money" {
		t.Fatalf("configured policy = %+v", configured)
	}

	isolated, err := reader.ForOrg(ctx, otherOrgID)
	if err != nil {
		t.Fatal(err)
	}
	if isolated.MaxRiskAutonomous != "write" || isolated.MoneyThresholdMinor != 50_000 ||
		string(isolated.RequiresApprovalFor) != "[]" {
		t.Fatalf("other organization received policy data: %+v", isolated)
	}
}

func randomTestUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func TestParseRequiresApprovalPreservesLegacyJSONArrays(t *testing.T) {
	for _, raw := range [][]byte{nil, []byte("null"), []byte(`{"risk":"money"}`), []byte(`broken`)} {
		if got := parseRequiresApproval(raw); string(got) != "[]" {
			t.Errorf("parseRequiresApproval(%q) = %s, want []", raw, got)
		}
	}
	for _, raw := range [][]byte{[]byte(`["money","identity"]`), []byte(`["money",7]`)} {
		if got := parseRequiresApproval(raw); string(got) != string(raw) {
			t.Errorf("parseRequiresApproval(%q) = %s, want unchanged JSON array", raw, got)
		}
	}
}
