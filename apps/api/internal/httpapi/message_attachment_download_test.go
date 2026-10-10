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

type messageAttachmentDownloadTestReader struct {
	file                  *messageAttachmentDownload
	orgID, userID, fileID string
	err                   error
}

func (reader *messageAttachmentDownloadTestReader) Read(_ context.Context, orgID, userID, fileID string) (*messageAttachmentDownload, error) {
	reader.orgID, reader.userID, reader.fileID = orgID, userID, fileID
	return reader.file, reader.err
}

func messageAttachmentDownloadRequest(method, id string) *http.Request {
	request := httptest.NewRequest(method, "/api/message-attachments/"+id, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestMessageAttachmentDownloadStreamsBinaryWithLegacyHeaders(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["messaging.read"] = true
	reader := &messageAttachmentDownloadTestReader{file: &messageAttachmentDownload{
		Filename: "résumé (final).bin", MimeType: "application/octet-stream", Content: []byte{0, 1, 2, 255},
	}}
	handler := newMessageAttachmentDownloadHandler(&fakeDirectSessionResolver{resolved: identity}, reader, slog.New(slog.NewTextHandler(io.Discard, nil)))
	response := httptest.NewRecorder()
	MountGoMessageAttachmentDownloadRoute(http.NotFoundHandler(), handler).ServeHTTP(response, messageAttachmentDownloadRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", response.Code, response.Body.String())
	}
	if got := response.Body.Bytes(); string(got) != string([]byte{0, 1, 2, 255}) {
		t.Fatalf("response body=%v, want original binary bytes", got)
	}
	if response.Header().Get("Content-Type") != "application/octet-stream" || response.Header().Get("Content-Disposition") != "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29.bin" || response.Header().Get("Content-Length") != "4" || response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("download headers differ from legacy contract: %#v", response.Header())
	}
	if reader.orgID != *identity.OrgID || reader.userID != identity.UserID || reader.fileID != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("reader scope = org %q user %q file %q", reader.orgID, reader.userID, reader.fileID)
	}
}

func TestMessageAttachmentDownloadRejectsMissingPermissionAndHidesMissingFile(t *testing.T) {
	identity := directTestIdentity()
	reader := &messageAttachmentDownloadTestReader{file: &messageAttachmentDownload{Filename: "secret", MimeType: "application/octet-stream"}}
	handler := newMessageAttachmentDownloadHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, messageAttachmentDownloadRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
	if response.Code != http.StatusForbidden {
		t.Fatalf("missing messaging.read status=%d, want 403", response.Code)
	}
	if reader.fileID != "" {
		t.Fatal("reader was called without the required permission")
	}

	identity.Permissions["messaging.read"] = true
	reader.file = nil
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, messageAttachmentDownloadRequest(http.MethodGet, "44444444-4444-4444-8444-444444444444"))
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "not found") {
		t.Fatalf("missing file response=%d %q, want privacy-preserving 404", response.Code, response.Body.String())
	}
}

func TestMountGoMessageAttachmentDownloadRouteOnlyOwnsAttachmentGets(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	router := MountGoMessageAttachmentDownloadRoute(legacy, goRoute)

	get := httptest.NewRecorder()
	router.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/message-attachments/44444444-4444-4444-8444-444444444444", nil))
	if get.Code != http.StatusAccepted {
		t.Fatalf("GET status=%d, want Go route 202", get.Code)
	}
	post := httptest.NewRecorder()
	router.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/message-attachments/44444444-4444-4444-8444-444444444444", nil))
	if post.Code != http.StatusTeapot {
		t.Fatalf("POST status=%d, want base handler 418", post.Code)
	}
}
