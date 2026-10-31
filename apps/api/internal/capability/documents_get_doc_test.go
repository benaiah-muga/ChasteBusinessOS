package capability

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestParseGetAuthoredDocumentInput(t *testing.T) {
	const validID = "11111111-1111-4111-8111-111111111111"
	input, err := parseGetAuthoredDocumentInput(json.RawMessage(`{"documentId":"` + validID + `","unknown":"stripped by zod"}`))
	if err != nil || input.DocumentID == nil || *input.DocumentID != validID {
		t.Fatalf("parsed input=%+v err=%v, want valid document id", input, err)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{}`),
		json.RawMessage(`[]`),
		json.RawMessage(`null`),
		json.RawMessage(`{"documentId":"bad"}`),
		json.RawMessage(`{"documentId":7}`),
	} {
		if _, err := parseGetAuthoredDocumentInput(raw); err == nil {
			t.Errorf("accepted invalid input %s", raw)
		}
	}
}

func TestParseAuthoredDocumentPageSettings(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		want DocumentsPageSettings
		bad  bool
	}{
		{name: "all defaults", raw: []byte(`{}`), want: defaultDocumentsPageSettings()},
		{name: "partial settings", raw: []byte(`{"size":"Letter","margin":"wide"}`), want: DocumentsPageSettings{Size: "Letter", Orientation: "portrait", Margin: "wide"}},
		{name: "unknown keys stripped", raw: []byte(`{"size":"A4","extra":true}`), want: defaultDocumentsPageSettings()},
		{name: "invalid size", raw: []byte(`{"size":"Legal"}`), bad: true},
		{name: "non-string orientation", raw: []byte(`{"orientation":false}`), bad: true},
		{name: "not an object", raw: []byte(`null`), bad: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseAuthoredDocumentPageSettings(tc.raw)
			if tc.bad {
				if err == nil {
					t.Fatalf("accepted invalid settings %s", tc.raw)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("settings=%+v err=%v, want %+v", got, err, tc.want)
			}
		})
	}
}
