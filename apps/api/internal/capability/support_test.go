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
