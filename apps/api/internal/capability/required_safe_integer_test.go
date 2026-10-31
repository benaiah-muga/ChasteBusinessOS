package capability

import (
	"encoding/json"
	"testing"
)

// requiredSafeInteger is the shared parser behind 81 call sites. It must match
// Zod's z.number(): numbers yes, quoted numbers no. json.Unmarshal decodes a
// quoted "5" into a json.Number without complaint, so the guard has to be
// explicit or Go accepts input the TypeScript runtime refuses.
func TestRequiredSafeIntegerMatchesZodNumber(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		want    int64
		wantErr bool
	}{
		{name: "integer", raw: `{"n":5}`, want: 5},
		{name: "negative integer", raw: `{"n":-5}`, want: -5},
		{name: "zero", raw: `{"n":0}`, want: 0},
		// JS accepts integral numeric spellings, and Zod z.number() does too
		// because it reads the parsed JS number.
		{name: "integral float spelling", raw: `{"n":2.0}`, want: 2},
		{name: "exponent spelling", raw: `{"n":1e3}`, want: 1000},
		{name: "fractional", raw: `{"n":5.5}`, wantErr: true},
		{name: "quoted integer", raw: `{"n":"5"}`, wantErr: true},
		{name: "quoted integral float", raw: `{"n":"2.0"}`, wantErr: true},
		{name: "quoted non numeric", raw: `{"n":"abc"}`, wantErr: true},
		{name: "missing", raw: `{}`, wantErr: true},
		{name: "null", raw: `{"n":null}`, wantErr: true},
		{name: "boolean", raw: `{"n":true}`, wantErr: true},
		{name: "above safe integer", raw: `{"n":9007199254740993}`, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tc.raw), &fields); err != nil {
				t.Fatalf("fixture is not valid JSON: %v", err)
			}
			got, err := requiredSafeInteger(fields, "n")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("requiredSafeInteger(%s) = %d, want an error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("requiredSafeInteger(%s) returned %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("requiredSafeInteger(%s) = %d, want %d", tc.raw, got, tc.want)
			}
		})
	}
}
