package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type documentContentDownloadTestReader struct {
	document          *documentContentDownload
	orgID, documentID string
	err               error
}

func (reader *documentContentDownloadTestReader) Read(_ context.Context, orgID, documentID string) (*documentContentDownload, error) {
	reader.orgID, reader.documentID = orgID, documentID
	return reader.document, reader.err
}

func documentContentRequest(method, id string) *http.Request {
	request := httptest.NewRequest(method, "/api/go/documents/"+id+"/content", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestDocumentContentDownloadServesValidatedBinaryWithSafeHeaders(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["documents.read"] = true
	size := int64(4)
	mimeType := "application/pdf"
	content := "AAEC/w=="
	reader := &documentContentDownloadTestReader{document: &documentContentDownload{
		Title: "résumé (final).pdf", MIMEType: &mimeType, SizeBytes: &size, ContentBase64: &content,
	}}
	handler := newDocumentContentDownloadHandler(&fakeDirectSessionResolver{resolved: identity}, reader, slog.New(slog.NewTextHandler(io.Discard, nil)))
	response := httptest.NewRecorder()
	MountGoDocumentContentDownloadRoute(http.NotFoundHandler(), handler).ServeHTTP(response, documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))

	if response.Code != http.StatusOK || string(response.Body.Bytes()) != string([]byte{0, 1, 2, 255}) {
		t.Fatalf("download status=%d body=%v", response.Code, response.Body.Bytes())
	}
	if response.Header().Get("Content-Type") != "application/octet-stream" || response.Header().Get("Content-Disposition") != "attachment; filename*=UTF-8''r-sum-final-.pdf" || response.Header().Get("Content-Length") != "4" || response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("Content-Security-Policy") != "sandbox; default-src 'none'" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unsafe or incompatible download headers: %#v", response.Header())
	}
	if reader.orgID != *identity.OrgID || reader.documentID != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("reader scope org=%q doc=%q", reader.orgID, reader.documentID)
	}
}

func TestDocumentContentDownloadInlineAllowlistAndAuthorization(t *testing.T) {
	identity := directTestIdentity()
	mimeType := "image/png"
	content := "cG5n"
	reader := &documentContentDownloadTestReader{document: &documentContentDownload{Title: "logo.png", MIMEType: &mimeType, ContentBase64: &content}}
	handler := newDocumentContentDownloadHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
	if response.Code != http.StatusForbidden || reader.documentID != "" {
		t.Fatalf("missing documents.read status=%d reader=%q", response.Code, reader.documentID)
	}
	identity.Permissions["documents.read"] = true
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/png" || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "inline;") {
		t.Fatalf("safe image response=%d headers=%#v", response.Code, response.Header())
	}
	identity.ModulesRestricted = true
	identity.EnabledModules = []string{"crm"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
	if response.Code != http.StatusForbidden || reader.documentID != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("disabled module response=%d", response.Code)
	}
}

func TestDocumentContentDownloadHidesMissingAndRejectsInvalidMetadata(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["documents.read"] = true
	reader := &documentContentDownloadTestReader{}
	handler := newDocumentContentDownloadHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	request := documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing document status=%d body=%s", response.Code, response.Body.String())
	}

	for _, test := range []struct {
		name string
		doc  documentContentDownload
	}{
		{name: "invalid base64", doc: documentContentDownload{Title: "x", MIMEType: stringPointer("text/plain"), ContentBase64: stringPointer("%%%")}},
		{name: "invalid mime", doc: documentContentDownload{Title: "x", MIMEType: stringPointer("text/plain\r\nX-Evil: yes"), ContentBase64: stringPointer("eA==")}},
		{name: "declared size mismatch", doc: documentContentDownload{Title: "x", MIMEType: stringPointer("text/plain"), SizeBytes: int64Pointer(9), ContentBase64: stringPointer("eA==")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			document := test.doc
			reader.document = &document
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("invalid content metadata status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	reader.document = &documentContentDownload{Title: "x", MIMEType: stringPointer("text/plain"), ContentBase64: stringPointer("")}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, documentContentRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
	if response.Code != http.StatusNotFound {
		t.Fatalf("empty content status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoDocumentContentDownloadRouteOwnsOnlyExactGets(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	router := MountGoDocumentContentDownloadRoute(legacy, goRoute)
	for _, test := range []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodGet, "/api/go/documents/44444444-4444-4444-8444-444444444444/content", http.StatusAccepted},
		{http.MethodPost, "/api/go/documents/44444444-4444-4444-8444-444444444444/content", http.StatusTeapot},
		{http.MethodGet, "/api/go/documents/not-a-uuid/content", http.StatusAccepted},
		{http.MethodGet, "/api/go/documents/44444444-4444-4444-8444-444444444444/content/extra", http.StatusTeapot},
		{http.MethodGet, "/api/documents/44444444-4444-4444-8444-444444444444/content", http.StatusTeapot},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.want {
			t.Fatalf("%s %s status=%d, want %d", test.method, test.path, response.Code, test.want)
		}
	}
}

func int64Pointer(value int64) *int64 { return &value }
