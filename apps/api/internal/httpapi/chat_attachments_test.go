package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeChatSessionRequestAcceptsGovernedSources(t *testing.T) {
	body := `{"message":"What changed on this invoice?","attachments":[{"type":"invoice","id":"11111111-1111-4111-8111-111111111111","title":"Invoice #1042"}]}`
	request := httptest.NewRequest("POST", "/api/chat", strings.NewReader(body))
	response := httptest.NewRecorder()
	parsed, ok := decodeChatSessionRequest(response, request)
	if !ok || len(parsed.attachments) != 1 || parsed.attachments[0].Title != "Invoice #1042" {
		t.Fatalf("parsed=%+v status=%d body=%s", parsed, response.Code, response.Body.String())
	}
}

func TestDecodeChatSessionRequestRejectsUnsafeSources(t *testing.T) {
	cases := []string{
		`{"message":"Hi","attachments":[{"type":"unknown","id":"11111111-1111-4111-8111-111111111111","title":"x"}]}`,
		`{"message":"Hi","attachments":[{"type":"invoice","id":"not-a-uuid","title":"x"}]}`,
		`{"message":"Hi","attachments":[{"type":"invoice","id":"11111111-1111-4111-8111-111111111111","title":""}]}`,
	}
	for _, body := range cases {
		request := httptest.NewRequest("POST", "/api/chat", strings.NewReader(body))
		response := httptest.NewRecorder()
		if _, ok := decodeChatSessionRequest(response, request); ok {
			t.Fatalf("unsafe source accepted: %s", body)
		}
	}
}

func TestChatGoalWithAttachmentsNamesExactIds(t *testing.T) {
	goal := chatGoalWithAttachments("What changed?", []chatAttachment{{Type: "invoice", ID: "11111111-1111-4111-8111-111111111111", Title: "Invoice #1042"}})
	if !strings.Contains(goal, "Invoice #1042") || !strings.Contains(goal, "11111111-1111-4111-8111-111111111111") || !strings.Contains(goal, "do not invent ids") {
		t.Fatalf("goal=%q", goal)
	}
}

func TestChatHistoryTextKeepsEarlierSources(t *testing.T) {
	text := chatHistoryTextWithSources("Use that one", []any{map[string]any{
		"type": "invoice", "id": "11111111-1111-4111-8111-111111111111", "title": "Invoice #1042",
	}})
	if !strings.Contains(text, "Invoice #1042") || !strings.Contains(text, "Attached sources from the earlier turn") {
		t.Fatalf("history text=%q", text)
	}
}
