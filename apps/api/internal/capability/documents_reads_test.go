package capability

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestIngestedDocumentsReadCapabilityContract(t *testing.T) {
	capabilityID := documentsListIngestedCapabilityID
	spec, exists := capabilitySpecs[capabilityID]
	if !supportedCapability(capabilityID) || !exists || spec.module != "documents" || spec.permission != "documents.read" || spec.risk != "read" {
		t.Fatalf("%s spec=%+v supported=%t, want documents.read read capability", capabilityID, spec, supportedCapability(capabilityID))
	}
	for _, raw := range []json.RawMessage{json.RawMessage(`{}`), json.RawMessage(`{"preview":true,"id":"11111111-1111-4111-8111-111111111111"}`)} {
		if _, err := ParseIngestedDocumentsInput(raw); err != nil {
			t.Errorf("parse valid input %s: %v", raw, err)
		}
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`[]`), json.RawMessage(`null`), json.RawMessage(`{} {}`),
		json.RawMessage(`{"id":7}`), json.RawMessage(`{"id":"bad"}`),
		json.RawMessage(`{"preview":"yes"}`), json.RawMessage(`{"preview":true}`),
		json.RawMessage(`{"unexpected":true}`),
	} {
		if _, err := ParseIngestedDocumentsInput(raw); err == nil {
			t.Errorf("accepted invalid input %s", raw)
		}
	}
}

func TestGoIngestedDocumentsReadPreservesProjectionOrderTenantAndPreview(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "documents.read")
	created := time.Date(2026, 9, 9, 12, 30, 15, 123000000, time.UTC)
	insertDocument := func(orgID, title, source string, createdAt time.Time) string {
		t.Helper()
		var id string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO documents (org_id, title, source_type, status, created_by_actor_type, raw_text, content_base64, parsed_markdown, created_at)
			VALUES ($1::uuid, $2, $3, 'parsed', 'human', 'private raw text', 'c2VjcmV0', '# Extracted', $4)
			RETURNING id::text`, orgID, title, source, createdAt).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	newerID := insertDocument(fx.orgID, "New receipt", "upload", created)
	olderID := insertDocument(fx.orgID, "Old invoice", "text", created.Add(-time.Hour))
	foreignID := insertDocument(fx.otherOrgID, "Foreign record", "text", created.Add(time.Hour))
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Local Vendor') RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Foreign Vendor')`, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	var suggestionID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO document_suggestions (org_id, document_id, description, suggested_account_code, matched_on, created_at)
		VALUES ($1::uuid, $2::uuid, 'Paper', '6100', '["vendor"]'::jsonb, $3)
		RETURNING id::text`, fx.orgID, newerID, created).Scan(&suggestionID); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{}`)
	claims := waveModuleClaims(fx, documentsListIngestedCapabilityID, "documents.read", input, "human", "", "ingested-doc-list")
	claims.Permissions = []string{"documents.write"}
	denied, err := fx.executor.Execute(fx.ctx, claims, documentsListIngestedCapabilityID, input)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: documents.read" {
		t.Fatalf("read without documents.read result=%+v err=%v", denied, err)
	}
	result, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, documentsListIngestedCapabilityID, "documents.read", input, "human", "", "ingested-doc-list"), documentsListIngestedCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("ingested list result=%+v err=%v", result, err)
	}
	var list IngestedDocumentsOutput
	if err := json.Unmarshal(result.Data, &list); err != nil {
		t.Fatalf("decode list response %s: %v", result.Data, err)
	}
	wantList := []IngestedDocumentRow{
		{ID: newerID, Title: "New receipt", Status: "parsed", SourceType: "upload", CreatedAt: "2026-09-09T12:30:15.123Z"},
		{ID: olderID, Title: "Old invoice", Status: "parsed", SourceType: "text", CreatedAt: "2026-09-09T11:30:15.123Z"},
	}
	if !reflect.DeepEqual(list.Documents, wantList) || !reflect.DeepEqual(list.Vendors, []IngestedVendorRow{{ID: vendorID, Name: "Local Vendor"}}) {
		t.Fatalf("list=%+v, want tenant-scoped ordered rows and vendor list", list)
	}
	if string(result.Data) == "" || strings.Contains(string(result.Data), "private raw text") || strings.Contains(string(result.Data), "c2VjcmV0") {
		t.Fatalf("list response exposed private source material: %s", result.Data)
	}

	for _, preview := range []bool{true, false} {
		detailInput, _ := json.Marshal(IngestedDocumentsInput{ID: &newerID, Preview: preview})
		intentID := "ingested-doc-detail-preview"
		if !preview {
			intentID = "ingested-doc-detail-full"
		}
		detailResult, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, documentsListIngestedCapabilityID, "documents.read", detailInput, "human", "", intentID), documentsListIngestedCapabilityID, detailInput)
		if err != nil || !detailResult.OK {
			t.Fatalf("detail preview=%t result=%+v err=%v", preview, detailResult, err)
		}
		var detail IngestedDocumentsOutput
		if err := json.Unmarshal(detailResult.Data, &detail); err != nil {
			t.Fatalf("decode detail response %s: %v", detailResult.Data, err)
		}
		if detail.Document == nil || detail.Document.ID != newerID || detail.Document.CreatedAt != "2026-09-09T12:30:15.123Z" {
			t.Fatalf("detail=%+v, want scoped detail projection", detail)
		}
		if strings.Contains(string(detailResult.Data), "private raw text") || strings.Contains(string(detailResult.Data), "c2VjcmV0") {
			t.Fatalf("detail response exposed raw source material: %s", detailResult.Data)
		}
		if preview {
			if len(detail.Document.Suggestions) != 0 || strings.Contains(string(detailResult.Data), "suggestions") {
				t.Fatalf("preview response must omit suggestions: %s", detailResult.Data)
			}
		} else if len(detail.Document.Suggestions) != 1 || detail.Document.Suggestions[0].ID != suggestionID {
			t.Fatalf("full detail should include ordered suggestions: %+v", detail.Document.Suggestions)
		}
	}
	foreignInput, _ := json.Marshal(IngestedDocumentsInput{ID: &foreignID, Preview: true})
	foreign, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, documentsListIngestedCapabilityID, "documents.read", foreignInput, "human", "", "ingested-doc-foreign"), documentsListIngestedCapabilityID, foreignInput)
	if err != nil || foreign.OK || foreign.Error != ErrIngestedDocumentNotFound.Error() {
		t.Fatalf("foreign detail=%+v err=%v, want not found", foreign, err)
	}
}

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
