package httpapi

import "testing"

func TestDocumentsEditorDisabledCapabilitiesUsesExplicitOptOut(t *testing.T) {
	if got := DocumentsEditorDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("default-on gate returned disabled capabilities: %v", got)
	}
	if _, disabled := DocumentsEditorDisabledCapabilities(false)["documents.getDoc"]; !disabled {
		t.Fatal("explicit opt-out did not disable documents.getDoc")
	}
}
