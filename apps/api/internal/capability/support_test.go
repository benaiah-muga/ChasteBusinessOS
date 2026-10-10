package capability

import (
	"encoding/json"
	"testing"
)

func TestParseSupportListConversationsCustomerBoundOnly(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    bool
		wantErr bool
	}{
		{name: "defaults off", input: `{}`, want: false},
		{name: "enabled", input: `{"customerBoundOnly":true}`, want: true},
		{name: "disabled", input: `{"customerBoundOnly":false}`, want: false},
		{name: "rejects null", input: `{"customerBoundOnly":null}`, wantErr: true},
		{name: "rejects non boolean", input: `{"customerBoundOnly":"true"}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := ParseSupportListConversationsInput(json.RawMessage(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseSupportListConversationsInput(%s) error=%v, wantErr=%t", tt.input, err, tt.wantErr)
			}
			if err == nil && parsed.CustomerBoundOnly != tt.want {
				t.Fatalf("customerBoundOnly=%t, want %t", parsed.CustomerBoundOnly, tt.want)
			}
		})
	}
}

func TestParseSupportLibraryInput(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "empty object", input: `{}`},
		{name: "rejects extra fields", input: `{"limit":1}`, wantErr: true},
		{name: "rejects null", input: `null`, wantErr: true},
		{name: "rejects trailing data", input: `{} {}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseSupportLibraryInput(json.RawMessage(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseSupportLibraryInput(%s) error=%v, wantErr=%t", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestParseSupportCreateKbArticlePublicationDefaultsPrivate(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    bool
		wantErr bool
	}{
		{name: "omitted defaults private", input: `{"title":"Returns","body":"Policy"}`},
		{name: "explicit private", input: `{"title":"Returns","body":"Policy","isPublic":false}`},
		{name: "explicit public", input: `{"title":"Returns","body":"Policy","isPublic":true}`, want: true},
		{name: "rejects null", input: `{"title":"Returns","body":"Policy","isPublic":null}`, wantErr: true},
		{name: "rejects string", input: `{"title":"Returns","body":"Policy","isPublic":"true"}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := ParseSupportCreateKbArticleInput(json.RawMessage(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseSupportCreateKbArticleInput(%s) error=%v, wantErr=%t", tt.input, err, tt.wantErr)
			}
			if err == nil && parsed.IsPublic != tt.want {
				t.Fatalf("isPublic=%t, want %t", parsed.IsPublic, tt.want)
			}
		})
	}
}

func TestParseSupportCreateCannedResponseRejectsUnknownFields(t *testing.T) {
	input := json.RawMessage(`{"shortcut":"/refund","title":"Refund help","body":"Refund guidance","orgId":"11111111-1111-4111-8111-111111111111"}`)
	if _, err := ParseSupportCreateCannedResponseInput(input); err == nil {
		t.Fatal("ParseSupportCreateCannedResponseInput accepted orgId override")
	}
}

func TestParseSupportConversationIDInputLimit(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    int64
		wantErr bool
	}{
		{name: "defaults to agent transcript limit", input: `{"conversationId":"11111111-1111-4111-8111-111111111111"}`, want: supportTranscriptMaxMessages},
		{name: "accepts full legacy detail limit", input: `{"conversationId":"11111111-1111-4111-8111-111111111111","limit":200}`, want: 200},
		{name: "rejects zero", input: `{"conversationId":"11111111-1111-4111-8111-111111111111","limit":0}`, wantErr: true},
		{name: "rejects over limit", input: `{"conversationId":"11111111-1111-4111-8111-111111111111","limit":201}`, wantErr: true},
		{name: "rejects fractional limit", input: `{"conversationId":"11111111-1111-4111-8111-111111111111","limit":1.5}`, wantErr: true},
		{name: "rejects null limit", input: `{"conversationId":"11111111-1111-4111-8111-111111111111","limit":null}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := ParseSupportConversationIDInput(json.RawMessage(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseSupportConversationIDInput(%s) error=%v, wantErr=%t", tt.input, err, tt.wantErr)
			}
			if err == nil && parsed.Limit != tt.want {
				t.Fatalf("limit=%d, want %d", parsed.Limit, tt.want)
			}
		})
	}
}
