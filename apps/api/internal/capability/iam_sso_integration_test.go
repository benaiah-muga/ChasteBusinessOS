package capability

import (
	"encoding/json"
	"testing"
)

func TestIAMSSOWritesUseGovernedExecutorAndRestoreInverse(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "iam.admin")
	createInput := json.RawMessage(`{"protocol":"saml","label":"Fixture IdP","idpEntityId":"urn:fixture:idp","ssoUrl":"https://idp.fixture.test/sso","domain":"fixture.test"}`)
	created, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamCreateSSOConnectionCapabilityID, "iam.admin", createInput, "human", "", "sso-create-governed-fixture"), iamCreateSSOConnectionCapabilityID, createInput)
	if err != nil || !created.OK {
		t.Fatalf("create result=%+v err=%v", created, err)
	}
	var output IAMSSOConnectionOutput
	if err := json.Unmarshal(created.Data, &output); err != nil || output.ConnectionID == "" {
		t.Fatalf("create output=%s err=%v", created.Data, err)
	}
	if got := fx.count(`SELECT count(*) FROM sso_connections WHERE org_id=$1::uuid AND id=$2::uuid AND created_by_user_id=$3::uuid`, fx.orgID, output.ConnectionID, fx.userID); got != 1 {
		t.Fatalf("governed create produced %d scoped rows", got)
	}

	idInput, _ := json.Marshal(IAMSSOConnectionIDInput{ConnectionID: output.ConnectionID})
	disabled, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamDisableSSOConnectionCapabilityID, "iam.admin", idInput, "human", "", "sso-disable-governed-fixture"), iamDisableSSOConnectionCapabilityID, idInput)
	if err != nil || !disabled.OK {
		t.Fatalf("disable result=%+v err=%v", disabled, err)
	}
	if got := fx.count(`SELECT count(*) FROM sso_connections WHERE org_id=$1::uuid AND id=$2::uuid AND status='disabled'`, fx.orgID, output.ConnectionID); got != 1 {
		t.Fatalf("disable left %d disabled rows", got)
	}

	restored, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamRestoreSSOConnectionCapabilityID, "iam.admin", idInput, "human", "", "sso-restore-governed-fixture"), iamRestoreSSOConnectionCapabilityID, idInput)
	if err != nil || !restored.OK {
		t.Fatalf("restore result=%+v err=%v", restored, err)
	}
	if got := fx.count(`SELECT count(*) FROM sso_connections WHERE org_id=$1::uuid AND id=$2::uuid AND status='active'`, fx.orgID, output.ConnectionID); got != 1 {
		t.Fatalf("restore left %d active rows", got)
	}
	for _, capabilityID := range []string{iamCreateSSOConnectionCapabilityID, iamDisableSSOConnectionCapabilityID, iamRestoreSSOConnectionCapabilityID} {
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, capabilityID); got != 1 {
			t.Errorf("%s has %d execution audit events", capabilityID, got)
		}
	}
}
