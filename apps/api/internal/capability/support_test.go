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
