package httpapi

import "testing"

func TestDocumentsEditorDisabledCapabilitiesRequiresExplicitEnablement(t *testing.T) {
	if _, disabled := DocumentsEditorDisabledCapabilities(false)["documents.getDoc"]; !disabled {
		t.Fatal("default-off gate did not disable documents.getDoc")
	}
	if got := DocumentsEditorDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("enabled gate returned disabled capabilities: %v", got)
	}
}
