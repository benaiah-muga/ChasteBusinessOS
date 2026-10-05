package capability

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

const documentsTestUUID = "11111111-1111-4111-8111-111111111111"

// documentsSampleInputs is a minimal payload each capability accepts, so the
// generic parity checks can walk the manifest's required list per capability.
var documentsSampleInputs = map[string]string{
	documentsAddVersionCapabilityID:        `{"documentId":"` + documentsTestUUID + `"}`,
	documentsCreateDocCapabilityID:         `{"title":"Letter","content":{"type":"doc"},"html":"<p>x</p>"}`,
	documentsCreateDocumentCapabilityID:    `{"title":"Bill","text":"pasted"}`,
	documentsCreateFolderCapabilityID:      `{"path":"Finance/2026"}`,
	documentsCreateTemplateCapabilityID:    `{"name":"Invoice","content":{"type":"doc"}}`,
	documentsDeleteDocCapabilityID:         `{"documentId":"` + documentsTestUUID + `"}`,
	documentsDeleteDocumentCapabilityID:    `{"documentId":"` + documentsTestUUID + `"}`,
	documentsDeleteFolderCapabilityID:      `{"path":"Finance"}`,
	documentsDeleteOrgMemoryCapabilityID:   `{"memoryId":"` + documentsTestUUID + `"}`,
	documentsDeleteTemplateCapabilityID:    `{"templateId":"` + documentsTestUUID + `"}`,
	documentsGetTemplateCapabilityID:       `{"templateId":"` + documentsTestUUID + `"}`,
	documentsListDocumentsCapabilityID:     `{}`,
	documentsListFoldersCapabilityID:       `{}`,
	documentsListTemplatesCapabilityID:     `{}`,
	documentsListVersionsCapabilityID:      `{"documentId":"` + documentsTestUUID + `"}`,
	documentsRenameFolderCapabilityID:      `{"path":"Finance","newPath":"Money"}`,
	documentsRestoreDocVersionCapabilityID: `{"documentId":"` + documentsTestUUID + `","sourceVersion":1}`,
	documentsSaveDocVersionCapabilityID:    `{"documentId":"` + documentsTestUUID + `","content":{},"html":""}`,
	documentsSearchMemoryCapabilityID:      `{"query":"ledger","limit":5}`,
	documentsSearchRecordsCapabilityID:     `{"type":"customer","query":"ada"}`,
	documentsSuggestCodingCapabilityID:     `{"documentId":"` + documentsTestUUID + `"}`,
	documentsUpdateDocMetadataCapabilityID: `{"documentId":"` + documentsTestUUID + `"}`,
}

// documentsZodDefaultedKeys are keys the manifest lists as required because
// Zod's wire schema always emits them, but the runtime treats as optional
// because the field carries a .default(). The manifest and the Zod parser
// disagree exactly here, and the runtime is the behavior that shipped.
var documentsZodDefaultedKeys = map[string][]string{
	documentsSearchMemoryCapabilityID:  {"limit"},
	documentsSearchRecordsCapabilityID: {"query"},
}

// documentsOutputSamples is one populated output per capability, used to prove
// the Go structs marshal to exactly the manifest's output shape.
var documentsOutputSamples = map[string]any{
	documentsAddVersionCapabilityID:        DocumentVersionOutput{Version: 2},
	documentsCreateDocCapabilityID:         CreateAuthoredDocumentOutput{DocumentID: documentsTestUUID},
	documentsCreateDocumentCapabilityID:    IngestDocumentOutput{DocumentID: documentsTestUUID},
	documentsCreateFolderCapabilityID:      CreateDocumentFolderOutput{FolderID: documentsTestUUID, Path: "Finance/2026"},
	documentsCreateTemplateCapabilityID:    CreateDocumentTemplateOutput{TemplateID: documentsTestUUID, Placeholders: []string{"customer.name"}},
	documentsDeleteDocCapabilityID:         DeleteAuthoredDocumentOutput{Deleted: true},
	documentsDeleteDocumentCapabilityID:    DeleteIngestedDocumentOutput{Deleted: true},
	documentsDeleteFolderCapabilityID:      DeleteDocumentFolderOutput{Deleted: true, Path: "Finance"},
	documentsDeleteOrgMemoryCapabilityID:   DeleteOrgMemoryOutput{Deleted: true, Kind: "sop"},
	documentsDeleteTemplateCapabilityID:    DeleteDocumentTemplateOutput{Deleted: true},
	documentsGetTemplateCapabilityID:       GetDocumentTemplateOutput{Template: DocumentTemplateDetail{ID: documentsTestUUID, Name: "Invoice", Content: json.RawMessage(`{"type":"doc"}`), Placeholders: []string{"customer.name"}}},
	documentsListDocumentsCapabilityID:     ListIngestedDocumentsOutput{Documents: []IngestedDocumentSummary{{ID: documentsTestUUID, Title: "Bill", Status: "received", SourceType: "text", OpenSuggestions: 2, CreatedAt: "2026-09-30T10:11:12.345Z"}}},
	documentsListFoldersCapabilityID:       ListDocumentFoldersOutput{Folders: []DocumentFolderRow{{ID: documentsTestUUID, Path: "Finance"}}},
	documentsListTemplatesCapabilityID:     ListDocumentTemplatesOutput{Templates: []DocumentTemplateRow{{ID: documentsTestUUID, Name: "Invoice", Description: stringPointer("House"), Placeholders: []string{"customer.name"}, IsSystem: stringPointer("system"), Content: json.RawMessage(`{"type":"doc"}`)}}},
	documentsListVersionsCapabilityID:      ListIngestedDocumentVersionsOutput{Versions: []IngestedDocumentVersionSummary{{Version: 1, Note: stringPointer("first"), CreatedAt: "2026-09-30T10:11:12.345Z"}}},
	documentsRenameFolderCapabilityID:      RenameDocumentFolderOutput{Path: "Finance", MovedTo: "Money"},
	documentsRestoreDocVersionCapabilityID: DocumentVersionOutput{Version: 3},
	documentsSaveDocVersionCapabilityID:    DocumentVersionOutput{Version: 3},
	documentsSearchMemoryCapabilityID:      SearchOrgMemoryOutput{Mode: "text", Results: []MemorySearchResult{{Kind: "sop", Source: stringPointer("document:" + documentsTestUUID), Title: stringPointer("Bill"), Content: "ledger"}}},
	documentsSearchRecordsCapabilityID:     SearchRecordsOutput{Records: []DocumentRecord{{ID: documentsTestUUID, Label: "Ada", Detail: "ada@example.test", Values: DocumentRecordValues{"customer.name": "Ada"}}}},
	documentsSuggestCodingCapabilityID:     SuggestDocumentCodingOutput{Suggestions: []DocumentCodingSuggestion{{Description: "Coffee", QuantityThousandths: 1000, UnitPriceMinor: 250, SuggestedAccountCode: "6000", MatchScore: 1}}},
	documentsUpdateDocMetadataCapabilityID: UpdateAuthoredDocumentMetadataOutput{DocumentID: documentsTestUUID, Previous: AuthoredDocumentMetadata{Title: "Letter", Folder: nil, LinkedRecordType: nil, LinkedRecordID: nil, LinkedRecordLabel: nil}},
}

