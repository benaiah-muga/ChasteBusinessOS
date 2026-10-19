package httpapi

import (
	"context"
	"encoding/json"
	"testing"
)

func scriptedTurnsForScenario(t *testing.T, scenarioID string) []chatTurn {
	t.Helper()
	switch scenarioID {
	case "inventory-proposal-low-stock":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{"sku":"CEM-1"}`)}}},
			{toolCalls: []chatToolCall{{ID: "call-2", Name: "purchasing_createPurchaseOrder", Arguments: json.RawMessage(`{"vendorId":"33333333-3333-4333-8333-333333333333","lines":[{"sku":"CEM-1","quantity":10000,"unitPriceMinor":500000}]}`)}}},
			{message: "The purchase order is waiting for approval. It has not been placed."},
		}
	case "inventory-incoming-covers":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{"sku":"CEM-1"}`)}}},
			{message: "No order is needed because incoming supply covers the gap."},
		}
	case "inventory-missing-history":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{"sku":"CEM-1"}`)}}},
			{message: "There is no sales history, so I did not prepare an order."},
		}
	case "quote-award-approval":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "purchasing_selectWinningQuote", Arguments: json.RawMessage(`{"rfqId":"44444444-4444-4444-8444-444444444444"}`)}}},
			{message: "The quote award is waiting for approval; no purchase order exists yet."},
		}
	case "receivables-aging":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "accounting_arAging", Arguments: json.RawMessage(`{}`)}}},
			{message: "The 90-plus bucket is 75,000 minor and total outstanding is 250,000 minor. No tasks were created."},
		}
	case "supplier-delay-risk":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{"sku":"CEM-1"}`)}}},
			{message: "The 30 day lead time exceeds 9 days of cover, so delivery risk is high. I did not place an order."},
		}
	case "purchase-order-partial-receipt":
		return []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "purchasing_getPurchaseOrder", Arguments: json.RawMessage(`{"poNumber":1042}`)}}},
			{message: "The order is partially received: 6000 units arrived and 4000 remain. No new order was placed."},
		}
	default:
		t.Fatalf("no scripted baseline for scenario %q", scenarioID)
		return nil
	}
}

// TestScriptedEvaluationBaseline keeps every scenario and fixture check
// coherent without a provider key. A new scenario fails here until it has a
// deterministic expected trajectory, which is the CI baseline for the harness.
func TestScriptedEvaluationBaseline(t *testing.T) {
	scenarios := evaluationScenarios()
	if len(scenarios) < 4 {
		t.Fatalf("scenario count=%d, want at least 4", len(scenarios))
	}
	for _, scenario := range scenarios {
		t.Run(scenario.ID, func(t *testing.T) {
			provider := &evaluationScriptedProvider{turns: scriptedTurnsForScenario(t, scenario.ID)}
			result := runEvaluationScenario(context.Background(), provider, scenario, "scripted-baseline")
			if result.Status != "passed" {
				for _, check := range result.Checks {
					if !check.Passed {
						t.Errorf("check %s failed: %s", check.ID, check.Detail)
					}
				}
				t.Fatalf("status=%s error=%s final=%q", result.Status, result.Error, result.FinalAnswer)
			}
		})
	}
}
