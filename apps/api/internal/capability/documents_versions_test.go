package capability

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestDocumentVersionParsersAndCapabilityContracts(t *testing.T) {
	documentID := "11111111-1111-4111-8111-111111111111"
	listInput, err := ParseListDocumentVersionsInput(json.RawMessage(`{"documentId":"` + documentID + `","ignored":true}`))
	if err != nil || listInput.DocumentID != documentID {
		t.Fatalf("ParseListDocumentVersionsInput() = %+v, %v", listInput, err)
	}
	listHash, err := canonicalInputHash(listInput)
	if err != nil {
		t.Fatal(err)
	}
	wantListHash, err := InputHash(json.RawMessage(`{"documentId":"` + documentID + `"}`))
	if err != nil || listHash != wantListHash {
		t.Fatalf("list-version canonical hash = %s, %v; want raw input hash %s", listHash, err, wantListHash)
	}
	getInput, err := ParseDocumentVersionIDInput(json.RawMessage(`{"documentId":"` + documentID + `","version":2,"ignored":true}`))
	if err != nil || getInput.DocumentID != documentID || getInput.Version != 2 {
		t.Fatalf("ParseDocumentVersionIDInput() = %+v, %v", getInput, err)
	}
	for _, raw := range []string{
		`{}`, `[]`, `{"documentId":"bad","version":1}`,
		`{"documentId":"` + documentID + `","version":0}`,
		`{"documentId":"` + documentID + `","version":1.5}`,
		`{"documentId":"` + documentID + `","version":9007199254740992}`,
	} {
		if _, err := ParseDocumentVersionIDInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseDocumentVersionIDInput accepted %s", raw)
		}
	}
	for capabilityID, permission := range map[string]string{
		documentsListDocVersionsCapabilityID: "documents.read",
		documentsGetDocVersionCapabilityID:   "documents.read",
	} {
		spec, ok := capabilitySpecs[capabilityID]
		if !ok || !supportedCapability(capabilityID) || spec.module != "documents" || spec.permission != permission || spec.risk != "read" {
			t.Errorf("capability %s spec=%+v supported=%t", capabilityID, spec, supportedCapability(capabilityID))
		}
		if got, ok := permissionForCapability(capabilityID); !ok || got != permission {
			t.Errorf("permissionForCapability(%s) = %q, %t", capabilityID, got, ok)
		}
	}
}

func TestGoDocumentVersionReadsPreserveOrderContentAndTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "documents.read")
	t.Cleanup(func() {
		_, err := fx.owner.Exec(fx.ctx, `DELETE FROM authored_doc_versions WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID)
		if err != nil {
			t.Errorf("clean up document versions fixture: %v", err)
			return
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM authored_docs WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("clean up authored documents fixture: %v", err)
		}
	})

	seedDoc := func(orgID, title string) string {
		t.Helper()
		var id string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO authored_docs (org_id, title, content_json, html, status, created_by_actor_type)
			VALUES ($1::uuid, $2, '{}'::jsonb, '<p>current</p>', 'published', 'human')
			RETURNING id::text`, orgID, title).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	localDoc := seedDoc(fx.orgID, "Versioned proof")
	foreignDoc := seedDoc(fx.otherOrgID, "Foreign proof")
	humanID := fx.userID
	createdAt := time.Date(2026, 9, 30, 10, 11, 12, 345678000, time.UTC)
	for _, version := range []struct {
		orgID, documentID, html, actorType string
		number                             int
		note                               *string
		actorID                            *string
	}{
		{fx.orgID, localDoc, "<p>first</p>", "human", 1, stringPointer("initial"), &humanID},
		{fx.orgID, localDoc, "<p>second</p>", "agent", 2, nil, nil},
		{fx.otherOrgID, foreignDoc, "<p>secret</p>", "human", 1, stringPointer("foreign"), &humanID},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO authored_doc_versions (org_id, document_id, version, content_json, html, note, created_by_actor_type, created_by_actor_id, created_at)
			VALUES ($1::uuid, $2::uuid, $3::integer, jsonb_build_object('version', $3::integer), $4, $5, $6, $7::uuid, $8)`,
			version.orgID, version.documentID, version.number, version.html, version.note, version.actorType, version.actorID, createdAt); err != nil {
			t.Fatal(err)
		}
	}

	listRaw := json.RawMessage(`{"documentId":"` + localDoc + `"}`)
	listResult, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, documentsListDocVersionsCapabilityID, "documents.read", listRaw, "human", "", "docs-version-list"),
		documentsListDocVersionsCapabilityID, listRaw)
	if err != nil || !listResult.OK {
		t.Fatalf("list document versions result=%+v err=%v", listResult, err)
	}
	var listed ListDocumentVersionsOutput
	if err := json.Unmarshal(listResult.Data, &listed); err != nil {
		t.Fatalf("decode document version list: %v", err)
	}
	wantListed := ListDocumentVersionsOutput{Versions: []DocumentVersionSummary{
		{Version: 1, Note: stringPointer("initial"), CreatedBy: &humanID, CreatedAt: "2026-09-30T10:11:12.345Z"},
		{Version: 2, Note: nil, CreatedBy: stringPointer("workmate"), CreatedAt: "2026-09-30T10:11:12.345Z"},
	}}
	if !reflect.DeepEqual(listed, wantListed) {
		t.Fatalf("listed versions=%+v, want %+v", listed, wantListed)
	}

	getRaw := json.RawMessage(`{"documentId":"` + localDoc + `","version":2}`)
	getResult, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, documentsGetDocVersionCapabilityID, "documents.read", getRaw, "human", "", "docs-version-get"),
		documentsGetDocVersionCapabilityID, getRaw)
	if err != nil || !getResult.OK {
		t.Fatalf("get document version result=%+v err=%v", getResult, err)
	}
	var fetched GetDocumentVersionOutput
	if err := json.Unmarshal(getResult.Data, &fetched); err != nil {
		t.Fatalf("decode document version: %v", err)
	}
	var fetchedContent map[string]int
	if err := json.Unmarshal(fetched.Content, &fetchedContent); err != nil {
		t.Fatalf("decode document version content: %v", err)
	}
	if fetched.Version != 2 || fetchedContent["version"] != 2 || fetched.HTML != "<p>second</p>" || fetched.Note != nil || fetched.CreatedAt != "2026-09-30T10:11:12.345Z" {
		t.Fatalf("fetched version=%+v, want exact content, html, note, and ISO timestamp", fetched)
	}

	foreignRaw := json.RawMessage(`{"documentId":"` + foreignDoc + `","version":1}`)
	foreign, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, documentsGetDocVersionCapabilityID, "documents.read", foreignRaw, "human", "", "docs-version-foreign"),
		documentsGetDocVersionCapabilityID, foreignRaw)
	if err != nil || foreign.OK || foreign.Error != "no version 1" {
		t.Fatalf("foreign document version result=%+v err=%v, want an org-scoped not-found result", foreign, err)
	}
}
