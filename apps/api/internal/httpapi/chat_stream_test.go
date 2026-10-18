package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatNDJSONWriterSetsStreamHeadersAndFlushes(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := newChatNDJSONWriter(recorder, "11111111-1111-4111-8111-111111111111")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/x-ndjson; charset=utf-8" {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-cache, no-transform" {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := recorder.Header().Get("X-Session-Id"); got != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("X-Session-Id=%q", got)
	}
	writer.write(map[string]any{"type": "delta", "text": "hi"})
	writer.write(map[string]any{"type": "done", "reply": "ok"})
	if !recorder.Flushed {
		t.Fatal("writer did not flush after an event; NDJSON clients need line-by-line delivery")
	}
	lines := strings.Split(strings.TrimSuffix(recorder.Body.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines=%d body=%q, want one JSON object per line", len(lines), recorder.Body.String())
	}
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("line %q is not compact JSON: %v", line, err)
		}
	}
}

type failingResponseWriter struct {
	header http.Header
}

func (f *failingResponseWriter) Header() http.Header {
	if f.header == nil {
		f.header = http.Header{}
	}
	return f.header
}

func (f *failingResponseWriter) Write([]byte) (int, error) { return 0, errors.New("client gone") }
func (f *failingResponseWriter) WriteHeader(int)           {}

func TestChatNDJSONWriterDropsEventsAfterWriteFailure(t *testing.T) {
	writer := newChatNDJSONWriter(&failingResponseWriter{}, "session")
	writer.write(map[string]any{"type": "delta", "text": "one"})
	if !writer.closed {
		t.Fatal("writer did not close after a failed write; later writes would keep hitting a dead client")
	}
	writer.write(map[string]any{"type": "done"})
}

func TestChatNDJSONWriterMarshalsRawArguments(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := newChatNDJSONWriter(recorder, "session")
	writer.write(map[string]any{"type": "tool", "args": json.RawMessage(`{"query":"a"}`)})
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"args":{"query":"a"}`)) {
		t.Fatalf("body=%q, want raw JSON args embedded", recorder.Body.String())
	}
}
