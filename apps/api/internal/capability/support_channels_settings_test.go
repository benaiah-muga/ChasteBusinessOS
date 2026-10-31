package capability

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestParseSupportUpdateChannelSettingsInput(t *testing.T) {
	input, err := ParseSupportUpdateChannelSettingsInput(json.RawMessage(`{"autoReplyEnabled":false,"greeting":"  Hello  ","regenerateToken":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.AutoReplyEnabled == nil || *input.AutoReplyEnabled || input.Greeting == nil || *input.Greeting != "Hello" || !input.RegenerateToken {
		t.Fatalf("unexpected parsed patch: %#v", input)
	}
	for _, raw := range []string{`{}`, `{"autoReplyEnabled":null}`, `{"greeting":"  "}`, `{"regenerateToken":false}`, `{"unexpected":true}`} {
		if _, err := ParseSupportUpdateChannelSettingsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("expected invalid patch %s to be rejected", raw)
		}
	}
}

func TestParseSupportRestoreChannelSettingsInputAllowsAbsentSnapshots(t *testing.T) {
	input, err := ParseSupportRestoreChannelSettingsInput(json.RawMessage(`{"target":null,"expectedCurrent":{"autoReplyEnabled":true,"greeting":"Hello","embedToken":"old-token"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Target != nil || input.ExpectedCurrent == nil || input.ExpectedCurrent.EmbedToken != "old-token" {
		t.Fatalf("unexpected restore input: %#v", input)
	}
	if _, err := ParseSupportRestoreChannelSettingsInput(json.RawMessage(`{"target":null}`)); err == nil {
		t.Fatal("expected incomplete restore input to be rejected")
	}
	if _, err := ParseSupportRestoreChannelSettingsInput(json.RawMessage(`{"target":{"autoReplyEnabled":true,"greeting":"Hello","embedToken":"t","extra":1},"expectedCurrent":null}`)); err == nil {
		t.Fatal("expected unknown snapshot field to be rejected")
	}
}

func TestSupportChannelSettingsCapabilitiesDeclareSnapshotRestore(t *testing.T) {
	wantMappings := []inverseFieldMapping{
		{outputField: "previous", inputField: "target"},
		{outputField: "current", inputField: "expectedCurrent"},
	}
	for id, inverse := range map[string]string{
		supportUpdateChannelSettingsCapabilityID:  supportRestoreChannelSettingsCapabilityID,
		supportRestoreChannelSettingsCapabilityID: supportRestoreChannelSettingsCapabilityID,
	} {
		spec, ok := capabilitySpecs[id]
		if !ok {
			t.Fatalf("%s is not registered", id)
		}
		if spec.module != "support" || spec.permission != "iam.admin" || spec.risk != "write" || len(spec.intent) < 20 || spec.inverseCapabilityID != inverse || spec.inverseInputSource != "output" || !reflect.DeepEqual(spec.inverseFieldMappings, wantMappings) {
			t.Errorf("%s has incomplete governance metadata: %#v", id, spec)
		}
		if !supportedCapability(id) {
			t.Errorf("%s is not executable", id)
		}
	}
}

func TestSupportChannelSettingsInputsHaveCanonicalHashes(t *testing.T) {
	greeting := "Welcome"
	enabled := false
	update := SupportUpdateChannelSettingsInput{Greeting: &greeting, AutoReplyEnabled: &enabled, RegenerateToken: true}
	if hash, err := canonicalInputHash(update); err != nil || hash == "" {
		t.Fatalf("update canonicalInputHash() = %q, %v", hash, err)
	}
	restore := SupportRestoreChannelSettingsInput{
		Target:          &SupportChannelSettingsSnapshot{AutoReplyEnabled: true, Greeting: "Prior", EmbedToken: "prior-token"},
		ExpectedCurrent: &SupportChannelSettingsSnapshot{AutoReplyEnabled: false, Greeting: "Current", EmbedToken: "current-token"},
	}
	if hash, err := canonicalInputHash(restore); err != nil || hash == "" {
		t.Fatalf("restore canonicalInputHash() = %q, %v", hash, err)
	}
}
