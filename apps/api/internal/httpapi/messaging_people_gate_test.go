package httpapi

import "testing"

func TestMessagingPeopleDisabledCapabilitiesAllowsDefaultAndExplicitEnablement(t *testing.T) {
	if got := MessagingPeopleDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("enabled gate returned disabled capabilities: %v", got)
	}
	if _, disabled := MessagingPeopleDisabledCapabilities(false)["messaging.listPeople"]; !disabled {
		t.Fatal("explicit off gate did not disable messaging.listPeople")
	}
}
