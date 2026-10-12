package main

import "testing"

func TestGoDocumentsEditorWorkspaceEnabledFromEnvDefaultsOnAndSupportsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goDocumentsEditorWorkspaceEnabledFromEnv(test.value); got != test.want {
			t.Errorf("value %q enabled=%v want=%v", test.value, got, test.want)
		}
	}
}
