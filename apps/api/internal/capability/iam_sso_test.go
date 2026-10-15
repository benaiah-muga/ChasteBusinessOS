package capability

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestIAMSSOCapabilitiesDeclarePermissionsAndInverses(t *testing.T) {
	tests := []struct{ id, inverse string }{
		{iamCreateSSOConnectionCapabilityID, iamDisableSSOConnectionCapabilityID},
		{iamDisableSSOConnectionCapabilityID, iamRestoreSSOConnectionCapabilityID},
		{iamRestoreSSOConnectionCapabilityID, iamDisableSSOConnectionCapabilityID},
	}
	for _, test := range tests {
		spec, ok := capabilitySpecs[test.id]
		if !ok || !supportedCapability(test.id) || spec.module != "iam" || spec.permission != "iam.admin" || spec.risk != "identity" || spec.inverseCapabilityID != test.inverse || spec.inverseInputSource != "output" || !reflect.DeepEqual(spec.inverseFields, []string{"connectionId"}) {
			t.Errorf("%s spec=%+v exists=%t", test.id, spec, ok)
		}
		permission, ok := PermissionForCapability(test.id)
		if !ok || permission != "iam.admin" {
			t.Errorf("permission %s = %q,%t", test.id, permission, ok)
		}
	}
}

func TestParseIAMSSOInputsRejectUnsafeOrUnknownFields(t *testing.T) {
	valid := json.RawMessage(`{"protocol":"oidc","label":"Example IdP","idpEntityId":"https://issuer.example.test","ssoUrl":"https://idp.example.test/sso","idpCertificate":"CERT","domain":"Example.Test"}`)
	parsed, err := parseIAMInput(iamCreateSSOConnectionCapabilityID, valid)
	if err != nil {
		t.Fatal(err)
	}
	input := parsed.(IAMCreateSSOConnectionInput)
	if input.Domain == nil || *input.Domain != "example.test" || input.Label != "Example IdP" {
		t.Fatalf("normalized input=%+v", input)
	}
	for _, raw := range []string{
		`{"protocol":"ldap","label":"IdP","idpEntityId":"issuer","ssoUrl":"https://idp.example.test/sso"}`,
		`{"protocol":"saml","label":"IdP","idpEntityId":"issuer","ssoUrl":"https://user:pass@idp.example.test/sso"}`,
		`{"protocol":"saml","label":"IdP","idpEntityId":"issuer","ssoUrl":"https://idp.example.test/sso","domain":"-bad.test"}`,
		`{"protocol":"saml","label":"IdP","idpEntityId":"issuer","ssoUrl":"https://idp.example.test/sso","unexpected":true}`,
	} {
		if _, err := parseIAMInput(iamCreateSSOConnectionCapabilityID, json.RawMessage(raw)); err == nil {
			t.Errorf("accepted invalid SSO input %s", raw)
		}
	}
	if _, err := parseIAMInput(iamDisableSSOConnectionCapabilityID, json.RawMessage(`{"connectionId":"not-a-uuid"}`)); err == nil {
		t.Fatal("accepted invalid SSO connection id")
	}
	if _, err := parseIAMInput(iamDisableSSOConnectionCapabilityID, json.RawMessage(`{"connectionId":"33333333-3333-4333-8333-333333333333","orgId":"attacker"}`)); err == nil {
		t.Fatal("accepted caller selected org")
	}
}
