package httpapi

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveEvaluationAgainstDeepSeek is the opt-in live evaluation. CI skips it
// because it spends provider tokens; run it locally with EVALUATION_LIVE=1.
func TestLiveEvaluationAgainstDeepSeek(t *testing.T) {
	if os.Getenv("DEEPSEEK_API_KEY") == "" {
		t.Skip("DEEPSEEK_API_KEY is not configured")
	}
	if os.Getenv("EVALUATION_LIVE") != "1" {
		t.Skip("set EVALUATION_LIVE=1 to run the live model evaluation")
	}
	provider, model, err := evaluationProviderFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	scenario, ok := findEvaluationScenario("inventory-proposal-low-stock")
	if !ok {
		t.Fatal("scenario missing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	result := runEvaluationScenario(ctx, provider, scenario, model)
	t.Logf("model=%s status=%s duration=%dms usage=%+v tools=%d", result.Model, result.Status, result.DurationMS, result.Usage, len(result.ToolCalls))
	for _, call := range result.ToolCalls {
		t.Logf("tool=%s args=%s", call.Name, call.Arguments)
	}
	t.Logf("final=%s", result.FinalAnswer)
	for _, check := range result.Checks {
		t.Logf("check=%s passed=%t detail=%s", check.ID, check.Passed, check.Detail)
	}
	if result.Status != "passed" {
		t.Fatalf("live evaluation status=%s error=%s", result.Status, result.Error)
	}
}
