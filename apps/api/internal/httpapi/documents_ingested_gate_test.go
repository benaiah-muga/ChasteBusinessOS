package httpapi

import "testing"

func TestDocumentsIngestedDisabledCapabilitiesRequiresExplicitEnablement(t *testing.T) {
	if _, disabled := DocumentsIngestedDisabledCapabilities(false)["documents.listIngestedDocuments"]; !disabled {
		t.Fatal("default-off gate did not disable documents.listIngestedDocuments")
	}
	if got := DocumentsIngestedDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("enabled gate returned disabled capabilities: %v", got)
	}
}

func TestDocumentsVersionDisabledCapabilitiesRequiresExplicitEnablement(t *testing.T) {
	for _, capabilityID := range []string{"documents.listDocVersions", "documents.getDocVersion"} {
		if _, disabled := DocumentsVersionDisabledCapabilities(false)[capabilityID]; !disabled {
			t.Fatalf("default-off gate did not disable %s", capabilityID)
		}
	}
	if got := DocumentsVersionDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("enabled gate returned disabled capabilities: %v", got)
	}
}
