package capability

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

const signalsListCapabilityID = "signals.list"

// BusinessSignal mirrors the kernel signal shape one-to-one: producers in the
// app layer emit these and the aggregator only sorts, dedupes, and filters.
type BusinessSignal struct {
	ID              string                         `json:"id"`
	Severity        string                         `json:"severity"`
	Module          string                         `json:"module"`
	Subject         string                         `json:"subject"`
	Detail          string                         `json:"detail"`
	Evidence        *BusinessSignalEvidence        `json:"evidence,omitempty"`
	SuggestedAction *BusinessSignalSuggestedAction `json:"suggestedAction,omitempty"`
}

type BusinessSignalEvidence struct {
	RefType string  `json:"refType"`
	RefID   *string `json:"refId,omitempty"`
}

type BusinessSignalSuggestedAction struct {
	CapabilityID string          `json:"capabilityId"`
	InputDraft   json.RawMessage `json:"inputDraft,omitempty"`
}

// SignalProducer is the Go mirror of the kernel's producer contract: pure
// collection for one org at one instant. Producers are registered by the app
// layer, so signal coverage grows with the install without this module
// importing a sibling.
type SignalProducer func(ctx context.Context, orgID string, now time.Time) ([]BusinessSignal, error)

var (
	signalsProducersMu sync.RWMutex
	signalsProducers   []SignalProducer
)

// RegisterSignalsProducer lets the app layer contribute signals to the
// aggregator. Safe for concurrent use.
func RegisterSignalsProducer(producer SignalProducer) {
	signalsProducersMu.Lock()
	defer signalsProducersMu.Unlock()
	signalsProducers = append(signalsProducers, producer)
}

type SignalsListInput struct {
	Severity *string `json:"severity"`
	Module   *string `json:"module"`
}

type SignalsListOutput struct {
	Signals []BusinessSignal `json:"signals"`
}

func ParseSignalsListInput(raw json.RawMessage) (SignalsListInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SignalsListInput{}, err
	}
	var input SignalsListInput
	if rawSeverity, ok := fields["severity"]; ok && string(rawSeverity) != "null" {
		var severity string
		if err := json.Unmarshal(rawSeverity, &severity); err != nil {
			return SignalsListInput{}, errors.New("severity must be a string")
		}
		if severity != "red" && severity != "orange" && severity != "green" {
			return SignalsListInput{}, errors.New("severity must be red, orange or green")
		}
		input.Severity = &severity
	}
	if rawModule, ok := fields["module"]; ok && string(rawModule) != "null" {
		var module string
		if err := json.Unmarshal(rawModule, &module); err != nil {
			return SignalsListInput{}, errors.New("module must be a string")
		}
		if len(module) < 2 || len(module) > 40 {
			return SignalsListInput{}, errors.New("module must be between 2 and 40 characters")
		}
		input.Module = &module
	}
	return input, nil
}

func parseSignalsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case signalsListCapabilityID:
		return ParseSignalsListInput(raw)
	default:
		return nil, errors.New("unsupported signals capability")
	}
}

var signalsSeverityRank = map[string]int{"red": 0, "orange": 1, "green": 2}

func signalsSort(signals []BusinessSignal) {
	sort.SliceStable(signals, func(i, j int) bool {
		bySeverity := signalsSeverityRank[signals[i].Severity] - signalsSeverityRank[signals[j].Severity]
		if bySeverity != 0 {
			return bySeverity < 0
		}
		return signals[i].Module+":"+signals[i].ID < signals[j].Module+":"+signals[j].ID
	})
}

func signalsList(ctx context.Context, orgID string, input SignalsListInput, now time.Time) (SignalsListOutput, error) {
	signalsProducersMu.RLock()
	producers := append([]SignalProducer{}, signalsProducers...)
	signalsProducersMu.RUnlock()

	var collected []BusinessSignal
	for _, producer := range producers {
		// A failing producer degrades to missing signals, never to a broken
		// aggregator - the dashboard must render regardless.
		produced, err := producer(ctx, orgID, now)
		if err != nil {
			continue
		}
		collected = append(collected, produced...)
	}
	seen := map[string]bool{}
	var flat []BusinessSignal
	for _, signal := range collected {
		if seen[signal.ID] {
			continue
		}
		seen[signal.ID] = true
		flat = append(flat, signal)
	}
	signalsSort(flat)
	var out []BusinessSignal
	for _, signal := range flat {
		if input.Severity != nil && signal.Severity != *input.Severity {
			continue
		}
		if input.Module != nil && signal.Module != *input.Module {
			continue
		}
		out = append(out, signal)
	}
	if out == nil {
		out = []BusinessSignal{}
	}
	return SignalsListOutput{Signals: out}, nil
}
