package jobs

import (
	"fmt"
	"testing"
	"time"
)

func TestRoutineCandidatesAreGloballyOrderedAndBounded(t *testing.T) {
	base := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	candidates := make([]dueRoutineCandidate, 15)
	for index := range candidates {
		candidates[index] = dueRoutineCandidate{
			RoutineID:   fmt.Sprintf("routine-%02d", index),
			OrgID:       fmt.Sprintf("org-%d", index%3),
			ScheduledAt: base.Add(time.Duration(index) * time.Minute),
		}
	}
	selected := limitRoutineCandidates(candidates, routineScheduleBatchSize)
	if len(selected) != routineScheduleBatchSize {
		t.Fatalf("selected candidate count=%d, want %d", len(selected), routineScheduleBatchSize)
	}
	for index, candidate := range selected {
		want := fmt.Sprintf("routine-%02d", index)
		if candidate.RoutineID != want {
			t.Fatalf("candidate at index %d=%s, want %s", index, candidate.RoutineID, want)
		}
	}
}
