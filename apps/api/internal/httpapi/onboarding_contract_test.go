package httpapi

import (
	"encoding/json"
	"testing"
)

func TestOnboardingResponseAlwaysIncludesReplayState(t *testing.T) {
	const orgID = "d4d0f18b-d20c-421e-a7fc-78281a97cab4"

	for _, test := range []struct {
		name     string
		replayed bool
		want     string
	}{
		{name: "first create", replayed: false, want: `{"orgId":"` + orgID + `","replayed":false}`},
		{name: "replay", replayed: true, want: `{"orgId":"` + orgID + `","replayed":true}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(onboardingResponse{OrgID: orgID, Replayed: test.replayed})
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("onboarding response = %s, want %s", encoded, test.want)
			}
		})
	}
}
