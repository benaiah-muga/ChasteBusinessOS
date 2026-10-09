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
