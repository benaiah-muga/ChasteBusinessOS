package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseCreateCustomerInputAppliesTypeScriptDefaultsAndPhoneTrim(t *testing.T) {
	input, err := ParseCreateCustomerInput(json.RawMessage(`{"name":"Acme","phone":"  +256 772 123 456  ","email":"a@x.test"}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Name != "Acme" || input.Email == nil || *input.Email != "a@x.test" || input.Phone == nil || *input.Phone != "+256 772 123 456" || input.PreferredContactMethod != "email" || input.DoNotContact {
		t.Fatalf("parsed input = %+v, want normalized phone and schema defaults", input)
	}
}

func TestParseCreateCustomerInputRejectsInvalidBoundaryValues(t *testing.T) {
	for name, raw := range map[string]string{
		"not an object":             `null`,
		"missing name":              `{}`,
		"empty name":                `{"name":""}`,
		"null name":                 `{"name":null}`,
		"name too long":             `{"name":"` + strings.Repeat("n", 121) + `"}`,
		"invalid email":             `{"name":"Acme","email":"bad"}`,
		"null email":                `{"name":"Acme","email":null}`,
		"null phone":                `{"name":"Acme","phone":null}`,
		"null contact method":       `{"name":"Acme","preferredContactMethod":null}`,
		"unknown contact method":    `{"name":"Acme","preferredContactMethod":"sms"}`,
		"null do not contact":       `{"name":"Acme","doNotContact":null}`,
		"wrong do not contact type": `{"name":"Acme","doNotContact":"false"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseCreateCustomerInput(json.RawMessage(raw)); err == nil {
				t.Fatalf("ParseCreateCustomerInput(%s) accepted invalid input", raw)
			}
		})
	}
}

func TestParseCreateCustomerInputStripsUnknownFieldsLikeZodObject(t *testing.T) {
	input, err := ParseCreateCustomerInput(json.RawMessage(`{"name":"Acme","intentId":"client-controlled","extra":{"ignored":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Name != "Acme" || input.Email != nil || input.Phone != nil {
		t.Fatalf("parsed input = %+v, unknown fields should be stripped", input)
	}
}

func TestCustomerEmailValidationMatchesZodEmailVectors(t *testing.T) {
	for _, value := range []string{"a@b.com", "first.last+tag@example.co", "a@b-.com"} {
		if !validCustomerEmail(value) {
			t.Errorf("validCustomerEmail(%q) = false, want true", value)
		}
	}
	for _, value := range []string{"bad", ".a@b.com", "a..b@c.com", "a@b.c", "a@b.c1"} {
		if validCustomerEmail(value) {
			t.Errorf("validCustomerEmail(%q) = true, want false", value)
		}
	}
}

func TestParseCreateCustomerInputUsesUTF16LengthLikeJavaScript(t *testing.T) {
	oneTwentyCharacters := strings.Repeat("n", 120)
	if _, err := ParseCreateCustomerInput(json.RawMessage(`{"name":"` + oneTwentyCharacters + `"}`)); err != nil {
		t.Fatalf("120-character customer name was rejected: %v", err)
	}
	fortyEmoji := ""
	for range 20 {
		fortyEmoji += "😀"
	}
	if _, err := ParseCreateCustomerInput(json.RawMessage(`{"name":"Acme","phone":"` + fortyEmoji + `"}`)); err != nil {
		t.Fatalf("40 UTF-16 code units were rejected: %v", err)
	}
	fortyTwoEmoji := fortyEmoji + "😀"
	if _, err := ParseCreateCustomerInput(json.RawMessage(`{"name":"Acme","phone":"` + fortyTwoEmoji + `"}`)); err == nil {
		t.Fatal("42 UTF-16 code units were accepted")
	}
}

func TestCanonicalCustomerInputHashUsesKernelSortedJSON(t *testing.T) {
	input := CreateCustomerInput{Name: "Acme", PreferredContactMethod: "email"}
	got, err := CanonicalInputHash(input)
	if err != nil {
		t.Fatal(err)
	}
	const want = "ad4445d3daf42e13b83ab46c2336a47666c2ac637d004a3e88867e763a1c8ca1"
	if got != want {
		t.Fatalf("CanonicalInputHash() = %q, want TypeScript canonical hash %q", got, want)
	}
}

func TestInputHashIgnoresJSONObjectKeyOrder(t *testing.T) {
	first, err := InputHash(json.RawMessage(`{"name":"Acme","phone":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	second, err := InputHash(json.RawMessage(` { "phone" : "x", "name" : "Acme" } `))
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("canonical input digests differ: %s != %s", first, second)
	}
}
