package jobs

import (
	"strconv"
	"testing"
	"time"
)

func TestRetryDelayMatchesLegacyExponentialBackoff(t *testing.T) {
	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: time.Second},
		{attempt: 8, want: 128 * time.Second},
		{attempt: 9, want: 256 * time.Second},
		{attempt: 10, want: maxBackoff},
		{attempt: 1_000_000, want: maxBackoff},
	}
	for _, test := range tests {
		t.Run("attempt_"+strconv.Itoa(test.attempt), func(t *testing.T) {
			if got := retryDelay(test.attempt); got != test.want {
				t.Fatalf("retryDelay(%d) = %s, want %s", test.attempt, got, test.want)
			}
		})
	}
}
