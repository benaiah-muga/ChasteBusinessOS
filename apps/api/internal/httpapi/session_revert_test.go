package httpapi

import "testing"

func TestParseSessionRevertPath(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	if got, ok := parseSessionRevertPath("/api/sessions/" + id + "/revert"); !ok || got != id {
		t.Fatalf("got=%q ok=%t", got, ok)
	}
	for _, path := range []string{
		"/api/sessions/" + id,
		"/api/sessions/" + id + "/replay",
		"/api/sessions/not-a-uuid/revert",
		"/api/sessions/" + id + "/revert/extra",
	} {
		if _, ok := parseSessionRevertPath(path); ok {
			t.Fatalf("path %q should not parse", path)
		}
	}
}
