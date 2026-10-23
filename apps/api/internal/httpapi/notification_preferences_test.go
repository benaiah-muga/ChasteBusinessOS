package httpapi

import (
	"reflect"
	"testing"
)

func TestNormalizeMutedKindsDeduplicatesAndRejectsUnknownKinds(t *testing.T) {
	got, err := normalizeMutedKinds([]string{"system", " approval.requested ", "system"})
	if err != nil || !reflect.DeepEqual(got, []string{"approval.requested", "system"}) {
		t.Fatalf("normalizeMutedKinds = %v, %v", got, err)
	}
	if _, err := normalizeMutedKinds([]string{"not-a-kind"}); err == nil {
		t.Fatal("unknown kind was accepted")
	}
}
