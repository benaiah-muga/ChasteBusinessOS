package capability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestIAMOrgSettingsParsersMirrorZodContracts(t *testing.T) {
	modules, err := ParseIAMSetModulesInput(json.RawMessage(`{"modules":["pos","inventory"]}`))
	if err != nil || len(modules.Modules) != 2 {
		t.Fatalf("modules parse=%+v err=%v", modules, err)
	}
	if _, err := ParseIAMSetModulesInput(json.RawMessage(`{"modules":[]}`)); err == nil {
		t.Fatal("empty modules refused")
	}
	config, err := ParseIAMSetModuleConfigInput(json.RawMessage(`{"module":"inventory","settings":{"defaultUnit":"pc"}}`))
	if err != nil || config.Module != "inventory" || string(config.Settings) != `{}` {
		t.Fatalf("config parse=%+v err=%v", config, err)
	}
	config, err = ParseIAMSetModuleConfigInput(json.RawMessage(`{"module":"inventory","settings":{"defaultUnitLabel":"  each ","defaultReorderPointUnits":3,"unknown":true}}`))
	if err != nil || string(config.Settings) != `{"defaultReorderPointUnits":3,"defaultUnitLabel":"each"}` {
		t.Fatalf("inventory settings should trim known fields and strip unknown keys, got %s err=%v", config.Settings, err)
	}
	if _, err := ParseIAMSetModuleConfigInput(json.RawMessage(`{"module":"inventory","settings":{"defaultUnitLabel":"😀😀😀😀😀😀😀😀😀😀"}}`)); err != nil {
		t.Fatalf("10 supplementary Unicode characters should fit the 20 UTF-16 code-unit limit: %v", err)
	}
	if _, err := ParseIAMSetModuleConfigInput(json.RawMessage(`{"module":"inventory","settings":[1]}`)); err == nil {
		t.Fatal("non-object settings refused")
	}
	for _, raw := range []string{
		`{"module":"inventory","settings":null}`,
		`{"module":"inventory","settings":{"defaultUnitLabel":" "}}`,
		`{"module":"inventory","settings":{"defaultUnitLabel":"123456789012345678901"}}`,
		`{"module":"inventory","settings":{"defaultReorderPointUnits":-1}}`,
		`{"module":"inventory","settings":{"defaultReorderPointUnits":1000001}}`,
		`{"module":"inventory","settings":{"defaultReorderPointUnits":1.5}}`,
	} {
		if _, err := ParseIAMSetModuleConfigInput(json.RawMessage(raw)); err == nil {
			t.Errorf("invalid module settings accepted: %s", raw)
		}
	}
	policy, err := ParseIAMSetOrgPolicyInput(json.RawMessage(`{"maxRiskAutonomous":"money","moneyThresholdMinor":250000,"requiresApprovalFor":["identity","*"]}`))
	if err != nil || policy.MaxRiskAutonomous != "money" || *policy.MoneyThresholdMinor != 250000 {
		t.Fatalf("policy parse=%+v err=%v", policy, err)
	}
	if _, err := ParseIAMSetOrgPolicyInput(json.RawMessage(`{"maxRiskAutonomous":"cosmic"}`)); err == nil {
		t.Fatal("unknown risk class refused")
	}
	if _, err := ParseIAMSetOrgPolicyInput(json.RawMessage(`{"maxRiskAutonomous":"read","requiresApprovalFor":null}`)); err == nil {
		t.Fatal("explicit null approval list should be rejected")
	}
	defaultPolicy, err := ParseIAMSetOrgPolicyInput(json.RawMessage(`{"maxRiskAutonomous":"read"}`))
	if err != nil || defaultPolicy.RequiresApprovalFor == nil || len(defaultPolicy.RequiresApprovalFor) != 0 {
		t.Fatalf("omitted approval list should default to empty array, policy=%+v err=%v", defaultPolicy, err)
	}
	branding, err := ParseIAMSetOrgBrandingInput(json.RawMessage(`{"accentColor":"#33AAFF","layout":"modern"}`))
	if err != nil || branding.Layout == nil || *branding.Layout != "modern" {
		t.Fatalf("branding parse=%+v err=%v", branding, err)
	}
	if _, err := ParseIAMSetOrgBrandingInput(json.RawMessage(`{"invoiceFooter":"` + strings.Repeat("😀", 150) + `"}`)); err != nil {
		t.Fatalf("300 UTF-16 code-unit footer should be accepted: %v", err)
	}
	if _, err := ParseIAMSetOrgBrandingInput(json.RawMessage(`{"invoiceFooter":"` + strings.Repeat("😀", 151) + `"}`)); err == nil {
		t.Fatal("301 UTF-16 code-unit footer should be rejected")
	}
	if _, err := ParseIAMSetOrgBrandingInput(json.RawMessage(`{"logoDataUrl":"data:text/plain;base64,AAA"}`)); err == nil {
		t.Fatal("non-image logo refused")
	}
	if _, err := parseIAMOrgSettingsInput(iamSetOrgBrandingCapabilityID, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("dispatcher refused branding: %v", err)
	}
	if _, err := parseIAMOrgSettingsInput("iam.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("dispatcher refused unknown id")
	}
}

func TestIAMOrgSettingsLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		set, err := iamSetModules(context.Background(), tx, fx.orgID, IAMModulesInput{Modules: []string{"pos", "inventory"}})
		if err != nil {
			return struct{}{}, err
		}
		if len(set.PreviousModules) != 0 {
			t.Fatalf("previous modules=%v, want empty on first set", set.PreviousModules)
		}
		next := map[string]bool{}
		for _, module := range set.EnabledModules {
			next[module] = true
		}
		for _, protected := range []string{"iam", "signals", "routines"} {
			if !next[protected] {
				t.Fatalf("enabled=%v, want protected module %s unioned in", set.EnabledModules, protected)
			}
		}
		if !next["pos"] {
			t.Fatalf("enabled=%v, want requested module pos", set.EnabledModules)
		}

		restored, err := iamRestoreModules(context.Background(), tx, fx.orgID, IAMModulesInput{Modules: []string{"accounting"}})
		if err != nil {
			return struct{}{}, err
		}
		restoredSet := map[string]bool{}
		for _, module := range restored.EnabledModules {
			restoredSet[module] = true
		}
		if restoredSet["pos"] || !restoredSet["accounting"] || !restoredSet["iam"] {
			t.Fatalf("restored=%v, want pos dropped and accounting added", restored.EnabledModules)
		}

		saved, err := iamSetModuleConfig(context.Background(), tx, fx.orgID, IAMSetModuleConfigInput{
			Module: "inventory", Settings: json.RawMessage(`{"defaultUnit":"pc"}`),
		})
		if err != nil || saved.Module != "inventory" {
			t.Fatalf("setModuleConfig output=%+v err=%v", saved, err)
		}
		resaved, err := iamSetModuleConfig(context.Background(), tx, fx.orgID, IAMSetModuleConfigInput{
			Module: "inventory", Settings: json.RawMessage(`{"defaultUnit":"box"}`),
		})
		if err != nil || string(resaved.Settings) != `{"defaultUnit":"box"}` {
			t.Fatalf("setModuleConfig resave=%+v err=%v", resaved, err)
		}

		policy, err := iamSetOrgPolicy(context.Background(), tx, fx.orgID, IAMSetOrgPolicyInput{
			MaxRiskAutonomous:   "money",
			RequiresApprovalFor: []string{"destructive"},
		})
		if err != nil || !policy.Saved {
			t.Fatalf("setOrgPolicy output=%+v err=%v", policy, err)
		}
		var pattern string
		var threshold *int64
		if err := tx.QueryRow(context.Background(), `
			SELECT capability_pattern, money_threshold_minor FROM policies WHERE org_id=$1::uuid AND capability_pattern='*'`,
			fx.orgID).Scan(&pattern, &threshold); err != nil {
			return struct{}{}, err
		}
		if pattern != "*" || threshold != nil {
			t.Fatalf("policy row pattern=%s threshold=%v, want wildcard with null threshold", pattern, threshold)
		}

		branding, err := iamSetOrgBranding(context.Background(), tx, fx.orgID, IAMSetOrgBrandingInput{
			AccentColor: strPtr("#33AAFF"), Layout: strPtr("modern"),
		}, time.Now().UTC())
		if err != nil || !branding.Saved {
			t.Fatalf("setOrgBranding output=%+v err=%v", branding, err)
		}
		merged, err := iamSetOrgBranding(context.Background(), tx, fx.orgID, IAMSetOrgBrandingInput{
			InvoiceFooter: strPtr("Thank you"),
		}, time.Now().UTC())
		if err != nil || !merged.Saved {
			t.Fatalf("setOrgBranding merge output=%+v err=%v", merged, err)
		}
		var accent, footer, layout string
		var logo *string
		if err := tx.QueryRow(context.Background(), `
			SELECT coalesce(accent_color,''), coalesce(invoice_footer,''), layout, logo_data_url
			FROM org_branding WHERE org_id=$1::uuid`, fx.orgID).Scan(&accent, &footer, &layout, &logo); err != nil {
			return struct{}{}, err
		}
		if accent != "#33AAFF" || footer != "Thank you" || layout != "modern" || logo != nil {
			t.Fatalf("branding row accent=%s footer=%s layout=%s logo=%v, want merged values with no logo", accent, footer, layout, logo)
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func strPtr(v string) *string {
	return &v
}
