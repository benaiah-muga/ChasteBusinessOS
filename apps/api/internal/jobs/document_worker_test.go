package jobs

import "testing"

func TestGoDocumentParseWorkerUsesDocumentsWritePermission(t *testing.T) {
	if got := GoCapabilityPermissions["documents.parseDocument"]; got != "documents.write" {
		t.Fatalf("documents.parseDocument worker permission = %q, want documents.write", got)
	}
}
