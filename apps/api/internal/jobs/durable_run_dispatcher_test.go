package jobs

import (
	"strings"
	"testing"
)

func TestValidateDurableRunInputBoundsAndCapabilityContract(t *testing.T) {
	valid := StartDurableRunInput{
		RunID: "11111111-1111-4111-8111-111111111111", OrgID: "22222222-2222-4222-8222-222222222222",
		ActorID: "33333333-3333-4333-8333-333333333333", Goal: "Read the customer list", RegistryVersion: "1",
		HarnessCompositionID: "44444444-4444-4444-8444-444444444444", CompositionApprovalID: "55555555-5555-4555-8555-555555555555",
		Steps: []DurableRunStepInput{{CapabilityID: "crm.listCustomers", Input: []byte(`{}`)}},
	}
	if err := validateDurableRunInput(valid); err != nil {
		t.Fatalf("valid run input rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*StartDurableRunInput)
	}{
		{"bad run id", func(input *StartDurableRunInput) { input.RunID = "not-a-uuid" }},
		{"empty goal", func(input *StartDurableRunInput) { input.Goal = "" }},
		{"oversized goal", func(input *StartDurableRunInput) { input.Goal = strings.Repeat("a", DurableRunMaxGoalUTF16+1) }},
		{"unsupported capability", func(input *StartDurableRunInput) { input.Steps[0].CapabilityID = "legacy.unsupported" }},
		{"non-object input", func(input *StartDurableRunInput) { input.Steps[0].Input = []byte(`[]`) }},
		{"oversized input", func(input *StartDurableRunInput) {
			input.Steps[0].Input = []byte(`{"value":"` + strings.Repeat("a", DurableRunMaxStepInput) + `"}`)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			input := valid
			input.Steps = append([]DurableRunStepInput(nil), valid.Steps...)
			test.mutate(&input)
			if err := validateDurableRunInput(input); err == nil {
				t.Fatal("invalid run input accepted")
			}
		})
	}
}
