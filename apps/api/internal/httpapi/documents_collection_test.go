package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type documentsFakeCall struct {
	claims       authbridge.CapabilityClaims
	capabilityID string
	input        json.RawMessage
}

type documentsFakeExecutor struct {
	results map[string]capability.Result
	errs    map[string]error
	calls   []documentsFakeCall
}

func (f *documentsFakeExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	f.calls = append(f.calls, documentsFakeCall{claims: claims, capabilityID: capabilityID, input: input})
	if err, ok := f.errs[capabilityID]; ok {
		return capability.Result{}, err
	}
	if result, ok := f.results[capabilityID]; ok {
		return result, nil
	}
	return capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil
}

func (f *documentsFakeExecutor) callFor(capabilityID string) (documentsFakeCall, bool) {
	for _, call := range f.calls {
		if call.capabilityID == capabilityID {
			return call, true
		}
	}
	return documentsFakeCall{}, false
}

func (f *documentsFakeExecutor) lastCallFor(capabilityID string) (documentsFakeCall, bool) {
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].capabilityID == capabilityID {
			return f.calls[i], true
		}
	}
	return documentsFakeCall{}, false
}

type documentsParseCall struct {
	orgID      string
	actorID    string
	documentID string
}

type fakeDocumentsParseEnqueuer struct {
	calls []documentsParseCall
	err   error
}

func (f *fakeDocumentsParseEnqueuer) EnqueueDocumentParse(_ context.Context, orgID, actorID, documentID string) error {
	f.calls = append(f.calls, documentsParseCall{orgID: orgID, actorID: actorID, documentID: documentID})
	return f.err
}

func documentsTestIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"documents.read": true, "documents.write": true}
	return identity
}

func documentsRouteRequest(method, target, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return r
}

func documentsCollectionHandlerFor(resolved *session.ResolvedUser, executor CapabilityExecutor) http.Handler {
	handler := NewDocumentsCollectionHandler(&fakeDirectSessionResolver{resolved: resolved}, executor, nil)
	return MountGoDocumentsCollectionRoute(nil, handler)
}

func documentsIngestHandlerFor(resolved *session.ResolvedUser, executor CapabilityExecutor, enqueuer documentsParseEnqueuer) http.Handler {
	handler := newDocumentsIngestHandler(enqueuer, &fakeDirectSessionResolver{resolved: resolved}, executor, nil, nil)
	return MountGoDocumentsIngestRoute(nil, handler)
}

