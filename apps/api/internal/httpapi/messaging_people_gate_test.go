package httpapi

import "testing"

func TestMessagingPeopleDisabledCapabilitiesRequiresExplicitEnablement(t *testing.T) {
	if _, disabled := MessagingPeopleDisabledCapabilities(false)["messaging.listPeople"]; !disabled {
		t.Fatal("default-off gate did not disable messaging.listPeople")
	}
	if got := MessagingPeopleDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("enabled gate returned disabled capabilities: %v", got)
	}
}
