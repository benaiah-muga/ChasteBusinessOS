package capability

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSCIMTokenManagementUsesGovernedExecutorAndKeepsBearerSecretOutOfAudit(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "iam.admin")
	rawToken := "scim_one-time-secret-fixture"
	digest := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(digest[:])
	input, err := json.Marshal(SCIMTokenCreateInput{TokenHash: tokenHash, Label: "Fixture IdP", ExpiresInDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	claims := waveModuleClaims(fx, SCIMTokenCreateCapabilityID, "iam.admin", input, "human", "", "scim-token-create-fixture")
	created, err := fx.executor.Execute(fx.ctx, claims, SCIMTokenCreateCapabilityID, input)
	if err != nil || !created.OK {
		t.Fatalf("create result=%+v err=%v", created, err)
	}
	var output SCIMTokenCreateOutput
	if err := json.Unmarshal(created.Data, &output); err != nil {
		t.Fatal(err)
	}
	if !isUUID(output.TokenID) || output.Label != "Fixture IdP" || output.ExpiresAt.IsZero() {
		t.Fatalf("unexpected create output: %+v", output)
	}
	if strings.Contains(string(created.Data), rawToken) || strings.Contains(string(created.Data), tokenHash) {
		t.Fatalf("executor output contains secret material: %s", created.Data)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, SCIMTokenCreateCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("same-intent create replay=%+v err=%v", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM scim_tokens WHERE org_id=$1::uuid AND token_hash=$2`, fx.orgID, tokenHash); got != 1 {
		t.Fatalf("same-intent replay created %d tokens, want one", got)
	}

	var receiptData, eventPayload string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT data::text FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":"+claims.IntentID).Scan(&receiptData); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT payload::text FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 ORDER BY seq DESC LIMIT 1`, fx.orgID, SCIMTokenCreateCapabilityID).Scan(&eventPayload); err != nil {
		t.Fatal(err)
	}
	for name, persisted := range map[string]string{"receipt": receiptData, "ledger event": eventPayload} {
		if strings.Contains(persisted, rawToken) || strings.Contains(persisted, tokenHash) {
			t.Fatalf("%s persisted SCIM secret material: %s", name, persisted)
		}
	}

	revokeInput, _ := json.Marshal(SCIMTokenRevokeInput{TokenID: output.TokenID})
	revokeClaims := waveModuleClaims(fx, SCIMTokenRevokeCapabilityID, "iam.admin", revokeInput, "human", "", "scim-token-revoke-fixture")
	revoked, err := fx.executor.Execute(fx.ctx, revokeClaims, SCIMTokenRevokeCapabilityID, revokeInput)
	if err != nil || !revoked.OK {
		t.Fatalf("revoke result=%+v err=%v", revoked, err)
	}
	var active bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT active FROM scim_tokens WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, output.TokenID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active {
		t.Fatal("governed revoke left token active")
	}
}

func TestSCIMTokenWritesRollBackWhenLedgerAppendFails(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "iam.admin")
	suffix := strings.ReplaceAll(fx.orgID, "-", "")
	functionName := "test_scim_token_ledger_failure_" + suffix
	triggerName := "test_scim_token_ledger_failure_trigger_" + suffix
	_, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'capability.executed' AND NEW.capability_id IN ('%s', '%s') THEN RAISE EXCEPTION 'forced SCIM ledger failure'; END IF; RETURN NEW; END $$`, functionName, SCIMTokenCreateCapabilityID, SCIMTokenRevokeCapabilityID))
	if err != nil {
		t.Fatal(err)
	}
	_, err = fx.owner.Exec(fx.ctx, fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW EXECUTE FUNCTION %s()`, triggerName, functionName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = fx.owner.Exec(fx.ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName))
		_, _ = fx.owner.Exec(fx.ctx, fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, functionName))
	})

	digest := sha256.Sum256([]byte("scim_rollback-fixture-secret"))
	tokenHash := hex.EncodeToString(digest[:])
	input, _ := json.Marshal(SCIMTokenCreateInput{TokenHash: tokenHash, Label: "Rollback fixture", ExpiresInDays: 30})
	claims := waveModuleClaims(fx, SCIMTokenCreateCapabilityID, "iam.admin", input, "human", "", "scim-token-rollback-fixture")
	if _, err := fx.executor.Execute(fx.ctx, claims, SCIMTokenCreateCapabilityID, input); err == nil {
		t.Fatal("expected ledger append failure")
	}
	if got := fx.count(`SELECT count(*) FROM scim_tokens WHERE org_id=$1::uuid AND token_hash=$2`, fx.orgID, tokenHash); got != 0 {
		t.Fatalf("failed governed write left %d token rows", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":"+claims.IntentID); got != 0 {
		t.Fatalf("failed governed write left %d receipts", got)
	}

	tokenID := executorUUID(t)
	revokeTokenHash := sha256.Sum256([]byte("scim_revoke_rollback-fixture-secret"))
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO scim_tokens (id, org_id, token_hash, label, active, expires_at) VALUES ($1::uuid, $2::uuid, $3, 'Revoke rollback fixture', true, clock_timestamp() + interval '1 hour')`, tokenID, fx.orgID, hex.EncodeToString(revokeTokenHash[:])); err != nil {
		t.Fatal(err)
	}
	revokeInput, _ := json.Marshal(SCIMTokenRevokeInput{TokenID: tokenID})
	revokeClaims := waveModuleClaims(fx, SCIMTokenRevokeCapabilityID, "iam.admin", revokeInput, "human", "", "scim-token-revoke-rollback-fixture")
	if _, err := fx.executor.Execute(fx.ctx, revokeClaims, SCIMTokenRevokeCapabilityID, revokeInput); err == nil {
		t.Fatal("expected revoke ledger append failure")
	}
	var active bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT active FROM scim_tokens WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, tokenID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("failed governed revoke left token inactive")
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":"+revokeClaims.IntentID); got != 0 {
		t.Fatalf("failed governed revoke left %d receipts", got)
	}
}