func TestDocumentsCollectionHandlerUnavailableWithoutServices(t *testing.T) {
	handler := NewDocumentsCollectionHandler(nil, nil, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs", ""))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionHandlerUnauthorizedWithoutSession(t *testing.T) {
	executor := &documentsFakeExecutor{}
	handler := documentsCollectionHandlerFor(nil, executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionListMergesDocumentsAndTemplates(t *testing.T) {
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.listDocs":      {OK: true, Data: json.RawMessage(`{"documents":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]}`)},
		"documents.listTemplates": {OK: true, Data: json.RawMessage(`{"templates":[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Documents []map[string]any `json:"documents"`
		Templates []map[string]any `json:"templates"`
	}
	if json.Unmarshal(response.Body.Bytes(), &body) != nil || len(body.Documents) != 1 || len(body.Templates) != 1 {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestDocumentsCollectionListEmptyArraysStayArrays(t *testing.T) {
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.listDocs":      {OK: true, Data: json.RawMessage(`{"documents":null}`)},
		"documents.listTemplates": {OK: true, Data: json.RawMessage(`{"templates":null}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"documents":[]`) || !strings.Contains(response.Body.String(), `"templates":[]`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionTemplateLookup(t *testing.T) {
	templateID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.getTemplate": {OK: true, Data: json.RawMessage(`{"template":{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs?template="+templateID, ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), templateID) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.getTemplate")
	if !ok || string(call.input) != `{"templateId":"`+templateID+`"}` {
		t.Fatalf("input=%s", call.input)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs?template=not-a-uuid", ""))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("malformed template status=%d body=%s", response.Code, response.Body.String())
	}

	executor.results["documents.getTemplate"] = capability.Result{OK: false, Error: "template not found"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs?template="+templateID, ""))
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing template status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionWriteStripsActionAndRejectsUnknownKeys(t *testing.T) {
	documentID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.deleteDoc": {OK: true, Data: json.RawMessage(`{"deleted":true}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs",
		`{"action":"delete","documentId":"`+documentID+`","intentId":"intent-123"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"deleted":true`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.deleteDoc")
	if !ok || string(call.input) != `{"documentId":"`+documentID+`"}` {
		t.Fatalf("input=%s", call.input)
	}
	if call.claims.IntentID != "intent-123" || call.claims.Subject != documentsTestIdentity().UserID {
		t.Fatalf("claims=%+v", call.claims)
	}

	before := len(executor.calls)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs", `{"action":"delete","documentId":"`+documentID+`","extra":true}`))
	if response.Code != http.StatusBadRequest || len(executor.calls) != before {
		t.Fatalf("unknown key status=%d calls=%d", response.Code, len(executor.calls))
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs", `{"action":"explode"}`))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid action") {
		t.Fatalf("unknown action status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionItemInjectsPathDocumentID(t *testing.T) {
	documentID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.saveDocVersion": {OK: true, Data: json.RawMessage(`{"version":2}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs/"+documentID,
		`{"action":"publish","content":{"type":"doc"},"html":"<p>hi</p>"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":2`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.saveDocVersion")
	if !ok {
		t.Fatal("capability was not called")
	}
	var input map[string]json.RawMessage
	var html string
	if json.Unmarshal(call.input, &input) != nil || json.Unmarshal(input["html"], &html) != nil || html != "<p>hi</p>" || string(input["documentId"]) != `"`+documentID+`"` {
		t.Fatalf("input=%s", call.input)
	}
	if _, present := input["action"]; present {
		t.Fatalf("action leaked into input: %s", call.input)
	}
}

func TestDocumentsCollectionItemRejectsMalformedDocumentID(t *testing.T) {
	executor := &documentsFakeExecutor{}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/not-a-uuid", ""))
	if response.Code != http.StatusBadRequest || len(executor.calls) != 0 {
		t.Fatalf("status=%d calls=%d", response.Code, len(executor.calls))
	}
}

func TestDocumentsCollectionVersionLookup(t *testing.T) {
	documentID := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.getDocVersion": {OK: true, Data: json.RawMessage(`{"version":2,"html":"<p>v2</p>","content":{}}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/"+documentID+"?version=2", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":2`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.getDocVersion")
	if !ok || string(call.input) != `{"documentId":"`+documentID+`","version":2}` {
		t.Fatalf("input=%s", call.input)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/"+documentID+"?version=zero", ""))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid version") {
		t.Fatalf("malformed version status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionDetailFallsBackToEmptyVersions(t *testing.T) {
	documentID := "11111111-2222-4333-8444-555555555555"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.getDoc":          {OK: true, Data: json.RawMessage(`{"document":{"id":"` + documentID + `","title":"Doc"}}`)},
		"documents.listDocVersions": {OK: false, Error: "forbidden: missing permission: documents.read"},
		"documents.otherCapability": {OK: true},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/"+documentID, ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"versions":[]`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionPendingApprovalAndRefusals(t *testing.T) {
	documentID := "22222222-3333-4444-8555-666666666666"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.saveDocVersion": {OK: false, PendingApproval: true, ApprovalRationale: "waits for review", ApprovalID: "approval-1"},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs/"+documentID,
		`{"action":"publish","content":{"type":"doc"},"html":""}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"reason":"waits for review"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	executor.results["documents.saveDocVersion"] = capability.Result{OK: false, Error: "forbidden: missing permission: documents.write"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs/"+documentID,
		`{"action":"publish","content":{"type":"doc"},"html":""}`))
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d body=%s", response.Code, response.Body.String())
	}

	executor.results["documents.saveDocVersion"] = capability.Result{OK: false, Error: `module "documents" is disabled for this organization`}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs/"+documentID,
		`{"action":"publish","content":{"type":"doc"},"html":""}`))
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "documents module is disabled") {
		t.Fatalf("module disabled status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionNextNumber(t *testing.T) {
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.allocateNumber": {OK: true, Data: json.RawMessage(`{"number":"INV-2026-0007"}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/next-number?kind=invoice", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "INV-2026-0007") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.allocateNumber")
	if !ok || string(call.input) != `{"kind":"invoice"}` {
		t.Fatalf("input=%s", call.input)
	}

	before := len(executor.calls)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/next-number?kind=unknown", ""))
	if response.Code != http.StatusBadRequest || len(executor.calls) != before {
		t.Fatalf("invalid kind status=%d calls=%d", response.Code, len(executor.calls))
	}

	executor.results["documents.allocateNumber"] = capability.Result{OK: false, Error: "numbering failed"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/next-number?kind=quote", ""))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "number unavailable") {
		t.Fatalf("unavailable status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsCollectionRecords(t *testing.T) {
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.searchRecords": {OK: true, Data: json.RawMessage(`{"records":[{"id":"rec-1"}]}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/records?type=customer&q=acme", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "rec-1") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.searchRecords")
	if !ok || string(call.input) != `{"query":"acme","type":"customer"}` {
		t.Fatalf("input=%s", call.input)
	}

	before := len(executor.calls)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/records?type=planet", ""))
	if response.Code != http.StatusBadRequest || len(executor.calls) != before {
		t.Fatalf("invalid type status=%d calls=%d", response.Code, len(executor.calls))
	}
}

func TestDocumentsCollectionFolders(t *testing.T) {
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.listFolders":  {OK: true, Data: json.RawMessage(`{"folders":["Legal"]}`)},
		"documents.renameFolder": {OK: true, Data: json.RawMessage(`{"path":"Legal","movedTo":"Archive"}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/docs/folders", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Legal") {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs/folders", `{"action":"rename","path":"Legal","newPath":"Archive"}`))
	if response.Code != http.StatusOK {
		t.Fatalf("rename status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.callFor("documents.renameFolder")
	if !ok || string(call.input) != `{"newPath":"Archive","path":"Legal"}` {
		t.Fatalf("input=%s", call.input)
	}
}

func TestDocumentsCollectionPostRequiresOriginUnlessBearer(t *testing.T) {
	documentID := "33333333-4444-4555-8666-777777777777"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.deleteDoc": {OK: true, Data: json.RawMessage(`{"deleted":true}`)},
	}}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)

	request := documentsRouteRequest(http.MethodPost, "/api/docs", `{"action":"delete","documentId":"`+documentID+`"}`)
	request.Header.Del("Origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || len(executor.calls) != 0 {
		t.Fatalf("no origin status=%d calls=%d", response.Code, len(executor.calls))
	}

	request = documentsRouteRequest(http.MethodPost, "/api/docs", `{"action":"delete","documentId":"`+documentID+`"}`)
	request.Header.Del("Origin")
	request.Header.Set("Authorization", "Bearer desktop-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("bearer status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsIngestListAndDetail(t *testing.T) {
	documentID := "44444444-5555-4666-8777-888888888888"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.listIngestedDocuments": {OK: true, Data: json.RawMessage(`{"documents":[{"id":"` + documentID + `"}],"vendors":[]}`)},
	}}
	handler := documentsIngestHandlerFor(documentsTestIdentity(), executor, &fakeDocumentsParseEnqueuer{})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/documents", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), documentID) {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}

	executor.results["documents.listIngestedDocuments"] = capability.Result{OK: true, Data: json.RawMessage(`{"document":{"id":"` + documentID + `"},"suggestions":[]}`)}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/documents?id="+documentID, ""))
	if response.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", response.Code, response.Body.String())
	}
	call, ok := executor.lastCallFor("documents.listIngestedDocuments")
	if !ok {
		t.Fatal("capability was not called")
	}
	if string(call.input) != `{"id":"`+documentID+`"}` {
		t.Fatalf("detail input=%s", call.input)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/documents?id="+documentID+"&preview=1", ""))
	call, _ = executor.lastCallFor("documents.listIngestedDocuments")
	if !strings.Contains(string(call.input), `"preview":true`) {
		t.Fatalf("preview input=%s", call.input)
	}

	executor.results["documents.listIngestedDocuments"] = capability.Result{OK: false, Error: "ingested document not found"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodGet, "/api/documents?id="+documentID, ""))
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), `"error":"not found"`) {
		t.Fatalf("not found status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsIngestAsyncParseEnqueuesAndFlipsStatus(t *testing.T) {
	documentID := "55555555-6666-4777-8888-999999999999"
	executor := &documentsFakeExecutor{}
	enqueuer := &fakeDocumentsParseEnqueuer{}
	handler := documentsIngestHandlerFor(documentsTestIdentity(), executor, enqueuer)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"parse","documentId":"`+documentID+`"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"queued":true`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(enqueuer.calls) != 1 || enqueuer.calls[0] != (documentsParseCall{orgID: *documentsTestIdentity().OrgID, actorID: documentsTestIdentity().UserID, documentID: documentID}) {
		t.Fatalf("enqueuer calls=%+v", enqueuer.calls)
	}
	if len(executor.calls) != 0 {
		t.Fatalf("executor calls=%d", len(executor.calls))
	}

	enqueuer.err = errDocumentsParseDocumentNotFound
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"parse","documentId":"`+documentID+`"}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("not found status=%d body=%s", response.Code, response.Body.String())
	}

	identity := documentsTestIdentity()
	identity.Permissions = map[string]bool{"documents.read": true}
	handler = documentsIngestHandlerFor(identity, executor, enqueuer)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"parse","documentId":"`+documentID+`"}`))
	if response.Code != http.StatusForbidden || len(enqueuer.calls) != 2 {
		t.Fatalf("read only status=%d enqueuer=%d", response.Code, len(enqueuer.calls))
	}

	identity = documentsTestIdentity()
	identity.ModulesRestricted = true
	identity.EnabledModules = []string{"crm"}
	handler = documentsIngestHandlerFor(identity, executor, enqueuer)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"parse","documentId":"`+documentID+`"}`))
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "documents module is disabled") {
		t.Fatalf("module disabled status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsIngestSyncParseUsesCapability(t *testing.T) {
	documentID := "66666666-7777-4888-8999-aaaaaaaaaaaa"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.parseDocument": {OK: true, Data: json.RawMessage(`{"status":"parsed","chars":12}`)},
	}}
	enqueuer := &fakeDocumentsParseEnqueuer{}
	handler := documentsIngestHandlerFor(documentsTestIdentity(), executor, enqueuer)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"parse","documentId":"`+documentID+`","sync":true}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) || !strings.Contains(response.Body.String(), `"status":"parsed"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(enqueuer.calls) != 0 {
		t.Fatalf("enqueuer calls=%d", len(enqueuer.calls))
	}
	call, ok := executor.callFor("documents.parseDocument")
	if !ok || string(call.input) != `{"documentId":"`+documentID+`"}` {
		t.Fatalf("input=%s", call.input)
	}
}

func TestDocumentsIngestCreateShapes(t *testing.T) {
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.createDocument": {OK: true, Data: json.RawMessage(`{"documentId":"77777777-8888-4999-8aaa-bbbbbbbbbbbb"}`)},
	}}
	handler := documentsIngestHandlerFor(documentsTestIdentity(), executor, &fakeDocumentsParseEnqueuer{})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents",
		`{"action":"create","title":"Receipt","text":"line one","folder":"  Inbox  "}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("text status=%d body=%s", response.Code, response.Body.String())
	}
	call, _ := executor.lastCallFor("documents.createDocument")
	var input map[string]json.RawMessage
	if json.Unmarshal(call.input, &input) != nil || string(input["text"]) != `"line one"` || string(input["folder"]) != `"Inbox"` {
		t.Fatalf("text input=%s", call.input)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents",
		`{"action":"create","title":"Scan","fileBase64":"aGk=","mimeType":"image/png"}`))
	call, _ = executor.lastCallFor("documents.createDocument")
	input = nil
	if json.Unmarshal(call.input, &input) != nil || string(input["fileBase64"]) != `"aGk="` || string(input["mimeType"]) != `"image/png"` {
		t.Fatalf("upload input=%s", call.input)
	}
	if _, present := input["text"]; present {
		t.Fatalf("upload input leaked text: %s", call.input)
	}

	executor.results["documents.createDocument"] = capability.Result{OK: false, Error: "provide exactly one of text or fileBase64"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"create","title":"Empty"}`))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), `"ok":false`) {
		t.Fatalf("refusal status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsIngestSuggestDefaultsAndDelete(t *testing.T) {
	documentID := "88888888-9999-4aaa-8bbb-cccccccccccc"
	executor := &documentsFakeExecutor{results: map[string]capability.Result{
		"documents.suggestCoding":  {OK: true, Data: json.RawMessage(`{"suggestions":[]}`)},
		"documents.deleteDocument": {OK: true, Data: json.RawMessage(`{"deleted":true}`)},
	}}
	handler := documentsIngestHandlerFor(documentsTestIdentity(), executor, &fakeDocumentsParseEnqueuer{})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents",
		`{"action":"suggest","documentId":"`+documentID+`","lines":[{"description":"Widgets"}]}`))
	if response.Code != http.StatusOK {
		t.Fatalf("suggest status=%d body=%s", response.Code, response.Body.String())
	}
	call, _ := executor.callFor("documents.suggestCoding")
	var input struct {
		Lines []map[string]json.RawMessage `json:"lines"`
	}
	if json.Unmarshal(call.input, &input) != nil || len(input.Lines) != 1 ||
		string(input.Lines[0]["quantityThousandths"]) != "1000" || string(input.Lines[0]["unitPriceMinor"]) != "0" {
		t.Fatalf("suggest input=%s", call.input)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/documents", `{"action":"delete"}`))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "documentId required") {
		t.Fatalf("missing id status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentsMountRoutesOwnTheirPatternsAndForwardTheRest(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	probe := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}

	collection := MountGoDocumentsCollectionRoute(base, http.HandlerFunc(probe))
	record := httptest.NewRecorder()
	collection.ServeHTTP(record, httptest.NewRequest(http.MethodPost, "/api/docs/assist", nil))
	if record.Code != http.StatusTeapot {
		t.Fatalf("assist forwarded status=%d", record.Code)
	}
	record = httptest.NewRecorder()
	collection.ServeHTTP(record, httptest.NewRequest(http.MethodGet, "/api/docs", nil))
	if record.Code != http.StatusNoContent {
		t.Fatalf("gallery status=%d", record.Code)
	}
	record = httptest.NewRecorder()
	collection.ServeHTTP(record, httptest.NewRequest(http.MethodGet, "/api/docs/unknown-route", nil))
	if record.Code != http.StatusNoContent {
		t.Fatalf("item wildcard status=%d", record.Code)
	}

	ingest := MountGoDocumentsIngestRoute(collection, http.HandlerFunc(probe))
	record = httptest.NewRecorder()
	ingest.ServeHTTP(record, httptest.NewRequest(http.MethodGet, "/api/documents", nil))
	if record.Code != http.StatusNoContent {
		t.Fatalf("ingest list status=%d", record.Code)
	}
	record = httptest.NewRecorder()
	ingest.ServeHTTP(record, httptest.NewRequest(http.MethodGet, "/api/documents/11111111-1111-4111-8111-111111111111/content", nil))
	if record.Code != http.StatusTeapot {
		t.Fatalf("content unmounted status=%d", record.Code)
	}

	mounted := MountGoLegacyDocumentContentRoute(ingest, http.HandlerFunc(probe))
	record = httptest.NewRecorder()
	mounted.ServeHTTP(record, httptest.NewRequest(http.MethodGet, "/api/documents/11111111-1111-4111-8111-111111111111/content", nil))
	if record.Code != http.StatusNoContent {
		t.Fatalf("content status=%d", record.Code)
	}
	record = httptest.NewRecorder()
	mounted.ServeHTTP(record, httptest.NewRequest(http.MethodPost, "/api/documents/11111111-1111-4111-8111-111111111111/content", nil))
	if record.Code != http.StatusTeapot {
		t.Fatalf("content method status=%d", record.Code)
	}
}

func TestDocumentsCollectionRejectsOversizedIntentIDs(t *testing.T) {
	executor := &documentsFakeExecutor{}
	handler := documentsCollectionHandlerFor(documentsTestIdentity(), executor)
	body, err := json.Marshal(map[string]string{"action": "delete", "documentId": "11111111-1111-4111-8111-111111111111", "intentId": strings.Repeat("i", 201)})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentsRouteRequest(http.MethodPost, "/api/docs", string(body)))
	if response.Code != http.StatusBadRequest || len(executor.calls) != 0 {
		t.Fatalf("status=%d calls=%d", response.Code, len(executor.calls))
	}
}
