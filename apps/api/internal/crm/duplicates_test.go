package crm

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func stringPointer(value string) *string {
	return &value
}

func normalizedValue(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func expectedVerdict(duplicate bool, reason *DuplicateReason, existingName *string) DuplicateVerdict {
	return DuplicateVerdict{Duplicate: duplicate, Reason: reason, ExistingName: existingName}
}

func reasonPointer(value DuplicateReason) *DuplicateReason {
	return &value
}

func TestNormalizeCustomerNameMatchesTypeScriptVectorsAndUnicodeBoundaries(t *testing.T) {
	for _, test := range []struct {
		name  string
		input string
		want  string
	}{
		{name: "legal suffix and case", input: "Acme LLC", want: "acme"},
		{name: "punctuation around suffix", input: "Acme, Incorporated!", want: "acme"},
		{name: "spaces punctuation and co suffix", input: "  North-Wind Trading Co. ", want: "north wind trading"},
		{name: "suffix only has no identity", input: "LLC", want: ""},
		{name: "repeated suffixes", input: "Acme Ltd LLC", want: "acme"},
		{name: "suffix chain with punctuation", input: "Acme, Inc. Limited!", want: "acme"},
		{name: "suffix must be a final token", input: "Acme Limited Partnership", want: "acme limited partnership"},
		{name: "non ASCII letters become separators without transliteration", input: "CAFÉ Corp", want: "caf"},
		{name: "combining marks collapse with adjacent punctuation", input: "North\u00adWind", want: "north wind"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := NormalizeCustomerName(test.input); got != test.want {
				t.Fatalf("NormalizeCustomerName(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestNormalizeEmailMatchesTypeScriptVectorsAndUnicodeCaseMapping(t *testing.T) {
	for _, test := range []struct {
		name  string
		input *string
		want  string
	}{
		{name: "ASCII trim and case", input: stringPointer("  Bill@Acme.COM "), want: "bill@acme.com"},
		{name: "nil", input: nil, want: "<nil>"},
		{name: "empty", input: stringPointer(""), want: "<nil>"},
		{name: "Unicode whitespace and BOM trim", input: stringPointer("\ufeff\u00a0USER@EXAMPLE.COM\u00a0\ufeff"), want: "user@example.com"},
		{name: "Unicode contextual lowercase", input: stringPointer("ΟΣ@EXAMPLE.COM"), want: "ος@example.com"},
		{name: "Unicode expanding lowercase", input: stringPointer("İ@EXAMPLE.COM"), want: "i\u0307@example.com"},
		{name: "ECMAScript does not trim next-line control", input: stringPointer("\u0085USER\u0085"), want: "\u0085user\u0085"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizedValue(NormalizeEmail(test.input)); got != test.want {
				t.Fatalf("NormalizeEmail(%v) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestNormalizePhoneMatchesTypeScriptVectorsAndASCIIOnlyDigits(t *testing.T) {
	for _, test := range []struct {
		name  string
		input *string
		want  string
	}{
		{name: "country prefix and punctuation", input: stringPointer("+256 (772) 123-456"), want: "772123456"},
		{name: "short fragment", input: stringPointer("12345"), want: "<nil>"},
		{name: "keep final nine digits", input: stringPointer("123456789012"), want: "456789012"},
		{name: "nil", input: nil, want: "<nil>"},
		{name: "Unicode numerals are not ASCII digits", input: stringPointer("٧٧٢١٢٣٤٥٦"), want: "<nil>"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizedValue(NormalizePhone(test.input)); got != test.want {
				t.Fatalf("NormalizePhone(%v) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestFindDuplicateMatchesTypeScriptVectorsAndFirstMatchPriority(t *testing.T) {
	for _, test := range []struct {
		name      string
		existing  []CustomerFingerprint
		candidate CustomerFingerprint
		want      DuplicateVerdict
	}{
		{
			name:      "email match beats name within row",
			existing:  []CustomerFingerprint{{Name: "Different Name Co", Email: stringPointer("Bill@Acme.com")}},
			candidate: CustomerFingerprint{Name: "another", Email: stringPointer("bill@acme.com")},
			want:      expectedVerdict(true, reasonPointer(DuplicateReasonEmail), stringPointer("Different Name Co")),
		},
		{
			name:      "normalized exact name",
			existing:  []CustomerFingerprint{{Name: "Acme LLC", Email: stringPointer("a@x.com")}},
			candidate: CustomerFingerprint{Name: "acme", Email: stringPointer("b@y.com")},
			want:      expectedVerdict(true, reasonPointer(DuplicateReasonName), stringPointer("Acme LLC")),
		},
		{
			name:      "normalized phone with country prefix",
			existing:  []CustomerFingerprint{{Name: "Northwind", Phone: stringPointer("+256 772 123 456")}},
			candidate: CustomerFingerprint{Name: "Different", Phone: stringPointer("0772-123-456")},
			want:      expectedVerdict(true, reasonPointer(DuplicateReasonPhone), stringPointer("Northwind")),
		},
		{
			name:      "conservative fuzzy name",
			existing:  []CustomerFingerprint{{Name: "Northwind Construction"}},
			candidate: CustomerFingerprint{Name: "Northwind Construcion"},
			want:      expectedVerdict(true, reasonPointer(DuplicateReasonSimilarName), stringPointer("Northwind Construction")),
		},
		{
			name:      "shorter name typo is below threshold",
			existing:  []CustomerFingerprint{{Name: "John Smith"}},
			candidate: CustomerFingerprint{Name: "John Smyth"},
			want:      expectedVerdict(false, nil, nil),
		},
		{
			name:      "different names and emails do not match",
			existing:  []CustomerFingerprint{{Name: "Globex", Email: stringPointer("g@x.com")}},
			candidate: CustomerFingerprint{Name: "Initech", Email: stringPointer("i@y.com")},
			want:      expectedVerdict(false, nil, nil),
		},
		{
			name: "first existing row wins before a later exact match",
			existing: []CustomerFingerprint{
				{Name: "Northwind Construcion"},
				{Name: "Northwind Construction"},
			},
			candidate: CustomerFingerprint{Name: "Northwind Construction"},
			want:      expectedVerdict(true, reasonPointer(DuplicateReasonSimilarName), stringPointer("Northwind Construcion")),
		},
		{
			name: "phone wins over exact name within row",
			existing: []CustomerFingerprint{{
				Name:  "Acme LLC",
				Email: stringPointer("old@example.com"),
				Phone: stringPointer("+256 772 123 456"),
			}},
			candidate: CustomerFingerprint{Name: "Acme", Email: stringPointer("new@example.com"), Phone: stringPointer("0772-123-456")},
			want:      expectedVerdict(true, reasonPointer(DuplicateReasonPhone), stringPointer("Acme LLC")),
		},
		{
			name:      "suffix only is not a name match",
			existing:  []CustomerFingerprint{{Name: "LLC"}},
			candidate: CustomerFingerprint{Name: "Co"},
			want:      expectedVerdict(false, nil, nil),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := FindDuplicate(test.existing, test.candidate)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("FindDuplicate() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestFindDuplicateUsesInclusiveSimilarityThreshold(t *testing.T) {
	base25 := strings.Repeat("a", 25)
	withinAtBoundary := strings.Repeat("a", 23) + "bc"
	base24 := strings.Repeat("a", 24)
	twoEditsBelowBoundary := strings.Repeat("a", 22) + "bc"

	if got := FindDuplicate([]CustomerFingerprint{{Name: base25}}, CustomerFingerprint{Name: withinAtBoundary}); got.Reason == nil || *got.Reason != DuplicateReasonSimilarName {
		t.Fatalf("25-character names at 0.92 similarity = %#v, want a similar-name match", got)
	}
	if got := FindDuplicate([]CustomerFingerprint{{Name: base24}}, CustomerFingerprint{Name: twoEditsBelowBoundary}); got.Duplicate {
		t.Fatalf("24-character names below 0.92 similarity = %#v, want no match", got)
	}
}

func TestDuplicateNullVerdictMarshalsNullFields(t *testing.T) {
	encoded, err := json.Marshal(FindDuplicate(nil, CustomerFingerprint{Name: "New customer"}))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(encoded), `{"duplicate":false,"reason":null,"existingName":null}`; got != want {
		t.Fatalf("JSON verdict = %s, want %s", got, want)
	}
}
