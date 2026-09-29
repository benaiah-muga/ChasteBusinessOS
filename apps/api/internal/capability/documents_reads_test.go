package capability

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestListAuthoredDocsCapabilityContract(t *testing.T) {
	spec, exists := capabilitySpecs[documentsListDocsCapabilityID]
	if !supportedCapability(documentsListDocsCapabilityID) || !exists || spec.module != "documents" || spec.permission != "documents.read" || spec.risk != "read" {
		t.Fatalf("documents.listDocs spec=%+v supported=%t, want documents.read read capability", spec, supportedCapability(documentsListDocsCapabilityID))
	}
	for name, raw := range map[string]json.RawMessage{
		"object":        json.RawMessage(`{}`),
		"object fields": json.RawMessage(`{"ignored":true}`),
	} {
		if _, err := ParseListAuthoredDocsInput(raw); err != nil {
			t.Errorf("parse %s input: %v", name, err)
		}
	}
	for _, raw := range []json.RawMessage{json.RawMessage(`[]`), json.RawMessage(`null`), json.RawMessage(`{} {}`)} {
		if _, err := ParseListAuthoredDocsInput(raw); err == nil {
			t.Errorf("accepted invalid input %s", raw)
		}
	}
}

func TestGoAuthoredDocumentsReadPreservesOrderingVersionsAndTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{}`)
	claims := waveModuleClaims(fx, documentsListDocsCapabilityID, "documents.read", input, "human", "", "docs-list-read")
	claims.Permissions = []string{"documents.write"}
	denied, err := fx.executor.Execute(fx.ctx, claims, documentsListDocsCapabilityID, input)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: documents.read" {
		t.Fatalf("read without documents.read result=%+v err=%v, want documents.read denial", denied, err)
	}
	grantWavePermission(t, fx, "documents.read")

	updated := time.Date(2026, 9, 9, 12, 30, 15, 123000000, time.UTC)
	seed := func(orgID, title, folder string, updatedAt time.Time) string {
		t.Helper()
		var id string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO authored_docs (org_id, title, content_json, html, status, created_by_actor_type, updated_at, folder,
			                          document_type, linked_record_type, linked_record_id, linked_record_label)
			VALUES ($1::uuid, $2, '{}'::jsonb, '', 'draft', 'human', $3, $4, 'invoice', 'customer', NULL, 'Acme')
			RETURNING id::text`, orgID, title, updatedAt, folder).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	olderID := seed(fx.orgID, "Older proof", "Archive", updated.Add(-time.Hour))
	newerID := seed(fx.orgID, "Newest proof", "Finance", updated)
	foreignID := seed(fx.otherOrgID, "Foreign proof", "Private", updated.Add(time.Hour))
	for _, version := range []struct {
		orgID, documentID string
		number            int
	}{
		{fx.orgID, newerID, 1}, {fx.orgID, newerID, 2}, {fx.otherOrgID, foreignID, 1},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO authored_doc_versions (org_id, document_id, version, content_json, html, created_by_actor_type)
			VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, '', 'human')`, version.orgID, version.documentID, version.number); err != nil {
			t.Fatal(err)
		}
	}

	result, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, documentsListDocsCapabilityID, "documents.read", input, "human", "", "docs-list-read"), documentsListDocsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("documents.listDocs result=%+v err=%v", result, err)
	}
	var output ListAuthoredDocsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode documents.listDocs output %s: %v", result.Data, err)
	}
	want := []AuthoredDocumentRow{
		{ID: newerID, Title: "Newest proof", Status: "draft", Versions: 2, Folder: stringPointer("Finance"), DocumentType: stringPointer("invoice"), LinkedRecordType: stringPointer("customer"), LinkedRecordLabel: stringPointer("Acme"), UpdatedAt: "2026-09-09T12:30:15.123Z"},
		{ID: olderID, Title: "Older proof", Status: "draft", Versions: 0, Folder: stringPointer("Archive"), DocumentType: stringPointer("invoice"), LinkedRecordType: stringPointer("customer"), LinkedRecordLabel: stringPointer("Acme"), UpdatedAt: "2026-09-09T11:30:15.123Z"},
	}
	if !reflect.DeepEqual(output.Documents, want) {
		t.Fatalf("documents=%+v, want ordered organization documents with exact metadata and version counts %+v", output.Documents, want)
	}
}
