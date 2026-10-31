package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoReadOnlyHandlersEnforcePermissionsAndTenantRLS(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for the Go read-only HTTP contract")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Fatal("DATABASE_URL is required to seed Go read-only HTTP contract fixtures")
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

	orgID := readContractUUID(t)
	otherOrgID := readContractUUID(t)
	userID := readContractUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go read contract fixture', $2),
		($3::uuid, 'Go read contract other fixture', $4)`,
		orgID, "go-read-contract-"+orgID[:8], otherOrgID, "go-read-contract-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin read contract cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable read contract ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM ledger_events WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete read contract events: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete read contract organizations: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit read contract cleanup: %v", err)
		}
	})

	_, err = owner.Exec(ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for)
		VALUES ($1::uuid, '*', 'money', 125500, '["money"]'::jsonb)`, orgID)
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		orgID   string
		payload string
	}{
		{orgID: orgID, payload: `{"fixture":"authorized organization"}`},
		{orgID: otherOrgID, payload: `{"fixture":"other organization secret"}`},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO ledger_events (org_id, actor_type, kind, payload, prev_hash, hash, occurred_at)
			VALUES ($1::uuid, 'system', 'fixture.readContract', $2::jsonb, NULL, $3, $4)`,
			fixture.orgID, fixture.payload, "read-contract-"+fixture.orgID, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
	}

	server := newRouter(nil, nil, assertionSecret, policy.NewPostgresReader(runtime), ledger.NewPostgresReader(runtime), nil, nil, nil)
	now := time.Now().Unix()
	policyAssertion, err := authbridge.Sign(assertionSecret, authbridge.Claims{
		Audience:       authbridge.PolicyReadAudience,
		Subject:        userID,
		OrganizationID: orgID,
		CanEdit:        true,
		IssuedAt:       now,
		ExpiresAt:      now + 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	policyRequest := httptest.NewRequest(http.MethodGet, "/__go/policy", nil)
	policyRequest.Header.Set(sessionAssertionHeader, policyAssertion)
	policyResponse := httptest.NewRecorder()
	server.ServeHTTP(policyResponse, policyRequest)
	if policyResponse.Code != http.StatusOK || policyResponse.Body.String() != "{\"policy\":{\"maxRiskAutonomous\":\"money\",\"moneyThresholdMinor\":125500,\"requiresApprovalFor\":[\"money\"]},\"canEdit\":true}\n" {
		t.Fatalf("policy response status=%d body=%q, want the signed organization's policy", policyResponse.Code, policyResponse.Body.String())
	}

	ledgerAssertion, err := authbridge.Sign(assertionSecret, authbridge.Claims{
		Audience:       authbridge.LedgerReadAudience,
		Subject:        userID,
		OrganizationID: orgID,
		CanReadLedger:  true,
		IssuedAt:       now,
		ExpiresAt:      now + 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	ledgerRequest := httptest.NewRequest(http.MethodGet, "/__go/ledger?limit=20", nil)
	ledgerRequest.Header.Set(sessionAssertionHeader, ledgerAssertion)
	ledgerResponse := httptest.NewRecorder()
	server.ServeHTTP(ledgerResponse, ledgerRequest)
	if ledgerResponse.Code != http.StatusOK {
		t.Fatalf("ledger response status=%d body=%q, want 200", ledgerResponse.Code, ledgerResponse.Body.String())
	}
	if got := ledgerResponse.Body.String(); !strings.Contains(got, "authorized organization") || strings.Contains(got, "other organization secret") {
		t.Fatalf("ledger response leaked or omitted tenant-scoped event: %s", got)
	}

	deniedAssertion, err := authbridge.Sign(assertionSecret, authbridge.Claims{
		Audience:       authbridge.LedgerReadAudience,
		Subject:        userID,
		OrganizationID: orgID,
		IssuedAt:       now,
		ExpiresAt:      now + 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	deniedRequest := httptest.NewRequest(http.MethodGet, "/__go/ledger", nil)
	deniedRequest.Header.Set(sessionAssertionHeader, deniedAssertion)
	deniedResponse := httptest.NewRecorder()
	server.ServeHTTP(deniedResponse, deniedRequest)
	if deniedResponse.Code != http.StatusForbidden || deniedResponse.Body.String() != "{\"error\":\"forbidden\"}\n" {
		t.Fatalf("ledger without read grant status=%d body=%q, want existing forbidden contract", deniedResponse.Code, deniedResponse.Body.String())
	}

	fmt.Println("PASS: Go read-only HTTP contract")
}

func readContractUUID(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}
