package capability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestParseSCIMProvisionUserInput(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "normalized provision", input: `{"operation":"provision","email":"Person@Example.test","name":"  Person  "}`},
		{name: "deactivation", input: `{"operation":"deactivate","userId":"00000000-0000-4000-8000-000000000001"}`},
		{name: "unknown field", input: `{"operation":"provision","email":"person@example.test","actorType":"human"}`, wantErr: true},
		{name: "invalid email", input: `{"operation":"provision","email":"person@localhost"}`, wantErr: true},
		{name: "invalid user id", input: `{"operation":"deactivate","userId":"not-a-uuid"}`, wantErr: true},
		{name: "extra deactivation field", input: `{"operation":"deactivate","userId":"00000000-0000-4000-8000-000000000001","email":"person@example.test"}`, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseSCIMProvisionUserInput(json.RawMessage(test.input))
			if (err != nil) != test.wantErr {
				t.Fatalf("ParseSCIMProvisionUserInput() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
	oversized, _ := json.Marshal(map[string]any{"operation": "provision", "email": "person@example.test", "name": strings.Repeat("n", 101)})
	if _, err := ParseSCIMProvisionUserInput(oversized); err == nil {
		t.Fatal("oversized display name was accepted")
	}
}

func TestSCIMProvisionIntentIDIsStableAndScoped(t *testing.T) {
	tokenA := "00000000-0000-4000-8000-000000000001"
	tokenB := "00000000-0000-4000-8000-000000000002"
	keyA := "10000000-0000-4000-8000-000000000001"
	keyB := "10000000-0000-4000-8000-000000000002"
	first, err := SCIMProvisionIntentID(tokenA, keyA)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := SCIMProvisionIntentID(tokenA, keyA)
	if err != nil {
		t.Fatal(err)
	}
	newOperation, err := SCIMProvisionIntentID(tokenA, keyB)
	if err != nil {
		t.Fatal(err)
	}
	otherToken, err := SCIMProvisionIntentID(tokenB, keyA)
	if err != nil {
		t.Fatal(err)
	}
	if first != retry || first == newOperation || first == otherToken {
		t.Fatalf("intent identity first=%q retry=%q new-operation=%q other-token=%q", first, retry, newOperation, otherToken)
	}
	if _, err := SCIMProvisionIntentID("not-a-uuid", keyA); !errors.Is(err, ErrScopeMismatch) {
		t.Fatalf("invalid token id error = %v, want ErrScopeMismatch", err)
	}
	if _, err := SCIMProvisionIntentID(tokenA, "not-a-uuid"); !errors.Is(err, ErrScopeMismatch) {
		t.Fatalf("invalid idempotency key error = %v, want ErrScopeMismatch", err)
	}
	automatic, err := SCIMAutomaticIntentID(tokenA)
	if err != nil || !isSCIMAutomaticIntent(automatic, tokenA) {
		t.Fatalf("automatic intent=%q err=%v", automatic, err)
	}
	if isSCIMAutomaticIntent(automatic, tokenB) {
		t.Fatal("automatic intent marker was not token scoped")
	}
}

func TestSCIMAutomaticReceiptCachesOnlyAchievedState(t *testing.T) {
	tests := []struct {
		name  string
		input SCIMProvisionUserInput
		data  string
		want  bool
	}{
		{name: "provision active member", input: SCIMProvisionUserInput{Operation: "provision"}, data: `{"id":"user","active":true,"found":true}`, want: true},
		{name: "deactivation completed", input: SCIMProvisionUserInput{Operation: "deactivate"}, data: `{"id":"user","active":false,"found":true}`, want: true},
		{name: "deactivation owner conflict", input: SCIMProvisionUserInput{Operation: "deactivate"}, data: `{"id":"user","active":true,"found":true,"conflict":"last_owner"}`},
		{name: "deactivation missing member", input: SCIMProvisionUserInput{Operation: "deactivate"}, data: `{"active":false,"found":false}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := scimAutomaticReceiptCacheable(test.input, json.RawMessage(test.data)); got != test.want {
				t.Fatalf("scimAutomaticReceiptCacheable()=%t, want %t", got, test.want)
			}
		})
	}
}

func TestExecuteSCIMProvisionUserUsesExternalActorAndIsIdempotent(t *testing.T) {
	fx := newExecutorFixture(t)
	tokenID := executorUUID(t)
	userID := executorUUID(t)
	rawToken := "scim-capability-" + executorUUID(t)
	tokenHash := sha256.Sum256([]byte(rawToken))
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO scim_tokens (id, org_id, token_hash, label, active, expires_at)
		VALUES ($1::uuid, $2::uuid, $3, 'SCIM capability fixture', true, clock_timestamp() + interval '1 hour')`,
		tokenID, fx.orgID, hex.EncodeToString(tokenHash[:])); err != nil {
		t.Fatal(err)
	}
	email := "scim-capability-" + userID[:8] + "@fixture.test"
	input, err := json.Marshal(map[string]string{"operation": "provision", "email": email, "name": "Provisioned member"})
	if err != nil {
		t.Fatal(err)
	}
	intentID, err := SCIMProvisionIntentID(tokenID, "20000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	first, err := fx.executor.ExecuteSCIMProvisionUser(fx.ctx, fx.orgID, tokenID, intentID, input)
	if err != nil || !first.OK {
		t.Fatalf("SCIM provision result=%+v err=%v", first, err)
	}
	var provisioned SCIMProvisionUserOutput
	if err := json.Unmarshal(first.Data, &provisioned); err != nil {
		t.Fatal(err)
	}
	if provisioned.Email != email || !provisioned.Active || !provisioned.Found {
		t.Fatalf("SCIM provision output=%+v", provisioned)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), `DELETE FROM users WHERE id=$1::uuid`, provisioned.ID); err != nil {
			t.Errorf("delete SCIM fixture user: %v", err)
		}
	})

	replayed, err := fx.executor.ExecuteSCIMProvisionUser(fx.ctx, fx.orgID, tokenID, intentID, input)
	if err != nil || !replayed.OK || !replayed.Replayed {
		t.Fatalf("SCIM retry result=%+v err=%v, want receipt replay", replayed, err)
	}
	if got := fx.count(`SELECT count(*) FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, fx.orgID, provisioned.ID); got != 1 {
		t.Fatalf("provisioned membership count=%d, want one", got)
	}
	var actorType, actorID, capabilityID, auditPayload string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT actor_type, actor_id::text, capability_id, payload::text
		FROM ledger_events
		WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id='iam.scimProvisionUser'
		ORDER BY seq DESC LIMIT 1`, fx.orgID).Scan(&actorType, &actorID, &capabilityID, &auditPayload); err != nil {
		t.Fatal(err)
	}
	emailFingerprint := sha256.Sum256([]byte(email))
	guessableFingerprint := hex.EncodeToString(emailFingerprint[:])
	if actorType != "external" || actorID != tokenID || capabilityID != scimProvisionUserCapabilityID ||
		strings.Contains(auditPayload, email) || strings.Contains(auditPayload, guessableFingerprint) {
		t.Fatalf("SCIM audit actor=%s/%s capability=%s payload=%s", actorType, actorID, capabilityID, auditPayload)
	}
	if got := fx.count(`SELECT count(*) FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, fx.otherOrgID, provisioned.ID); got != 0 {
		t.Fatalf("other organization membership count=%d, want zero", got)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE scim_tokens SET active=false WHERE id=$1::uuid`, tokenID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.executor.ExecuteSCIMProvisionUser(fx.ctx, fx.orgID, tokenID, intentID, input); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("revoked SCIM token error=%v, want ErrSessionInvalid", err)
	}
}

func TestExecuteSCIMProvisionUserRequiresTokenOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	tokenID := executorUUID(t)
	tokenHash := sha256.Sum256([]byte("scim-scope-" + executorUUID(t)))
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO scim_tokens (id, org_id, token_hash, label, active, expires_at)
		VALUES ($1::uuid, $2::uuid, $3, 'SCIM scope fixture', true, clock_timestamp() + interval '1 hour')`,
		tokenID, fx.orgID, hex.EncodeToString(tokenHash[:])); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"operation":"provision","email":"scope-check@example.test"}`)
	intentID, err := SCIMProvisionIntentID(tokenID, "20000000-0000-4000-8000-000000000002")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.executor.ExecuteSCIMProvisionUser(fx.ctx, fx.otherOrgID, tokenID, intentID, input); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("cross-org SCIM execution error=%v, want ErrSessionInvalid", err)
	}
}
