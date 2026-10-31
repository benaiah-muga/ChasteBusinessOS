package jobs

import (
	"context"
	"errors"
	"strconv"
	"sync/atomic"
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

func TestLeaseHeartbeatStopsWorkWhenRenewalFails(t *testing.T) {
	for _, test := range []struct {
		name  string
		owned bool
		err   error
	}{
		{name: "lease ownership lost", owned: false},
		{name: "renewal errored", owned: true, err: errors.New("database unavailable")},
	} {
		t.Run(test.name, func(t *testing.T) {
			parent, cancelParent := context.WithCancel(context.Background())
			defer cancelParent()
			workCtx, cancelWork := context.WithCancel(parent)
			defer cancelWork()
			var lost atomic.Bool
			renewed := make(chan struct{}, 1)
			stop := startLeaseHeartbeat(parent, time.Millisecond, func(context.Context) (bool, error) {
				renewed <- struct{}{}
				return test.owned, test.err
			}, func() {
				lost.Store(true)
				cancelWork()
			})
			defer stop()

			select {
			case <-workCtx.Done():
			case <-time.After(time.Second):
				t.Fatal("work context remained active after lease renewal failed")
			}
			if !lost.Load() {
				t.Fatal("lease failure did not mark ownership lost")
			}
			select {
			case <-renewed:
			case <-time.After(time.Second):
				t.Fatal("heartbeat did not attempt renewal")
			}
		})
	}
}

func TestEffectHeartbeatGateWaitsOutRenewalAndSkipsDuringEffect(t *testing.T) {
	gate := &effectHeartbeatGate{}
	renewStarted := make(chan struct{})
	finishRenew := make(chan struct{})
	var renewCalls atomic.Int32
	renewDone := make(chan struct{})
	go func() {
		defer close(renewDone)
		_, _ = gate.renew(context.Background(), func(context.Context) (bool, error) {
			renewCalls.Add(1)
			close(renewStarted)
			<-finishRenew
			return true, nil
		})
	}()
	<-renewStarted
	var endEffect func()
	beginDone := make(chan struct{})
	go func() {
		endEffect = gate.beginEffect()
		close(beginDone)
	}()
	select {
	case <-beginDone:
		t.Fatal("effect started while a renewal still owned the coordination gate")
	case <-time.After(10 * time.Millisecond):
	}
	close(finishRenew)
	<-renewDone
	<-beginDone

	owned, err := gate.renew(context.Background(), func(context.Context) (bool, error) {
		renewCalls.Add(1)
		return false, errors.New("renewal must be skipped during the effect")
	})
	if err != nil || !owned || renewCalls.Load() != 1 {
		t.Fatalf("renew during effect owned=%v err=%v calls=%d, want skip", owned, err, renewCalls.Load())
	}
	endEffect()
	owned, err = gate.renew(context.Background(), func(context.Context) (bool, error) {
		renewCalls.Add(1)
		return true, nil
	})
	if err != nil || !owned || renewCalls.Load() != 2 {
		t.Fatalf("renew after effect owned=%v err=%v calls=%d, want renewal", owned, err, renewCalls.Load())
	}
}
