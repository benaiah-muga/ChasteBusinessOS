package httpapi

import (
	"encoding/json"
	"net/http"
)

// chatNDJSONWriter streams protocol events as newline-delimited JSON. The
// streaming client consumes complete lines, so each event is flushed
// immediately; once a write fails the client is gone and every later write
// is dropped instead of blocking the agent loop.
type chatNDJSONWriter struct {
	writer  http.ResponseWriter
	flusher http.Flusher
	closed  bool
}

func newChatNDJSONWriter(writer http.ResponseWriter, sessionID string) *chatNDJSONWriter {
	writer.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("X-Session-Id", sessionID)
	writer.WriteHeader(http.StatusOK)
	flusher, _ := writer.(http.Flusher)
	return &chatNDJSONWriter{writer: writer, flusher: flusher}
}

// write emits one compact JSON object plus newline. Marshal failures close the
// stream because a malformed event would desynchronize the client protocol.
func (s *chatNDJSONWriter) write(event map[string]any) {
	if s == nil || s.closed {
		return
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		s.closed = true
		return
	}
	encoded = append(encoded, '\n')
	if _, err := s.writer.Write(encoded); err != nil {
		s.closed = true
		return
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
}