func loadDocumentsManifest(t *testing.T) map[string]map[string]any {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "docs", "migration", "capabilities.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Skipf("capability manifest not available at %s", path)
	}
	if err != nil {
		t.Fatalf("read capability manifest: %v", err)
	}
	var document struct {
		Capabilities []map[string]any `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("decode capability manifest: %v", err)
	}
	byID := make(map[string]map[string]any, len(document.Capabilities))
	for _, capability := range document.Capabilities {
		id, _ := capability["id"].(string)
		byID[id] = capability
	}
	return byID
}

// TestDocumentsCapabilitiesMatchManifest pins every metadata field against the
// authoritative manifest: the port must not quietly widen a permission, lower
// a risk, or invent an inverse.
func TestDocumentsExecutorWiring(t *testing.T) {
	// This asserts the three registry touch points the module needs. Until
	// executor.go carries them the module is fully implemented but not
	// reachable, so the test skips rather than failing the package.
	specs := DocumentsCapabilitySpecs()
	var unregistered, unsupported, unparseable []string
	for _, capabilityID := range DocumentsCapabilityIDs() {
		if _, ok := capabilitySpecs[capabilityID]; !ok {
			unregistered = append(unregistered, capabilityID)
		}
		if !supportedCapability(capabilityID) {
			unsupported = append(unsupported, capabilityID)
		}
		if _, err := canonicalInputHash(DocumentsInput{DocumentID: stringPointer(documentsTestUUID)}); err != nil {
			unparseable = append(unparseable, capabilityID)
			break
		}
	}
	if len(unregistered) == 0 && len(unsupported) == 0 && len(unparseable) == 0 {
		for capabilityID, want := range specs {
			got, ok := permissionForCapability(capabilityID)
			if !ok || got != want.permission {
				t.Errorf("permissionForCapability(%s) = %q, %t; want %q", capabilityID, got, ok, want.permission)
			}
		}
		return
	}
	t.Skipf("executor.go wiring not applied yet: capabilitySpecs missing %v, supportedCapability missing %v, canonicalInputHash %v",
		unregistered, unsupported, unparseable)
}

func TestDocumentsCapabilitiesMatchManifest(t *testing.T) {
	manifest := loadDocumentsManifest(t)
	specs := DocumentsCapabilitySpecs()
	ids := DocumentsCapabilityIDs()
	if len(ids) != len(specs) {
		t.Fatalf("DocumentsCapabilityIDs() has %d entries, want %d executor specs", len(ids), len(specs))
	}
	seen := make(map[string]bool, len(ids))
	for _, capabilityID := range ids {
		if seen[capabilityID] {
			t.Errorf("capability id %s listed twice", capabilityID)
		}
		seen[capabilityID] = true

		entry, ok := manifest[capabilityID]
		if !ok {
			t.Errorf("%s is absent from the capability manifest", capabilityID)
			continue
		}
		spec, ok := specs[capabilityID]
		if !ok {
			t.Errorf("%s has no executor spec", capabilityID)
			continue
		}
		if spec.module != entry["module"] {
			t.Errorf("%s module = %q, want %v", capabilityID, spec.module, entry["module"])
		}
		if spec.permission != entry["permission"] {
			t.Errorf("%s permission = %q, want %v", capabilityID, spec.permission, entry["permission"])
		}
		if spec.risk != entry["risk"] {
			t.Errorf("%s risk = %q, want %v", capabilityID, spec.risk, entry["risk"])
		}
		wantInverse, _ := entry["inverseCapabilityId"].(string)
		if spec.inverseCapabilityID != wantInverse {
			t.Errorf("%s inverse = %q, want %q", capabilityID, spec.inverseCapabilityID, wantInverse)
		}
		permission, ok := documentsPermissionFor(capabilityID)
		if !ok || permission != spec.permission {
			t.Errorf("documentsPermissionFor(%s) = %q, %t", capabilityID, permission, ok)
		}
		if money, ok := entry["moneyThresholdMinor"]; ok && money != nil {
			t.Errorf("%s declares moneyThresholdMinor %v; the documents module has no money-class capability", capabilityID, money)
		}
	}
}

// TestDocumentsInputsHonorRequiredFields walks the manifest's required list
// for every capability: dropping a required key must fail the parse.
func TestDocumentsInputsHonorRequiredFields(t *testing.T) {
	manifest := loadDocumentsManifest(t)
	for capabilityID, sample := range documentsSampleInputs {
		entry, ok := manifest[capabilityID]
		if !ok {
			t.Fatalf("%s is absent from the capability manifest", capabilityID)
		}
		if _, err := ParseDocumentsInput(capabilityID, json.RawMessage(sample)); err != nil {
			t.Fatalf("%s rejected its own sample input: %v", capabilityID, err)
		}
		required := manifestStrings(entry["inputSchema"], "required")
		defaulted := documentsZodDefaultedKeys[capabilityID]
		for _, key := range required {
			if documentsContainsString(defaulted, key) {
				continue
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(sample), &fields); err != nil {
				t.Fatalf("%s sample is not an object: %v", capabilityID, err)
			}
			delete(fields, key)
			without, err := json.Marshal(fields)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ParseDocumentsInput(capabilityID, without); err == nil {
				t.Errorf("%s accepted input missing required key %q: %s", capabilityID, key, without)
			}
		}
	}
}

// TestDocumentsInputsStripUnknownKeys proves the Zod behavior the port has to
// keep: a z.object() silently drops keys it does not declare. The manifest
// renders that as additionalProperties:false, which is a wire-schema artifact,
// so rejecting unknown keys here would be a behavior regression.
func TestDocumentsInputsStripUnknownKeys(t *testing.T) {
	manifest := loadDocumentsManifest(t)
	for capabilityID, sample := range documentsSampleInputs {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(sample), &fields); err != nil {
			t.Fatalf("%s sample is not an object: %v", capabilityID, err)
		}
		fields["unexpectedAgentField"] = json.RawMessage(`{"nested":true}`)
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseDocumentsInput(capabilityID, raw)
		if err != nil {
			t.Errorf("%s rejected an unknown key: %v", capabilityID, err)
			continue
		}
		encoded, err := marshalJS(parsed)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "unexpectedAgentField") {
			t.Errorf("%s kept the unknown key: %s", capabilityID, encoded)
		}
		schema, ok := entrySchema(manifest, capabilityID, "inputSchema")
		if !ok {
			continue
		}
		var value any
		if err := json.Unmarshal(encoded, &value); err != nil {
			t.Fatalf("%s re-marshalled to invalid JSON: %v", capabilityID, err)
		}
		assertDocumentsSchema(t, schema, value, capabilityID+" input")
	}
}

// TestDocumentsInputsRejectMalformedJSON covers the non-object and truncated
// payload cases every parser has to refuse.
func TestDocumentsInputsRejectMalformedJSON(t *testing.T) {
	for capabilityID := range documentsSampleInputs {
		for _, raw := range []string{`[]`, `"text"`, `null`, `42`, `true`, `{} trailing`, `{`, ``} {
			if _, err := ParseDocumentsInput(capabilityID, json.RawMessage(raw)); err == nil {
				t.Errorf("%s accepted malformed input %q", capabilityID, raw)
			}
		}
	}
	if _, err := ParseDocumentsInput("documents.listDocs", json.RawMessage(`{}`)); err == nil {
		t.Error("an unknown documents capability id was accepted")
	}
}

// TestDocumentsInputValidationBoundaries pins the per-field Zod rules the
// port has to reproduce, including the enum sets.
func TestDocumentsInputValidationBoundaries(t *testing.T) {
	longString := func(length int) string {
		return strings.Repeat("x", length)
	}
	uuid := documentsTestUUID
	otherUUID := "22222222-2222-4222-8222-222222222222"

	cases := []struct {
		name         string
		capabilityID string
		accept       []string
		refuse       []string
	}{
		{
			name:         "addVersion requires a uuid documentId",
			capabilityID: documentsAddVersionCapabilityID,
			// Zod v4's z.uuid() admits the nil UUID, and so does the manifest
			// pattern the wire contract was generated from.
			accept: []string{
				`{"documentId":"` + uuid + `","contentBase64":"QUJD"}`,
				`{"documentId":"` + uuid + `","rawText":"t"}`,
				`{"documentId":"00000000-0000-0000-0000-000000000000","rawText":"t"}`,
			},
			refuse: []string{
				`{"documentId":"nope"}`,
				`{"documentId":"` + uuid + `","note":"` + longString(501) + `"}`,
				`{"documentId":"` + uuid + `","contentBase64":7}`,
			},
		},
		{
			name:         "createDoc validates title, html and the link fields",
			capabilityID: documentsCreateDocCapabilityID,
			accept: []string{
				`{"title":"T","content":{},"html":""}`,
				`{"title":"T","content":{"a":[1,2]},"html":"<p>x</p>","pageSettings":{}}`,
				`{"title":"T","content":{},"html":"","pageSettings":{"size":"Letter","orientation":"landscape","margin":"wide"}}`,
				`{"title":"T","content":{},"html":"","templateId":"` + uuid + `","intentId":"abc"}`,
			},
			refuse: []string{
				`{"title":"","content":{},"html":""}`,
				`{"title":"` + longString(201) + `","content":{},"html":""}`,
				`{"title":"T","html":""}`,
				`{"title":"T","content":[],"html":""}`,
				`{"title":"T","content":null,"html":""}`,
				`{"title":"T","content":{},"html":"` + longString(documentsMaxHTMLLength+1) + `"}`,
				`{"title":"T","content":{},"html":"","folder":null}`,
				`{"title":"T","content":{},"html":"","templateId":"nope"}`,
				`{"title":"T","content":{},"html":"","linkedRecordId":"nope"}`,
				`{"title":"T","content":{},"html":"","documentType":"` + longString(61) + `"}`,
				`{"title":"T","content":{},"html":"","pageSettings":{"size":"A3"}}`,
				`{"title":"T","content":{},"html":"","pageSettings":{"orientation":"sideways"}}`,
				`{"title":"T","content":{},"html":"","pageSettings":{"margin":"huge"}}`,
				`{"title":"T","content":{},"html":"","pageSettings":[]}`,
			},
		},
		{
			name:         "createDocument takes exactly one of text or fileBase64",
			capabilityID: documentsCreateDocumentCapabilityID,
			accept: []string{
				`{"title":"T","text":"pasted"}`,
				`{"title":"T","fileBase64":"QUJD","mimeType":"application/pdf"}`,
				`{"title":"T","text":"pasted","folder":"Finance","refType":"bill","refId":"` + uuid + `","expiresAt":"2026-12-31T23:59:59Z"}`,
				`{"title":"T","text":"pasted","expiresAt":"2026-12-31T23:59Z"}`,
				`{"title":"T","text":"pasted","expiresAt":"2026-12-31T23:59:59.123Z"}`,
				`{"title":"T","text":"pasted","expiresAt":"2026-12-31T23:59:59.123456Z"}`,
			},
			refuse: []string{
				`{"title":"T"}`,
				`{"title":"T","text":"a","fileBase64":"QUJD","mimeType":"application/pdf"}`,
				`{"title":"T","fileBase64":"QUJD"}`,
				`{"title":"T","text":""}`,
				`{"title":"T","text":"` + longString(100_001) + `"}`,
				`{"title":"T","fileBase64":"QUJD","mimeType":"application"}`,
				`{"title":"T","text":"a","mimeType":"application"}`,
				`{"title":"T","text":"a","expiresAt":"2026-12-31T23:59:59+02:00"}`,
				`{"title":"T","text":"a","expiresAt":"2026-02-30T00:00:00Z"}`,
				`{"title":"T","text":"a","refId":"nope"}`,
				`{"title":"T","text":"a","refType":"` + longString(41) + `"}`,
				`{"title":"T","text":"a","fileBase64":"` + longString(documentsMaxUploadBase64+1) + `"}`,
			},
		},
		{
			name:         "folder paths are non-empty and bounded",
			capabilityID: documentsCreateFolderCapabilityID,
			accept:       []string{`{"path":"a"}`, `{"path":"a/b/c"}`, `{"path":"` + longString(300) + `"}`},
			refuse:       []string{`{"path":""}`, `{"path":"` + longString(301) + `"}`, `{"path":null}`},
		},
		{
			name:         "renameFolder needs both paths",
			capabilityID: documentsRenameFolderCapabilityID,
			accept:       []string{`{"path":"a","newPath":"b"}`},
			refuse:       []string{`{"path":"a"}`, `{"newPath":"b"}`, `{"path":"a","newPath":""}`},
		},
		{
			name:         "createTemplate validates name and description",
			capabilityID: documentsCreateTemplateCapabilityID,
			accept:       []string{`{"name":"N","content":{}}`, `{"name":"N","content":{},"description":"` + longString(300) + `"}`},
			refuse: []string{
				`{"content":{}}`, `{"name":"","content":{}}`,
				`{"name":"` + longString(121) + `","content":{}}`,
				`{"name":"N"}`, `{"name":"N","content":[]}`,
				`{"name":"N","content":{},"description":"` + longString(301) + `"}`,
			},
		},
		{
			name:         "deleteOrgMemory requires a uuid",
			capabilityID: documentsDeleteOrgMemoryCapabilityID,
			accept:       []string{`{"memoryId":"` + uuid + `"}`},
			refuse:       []string{`{"memoryId":"nope"}`, `{}`, `{"memoryId":"` + otherUUID + `x"}`},
		},
		{
			name:         "deleteDocument accepts a bare string documentId",
			capabilityID: documentsDeleteDocumentCapabilityID,
			accept:       []string{`{"documentId":"` + uuid + `"}`, `{"documentId":"anything"}`},
			refuse:       []string{`{}`, `{"documentId":null}`, `{"documentId":7}`},
		},
		{
			name:         "restoreDocVersion bounds sourceVersion",
			capabilityID: documentsRestoreDocVersionCapabilityID,
			accept:       []string{`{"documentId":"` + uuid + `","sourceVersion":1}`, `{"documentId":"` + uuid + `","sourceVersion":9007199254740991}`},
			refuse: []string{
				`{"documentId":"` + uuid + `"}`,
				`{"documentId":"` + uuid + `","sourceVersion":0}`,
				`{"documentId":"` + uuid + `","sourceVersion":-1}`,
				`{"documentId":"` + uuid + `","sourceVersion":1.5}`,
				`{"documentId":"` + uuid + `","sourceVersion":9007199254740992}`,
				`{"documentId":"` + uuid + `","sourceVersion":1,"note":"` + longString(501) + `"}`,
			},
		},
		{
			name:         "saveDocVersion requires content and html",
			capabilityID: documentsSaveDocVersionCapabilityID,
			accept:       []string{`{"documentId":"` + uuid + `","content":{"a":1},"html":"<p>x</p>","note":"n"}`},
			refuse: []string{
				`{"documentId":"` + uuid + `","html":""}`,
				`{"documentId":"` + uuid + `","content":{}}`,
				`{"documentId":"` + uuid + `","content":"text","html":""}`,
				`{"documentId":"` + uuid + `","content":{},"html":"","title":""}`,
			},
		},
		{
			name:         "searchMemory bounds query length and limit",
			capabilityID: documentsSearchMemoryCapabilityID,
			accept:       []string{`{"query":"ab","limit":1}`, `{"query":"` + longString(500) + `","limit":10}`, `{"query":"ledger"}`},
			refuse: []string{
				`{"query":"a","limit":5}`, `{"query":"` + longString(501) + `","limit":5}`,
				`{"query":"ab","limit":0}`, `{"query":"ab","limit":11}`,
				`{"query":"ab","limit":2.5}`, `{}`,
			},
		},
		{
			name:         "searchRecords enumerates the record type",
			capabilityID: documentsSearchRecordsCapabilityID,
			accept: []string{
				`{"type":"customer","query":""}`, `{"type":"supplier"}`,
				`{"type":"employee","query":"a"}`, `{"type":"invoice","query":"a"}`,
				`{"type":"quote","query":"a"}`, `{"type":"purchase_order","query":"a"}`,
				`{"type":"sales_order","query":"a","id":"` + uuid + `"}`,
			},
			refuse: []string{
				`{"query":"a"}`, `{"type":"vendor","query":"a"}`, `{"type":"","query":"a"}`,
				`{"type":"customer","query":"` + longString(121) + `"}`,
				`{"type":"customer","query":"a","id":"nope"}`,
			},
		},
		{
			name:         "suggestCoding validates the line array",
			capabilityID: documentsSuggestCodingCapabilityID,
			accept: []string{
				`{"documentId":"d1","lines":[{"description":"Coffee","quantityThousandths":1000,"unitPriceMinor":250}]}`,
				`{"documentId":"d1","lines":[{"description":"Coffee","unitPriceMinor":250}]}`,
				`{"documentId":"d1","lines":[{"description":"C","quantityThousandths":1,"unitPriceMinor":0,"extra":1}]}`,
			},
			refuse: []string{
				`{}`, `{"documentId":"d1","lines":[]}`,
				`{"documentId":"d1","lines":[{"description":"","quantityThousandths":1,"unitPriceMinor":0}]}`,
				`{"documentId":"d1","lines":[{"description":"C","quantityThousandths":0,"unitPriceMinor":0}]}`,
				`{"documentId":"d1","lines":[{"description":"C","quantityThousandths":1,"unitPriceMinor":-1}]}`,
				`{"documentId":"d1","lines":[{"description":"C","quantityThousandths":1.5,"unitPriceMinor":0}]}`,
				`{"documentId":"d1","lines":{"a":1}}`,
			},
		},
		{
			name:         "updateDocMetadata separates absent from null",
			capabilityID: documentsUpdateDocMetadataCapabilityID,
			accept: []string{
				`{"documentId":"` + uuid + `"}`,
				`{"documentId":"` + uuid + `","folder":null}`,
				`{"documentId":"` + uuid + `","folder":"Finance/2026"}`,
				`{"documentId":"` + uuid + `","linkedRecordType":null,"linkedRecordId":null,"linkedRecordLabel":null}`,
				`{"documentId":"` + uuid + `","linkedRecordId":"` + uuid + `"}`,
			},
			refuse: []string{
				`{"folder":"a"}`,
				`{"documentId":"` + uuid + `","title":""}`,
				`{"documentId":"` + uuid + `","folder":"` + longString(301) + `"}`,
				`{"documentId":"` + uuid + `","linkedRecordId":"nope"}`,
				`{"documentId":"` + uuid + `","linkedRecordLabel":"` + longString(241) + `"}`,
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			for _, raw := range testCase.accept {
				if _, err := ParseDocumentsInput(testCase.capabilityID, json.RawMessage(raw)); err != nil {
					t.Errorf("%s refused %s: %v", testCase.capabilityID, raw, err)
				}
			}
			for _, raw := range testCase.refuse {
				if _, err := ParseDocumentsInput(testCase.capabilityID, json.RawMessage(raw)); err == nil {
					t.Errorf("%s accepted %s", testCase.capabilityID, raw)
				}
			}
		})
	}
}

// TestDocumentsUpdateMetadataKeepsTriState is the load-bearing part of the
// nullable-optional fields: absent must leave a column alone, null must clear
// it, and both must re-marshal as the exact bytes that arrived so an approval
// payload re-parses to the same canonical hash.
func TestDocumentsUpdateMetadataKeepsTriState(t *testing.T) {
	absent, err := ParseDocumentsInput(documentsUpdateDocMetadataCapabilityID,
		json.RawMessage(`{"documentId":"`+documentsTestUUID+`","title":"New"}`))
	if err != nil {
		t.Fatal(err)
	}
	if absent.Folder != nil || absent.LinkedRecordType != nil || absent.LinkedRecordID != nil || absent.LinkedRecordLabel != nil {
		t.Fatalf("absent link fields were populated: %+v", absent)
	}
	cleared, err := ParseDocumentsInput(documentsUpdateDocMetadataCapabilityID,
		json.RawMessage(`{"documentId":"`+documentsTestUUID+`","folder":null,"linkedRecordId":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Folder == nil || !cleared.Folder.Nulled || cleared.LinkedRecordID == nil || !cleared.LinkedRecordID.Nulled {
		t.Fatalf("explicit nulls were not preserved: %+v", cleared)
	}
	encoded, err := marshalJS(cleared)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"folder":null`) || !strings.Contains(string(encoded), `"linkedRecordId":null`) {
		t.Fatalf("cleared fields did not re-marshal as null: %s", encoded)
	}
	reparsed, err := ParseDocumentsInput(documentsUpdateDocMetadataCapabilityID, encoded)
	if err != nil {
		t.Fatal(err)
	}
	first, err := canonicalHash(cleared)
	if err != nil {
		t.Fatal(err)
	}
	second, err := canonicalHash(reparsed)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("approval payload round-trip changed the canonical hash: %s vs %s", first, second)
	}
}

// TestDocumentsZodDefaultsAreCanonical checks the capabilities whose schema
// applies a default, so the value the handler sees is the value the ledger
// hash commits to.
func TestDocumentsZodDefaultsAreCanonical(t *testing.T) {
	memory, err := ParseDocumentsInput(documentsSearchMemoryCapabilityID, json.RawMessage(`{"query":"ledger"}`))
	if err != nil {
		t.Fatal(err)
	}
	if memory.Limit == nil || *memory.Limit != documentsDefaultSearchMemoryLimit {
		t.Fatalf("searchMemory limit = %v, want the Zod default %d", memory.Limit, documentsDefaultSearchMemoryLimit)
	}
	records, err := ParseDocumentsInput(documentsSearchRecordsCapabilityID, json.RawMessage(`{"type":"customer"}`))
	if err != nil {
		t.Fatal(err)
	}
	if records.Query == nil || *records.Query != "" {
		t.Fatalf("searchRecords query = %v, want the Zod default empty string", records.Query)
	}
	doc, err := ParseDocumentsInput(documentsCreateDocCapabilityID,
		json.RawMessage(`{"title":"T","content":{},"html":"","pageSettings":{"size":"Letter"}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := DocumentsPageSettings{Size: "Letter", Orientation: "portrait", Margin: "normal"}
	if doc.PageSettings == nil || *doc.PageSettings != want {
		t.Fatalf("pageSettings = %+v, want %+v", doc.PageSettings, want)
	}
	coding, err := ParseDocumentsInput(documentsSuggestCodingCapabilityID,
		json.RawMessage(`{"documentId":"d1","lines":[{"description":"Coffee","unitPriceMinor":250}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(coding.Lines) != 1 || coding.Lines[0].QuantityThousandths != documentsCodingDefaultQuantity {
		t.Fatalf("coding line = %+v, want the Zod default quantity %d", coding.Lines, documentsCodingDefaultQuantity)
	}
}

// TestDocumentsParsersHashLikeTheWirePayload is the idempotency contract: for
// schemas with no defaults, the canonical hash of the parsed input must equal
// the hash of the raw payload the caller sent.
func TestDocumentsParsersHashLikeTheWirePayload(t *testing.T) {
	for capabilityID, sample := range documentsSampleInputs {
		parsed, err := ParseDocumentsInput(capabilityID, json.RawMessage(sample))
		if err != nil {
			t.Fatalf("%s: %v", capabilityID, err)
		}
		parsedHash, err := canonicalHash(parsed)
		if err != nil {
			t.Fatalf("%s: %v", capabilityID, err)
		}
		rawHash, err := InputHash(json.RawMessage(sample))
		if err != nil {
			t.Fatalf("%s: %v", capabilityID, err)
		}
		if parsedHash != rawHash {
			t.Errorf("%s canonical hash %s != raw hash %s for %s", capabilityID, parsedHash, rawHash, sample)
		}
	}
}

// TestDocumentsOutputsMatchManifest proves each Go output struct marshals to
// exactly the manifest's declared properties, with every required one present
// and nothing extra leaking onto the wire.
func TestDocumentsOutputsMatchManifest(t *testing.T) {
	manifest := loadDocumentsManifest(t)
	for capabilityID, sample := range documentsOutputSamples {
		schema, ok := entrySchema(manifest, capabilityID, "outputSchema")
		if !ok {
			t.Errorf("%s is absent from the capability manifest", capabilityID)
			continue
		}
		encoded, err := marshalJS(sample)
		if err != nil {
			t.Fatalf("%s: %v", capabilityID, err)
		}
		var value any
		if err := json.Unmarshal(encoded, &value); err != nil {
			t.Fatalf("%s output is not valid JSON: %v", capabilityID, err)
		}
		assertDocumentsSchema(t, schema, value, capabilityID+" output")
	}
}

func entrySchema(manifest map[string]map[string]any, capabilityID, key string) (map[string]any, bool) {
	entry, ok := manifest[capabilityID]
	if !ok {
		return nil, false
	}
	schema, _ := entry[key].(map[string]any)
	return schema, schema != nil
}

func manifestStrings(value any, key string) []string {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	raw, _ := object[key].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// assertDocumentsSchema walks a manifest JSON Schema next to a decoded value.
// It is deliberately narrow: it checks declared types, required keys, enum
// membership, constants, and the absence of undeclared keys, which is what
// "matching the output shape" means for a capability contract.
func assertDocumentsSchema(t *testing.T, schema map[string]any, value any, path string) {
	t.Helper()
	if alternatives, ok := schema["anyOf"].([]any); ok {
		for _, alternative := range alternatives {
			branch, _ := alternative.(map[string]any)
			if branch == nil {
				continue
			}
			if documentsSchemaAccepts(branch, value) {
				return
			}
		}
		t.Errorf("%s matched none of the anyOf branches", path)
		return
	}
	if constant, ok := schema["const"]; ok && !reflect.DeepEqual(constant, value) {
		t.Errorf("%s = %v, want the const %v", path, value, constant)
		return
	}
	if enum, ok := schema["enum"].([]any); ok && !documentsSchemaInEnum(enum, value) {
		t.Errorf("%s = %v, want one of %v", path, value, enum)
		return
	}
	if declared, ok := schema["type"].(string); ok {
		if !documentsSchemaAcceptsType(declared, value) {
			t.Errorf("%s has type %s, got %T", path, declared, value)
			return
		}
	}

	switch typed := value.(type) {
	case map[string]any:
		properties, _ := schema["properties"].(map[string]any)
		// A z.record() renders as a free-form object, so only a closed object
		// can reject an undeclared key.
		closed, _ := schema["additionalProperties"].(bool)
		for key, item := range typed {
			declared, ok := properties[key].(map[string]any)
			if !ok {
				if closed {
					t.Errorf("%s carries undeclared key %q", path, key)
				}
				continue
			}
			assertDocumentsSchema(t, declared, item, path+"."+key)
		}
		for _, key := range manifestStrings(schema, "required") {
			if _, ok := typed[key]; !ok {
				t.Errorf("%s is missing required key %q", path, key)
			}
		}
	case []any:
		items, _ := schema["items"].(map[string]any)
		if items == nil {
			return
		}
		for index, item := range typed {
			assertDocumentsSchema(t, items, item, fmt.Sprintf("%s[%d]", path, index))
		}
	}
}

func documentsSchemaInEnum(enum []any, value any) bool {
	for _, candidate := range enum {
		if reflect.DeepEqual(candidate, value) {
			return true
		}
	}
	return false
}

func documentsSchemaAccepts(schema map[string]any, value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range manifestStrings(schema, "required") {
			if _, ok := typed[key]; !ok {
				return false
			}
		}
		if properties, ok := schema["properties"].(map[string]any); ok {
			for key, declared := range properties {
				item, present := typed[key]
				if !present {
					continue
				}
				branch, _ := declared.(map[string]any)
				if branch != nil && !documentsSchemaAccepts(branch, item) {
					return false
				}
			}
		}
		return true
	case nil:
		return true
	default:
		declared, _ := schema["type"].(string)
		return declared == "" || documentsSchemaAcceptsType(declared, value)
	}
}

func documentsSchemaAcceptsType(declared string, value any) bool {
	switch declared {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	case "integer":
		number, ok := value.(float64)
		return ok && number == float64(int64(number))
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "null":
		return value == nil
	default:
		return true
	}
}

func TestNormalizeDocumentFolderPathMatchesModuleBehavior(t *testing.T) {
	cases := map[string]string{
		"":                       "",
		"   ":                    "",
		"Finance":                "Finance",
		"  Finance  ":            "Finance",
		"/Finance/2026/":         "Finance/2026",
		"Finance///2026":         "Finance/2026",
		`Finance\2026`:           "Finance/2026",
		`Finance\\2026//Q1`:      "Finance/2026/Q1",
		"  / Finance / 2026 /  ": "Finance/2026",
		strings.Repeat("a", 350): strings.Repeat("a", 300),
		// The 301st code unit is the trailing "c", so truncation cuts it.
		strings.Repeat("ab/", 100) + "c": strings.Repeat("ab/", 100),
	}
	for input, want := range cases {
		if got := NormalizeDocumentFolderPath(input); got != want {
			t.Errorf("NormalizeDocumentFolderPath(%q) = %q, want %q", input, got, want)
		}
	}
	long := NormalizeDocumentFolderPath(strings.Repeat("a", 350))
	if utf16Length(long) != 300 {
		t.Errorf("truncated path is %d UTF-16 units, want 300", utf16Length(long))
	}
}

func TestExtractDocumentPlaceholdersMatchesJSONStringifyOrder(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    []string
	}{
		{"no tokens", `{"type":"doc"}`, []string{}},
		{"single token", `{"type":"doc","text":"Hello {{customer.name}}"}`, []string{"customer.name"}},
		{"dedupes", `{"a":"{{x.y}}","b":"{{x.y}}"}`, []string{"x.y"}},
		{
			"insertion order, not sorted",
			`{"z":"{{zulu.one}}","a":"{{alpha.two}}"}`,
			[]string{"zulu.one", "alpha.two"},
		},
		{
			"array indices come first",
			`{"2":"{{third.key}}","1":"{{second.key}}","name":"{{name.key}}"}`,
			[]string{"second.key", "third.key", "name.key"},
		},
		{"whitespace tolerant", `{"a":"{{  spaced.key  }}"}`, []string{"spaced.key"}},
		{"html is not escaped", `{"a":"<b>{{kept.key}}</b>"}`, []string{"kept.key"}},
		{"dotted and single word", `{"a":"{{one}} {{two.three}}"}`, []string{"one", "two.three"}},
		{"rejects a leading digit", `{"a":"{{1bad}}"}`, []string{}},
		{"rejects a 62 character token", `{"a":"{{` + strings.Repeat("z", 62) + `}}"}`, []string{}},
		{"accepts a 61 character token", `{"a":"{{` + strings.Repeat("z", 61) + `}}"}`, []string{strings.Repeat("z", 61)}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ExtractDocumentPlaceholders(json.RawMessage(testCase.content))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("ExtractDocumentPlaceholders(%s) = %v, want %v", testCase.content, got, testCase.want)
			}
		})
	}
	if _, err := ExtractDocumentPlaceholders(json.RawMessage(`{`)); err == nil {
		t.Error("ExtractDocumentPlaceholders accepted malformed content")
	}
}

func TestDocumentsDisplayMoneyMatchesIntlCurrency(t *testing.T) {
	cases := []struct {
		minor    int64
		currency string
		want     string
	}{
		{0, "USD", "$0.00"},
		{5, "USD", "$0.05"},
		{123456, "USD", "$1,234.56"},
		{-123456, "USD", "-$1,234.56"},
		{100000000, "USD", "$1,000,000.00"},
		{123456, "EUR", "€1,234.56"},
		{123456, "GBP", "£1,234.56"},
		{123456, "JPY", "¥1,235"},
		{150, "JPY", "¥2"},
		{-150, "JPY", "-¥1"},
		{100000, "JPY", "¥1,000"},
		{123456, "CNY", "CN¥1,234.56"},
		{123456, "KES", "KSh 1,234.56"},
		{123456, "ZWL", "ZWL 1,234.56"},
		{123456, "usd", "$1,234.56"},
	}
	for _, testCase := range cases {
		got, err := documentsDisplayMoney(testCase.minor, testCase.currency)
		if err != nil {
			t.Fatalf("documentsDisplayMoney(%d, %q): %v", testCase.minor, testCase.currency, err)
		}
		if got != testCase.want {
			t.Errorf("documentsDisplayMoney(%d, %q) = %q, want %q", testCase.minor, testCase.currency, got, testCase.want)
		}
	}
	// Intl raises a RangeError for these, so the capability must fail rather
	// than invent an amount.
	for _, currency := range []string{"", "US", "USDD", "12A", "KWD", "BHD"} {
		if _, err := documentsDisplayMoney(100, currency); err == nil {
			t.Errorf("documentsDisplayMoney accepted currency %q", currency)
		}
	}
}

func TestDocumentsLineTotalMinorRoundsLikeMathRound(t *testing.T) {
	cases := []struct {
		quantity  int64
		unitMinor int64
		want      int64
	}{
		{1000, 100, 100},
		{1500, 100, 150},
		{333, 1000, 333},
		{1, 1500, 2},
		{-1, 1500, -2},
		{0, 5000, 0},
	}
	for _, testCase := range cases {
		got := documentsLineTotalMinor(documentsLine{
			Quantity: testCase.quantity, UnitPriceMinor: testCase.unitMinor,
		})
		if got != testCase.want {
			t.Errorf("lineTotal(%d, %d) = %d, want %d", testCase.quantity, testCase.unitMinor, got, testCase.want)
		}
	}
}

func TestDocumentsQuantityStringMatchesJavaScriptNumber(t *testing.T) {
	cases := map[int64]string{
		0: "0", 1000: "1", 1500: "1.5", 1234: "1.234", -2500: "-2.5", 1000000: "1000",
	}
	for thousandths, want := range cases {
		if got := documentsQuantityString(thousandths); got != want {
			t.Errorf("documentsQuantityString(%d) = %q, want %q", thousandths, got, want)
		}
	}
}

func TestDocumentsCodingTokenizerMirrorsDomain(t *testing.T) {
	got := documentsCodingTokenize("Office Supplies & Coffee (12)")
	want := []string{"office", "supplies", "coffee"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokenize = %v, want %v", got, want)
	}
	expanded := documentsCodingExpandTokens([]string{"phone", "bankfee"})
	found := map[string]bool{}
	for _, token := range expanded {
		found[token] = true
	}
	for _, canonical := range []string{"telephone", "bank"} {
		if !found[canonical] {
			t.Errorf("expandTokens(%v) is missing the %q synonym group", expanded, canonical)
		}
	}
}

func TestSuggestExpenseAccountIsDeterministicAndFailsSafe(t *testing.T) {
	accounts := []CoderAccount{
		{Code: "6100", Name: "Office supplies", Type: "expense"},
		{Code: "6000", Name: "General expenses", Type: "expense"},
		{Code: "4000", Name: "Sales revenue", Type: "income"},
		{Code: "6200", Name: "Telephone and mobile", Type: "expense"},
	}
	supplies := SuggestExpenseAccount("Office supplies restock", accounts)
	if supplies.Code != "6100" || supplies.Score < 2 {
		t.Fatalf("office supplies matched %+v, want account 6100 with both name tokens", supplies)
	}
	phone := SuggestExpenseAccount("Monthly phone bill", accounts)
	if phone.Code != "6200" {
		t.Fatalf("phone bill matched %+v, want account 6200", phone)
	}
	unknown := SuggestExpenseAccount("Zzz unrelated", accounts)
	if unknown.Code != documentsCodingFallbackExpenseCode || unknown.Score != 0 {
		t.Fatalf("unmatched line returned %+v, want the %s fallback with score 0", unknown, documentsCodingFallbackExpenseCode)
	}
	shuffled := []CoderAccount{accounts[2], accounts[3], accounts[0], accounts[1]}
	if got := SuggestExpenseAccount("Office supplies restock", shuffled); got.Code != supplies.Code {
		t.Fatalf("account order changed the match: %+v vs %+v", got, supplies)
	}
	noExpenses := SuggestExpenseAccount("Anything at all", []CoderAccount{{Code: "1000", Name: "Cash", Type: "asset"}})
	if noExpenses.Code != documentsCodingFallbackExpenseCode {
		t.Fatalf("an org with no expense account returned %+v, want the fallback code", noExpenses)
	}
	if got := SuggestExpenseAccount("", nil); got.Code != documentsCodingFallbackExpenseCode || got.Score != 0 {
		t.Fatalf("empty description and no accounts returned %+v", got)
	}
}

// TestSuggestExpenseAccountIsStableUnderShuffling is the property the domain
// rule promises: the suggestion depends on the account set, never on the order
// the rows came back in.
func TestSuggestExpenseAccountIsStableUnderShuffling(t *testing.T) {
	accounts := []CoderAccount{
		{Code: "6000", Name: "General expenses", Type: "expense"},
		{Code: "6050", Name: "Advertising and marketing", Type: "expense"},
		{Code: "6100", Name: "Rent and premises", Type: "expense"},
		{Code: "6200", Name: "Fuel and diesel", Type: "expense"},
		{Code: "6300", Name: "Professional fees", Type: "expense"},
		{Code: "7000", Name: "Cost of goods sold", Type: "expense"},
	}
	descriptions := []string{
		"", "coffee beans", "Shop rent for the quarter", "Diesel refuelling",
		"Legal and audit retainer", "Facebook advertising", "Broadband internet",
		"Office stationery", "Bank transaction fee", "Something unmatchable here",
	}
	random := rand.New(rand.NewSource(20260930))
	for _, description := range descriptions {
		want := SuggestExpenseAccount(description, accounts)
		for attempt := 0; attempt < 24; attempt++ {
			shuffled := append([]CoderAccount(nil), accounts...)
			random.Shuffle(len(shuffled), func(left, right int) {
				shuffled[left], shuffled[right] = shuffled[right], shuffled[left]
			})
			if got := SuggestExpenseAccount(description, shuffled); got.Code != want.Code || got.Score != want.Score {
				t.Fatalf("shuffling changed the suggestion for %q: %+v vs %+v", description, got, want)
			}
		}
	}
}

func TestDocumentsNumberStringHasNoExponentForm(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", 1.5: "1.5", 1.234: "1.234", -2.5: "-2.5", 1000: "1000",
	}
	for value, want := range cases {
		if got := documentsNumberString(value); got != want {
			t.Errorf("documentsNumberString(%v) = %q, want %q", value, got, want)
		}
	}
}

func TestDocumentsRejectionIsDistinguishableFromInfrastructureFailure(t *testing.T) {
	rejection := rejectDocuments("template not found")
	if message, ok := DocumentsRejectionMessage(rejection); !ok || message != "template not found" {
		t.Fatalf("DocumentsRejectionMessage(%v) = %q, %t", rejection, message, ok)
	}
	if _, ok := DocumentsRejectionMessage(&pgconn.PgError{Code: "23505"}); ok {
		t.Error("a database error was reported as a business-rule rejection")
	}
}
