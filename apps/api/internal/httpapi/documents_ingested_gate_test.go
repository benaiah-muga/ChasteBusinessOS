package httpapi

import "testing"

func TestDocumentsIngestedDisabledCapabilitiesUsesExplicitOptOut(t *testing.T) {
	if got := DocumentsIngestedDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("default-on gate returned disabled capabilities: %v", got)
	}
	if _, disabled := DocumentsIngestedDisabledCapabilities(false)["documents.listIngestedDocuments"]; !disabled {
		t.Fatal("explicit opt-out did not disable documents.listIngestedDocuments")
	}
}

func TestDocumentsVersionDisabledCapabilitiesUsesExplicitOptOut(t *testing.T) {
	if got := DocumentsVersionDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("default-on gate returned disabled capabilities: %v", got)
	}
	for _, capabilityID := range []string{"documents.listDocVersions", "documents.getDocVersion"} {
		if _, disabled := DocumentsVersionDisabledCapabilities(false)[capabilityID]; !disabled {
			t.Fatalf("explicit opt-out did not disable %s", capabilityID)
		}
	}
}
