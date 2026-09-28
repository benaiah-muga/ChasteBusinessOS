package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestGoAccountingRecurringInputContracts(t *testing.T) {
	customerID := "22222222-2222-4222-8222-222222222222"
	taxCodeID := "33333333-3333-4333-8333-333333333333"
	templateID := "44444444-4444-4444-8444-444444444444"
	firstRunAt := "2026-10-01T09:30:00.123Z"

	full, err := ParseCreateRecurringTemplateInput(json.RawMessage(`{"customerId":"` + customerID + `","frequency":"monthly","memo":"Managed hosting","lines":[{"description":"Hosting","quantity":1500,"unitPriceMinor":9900,"taxMinor":743},{"description":"Support","quantity":1000,"unitPriceMinor":50000,"taxCodeId":"` + taxCodeID + `","ignored":true}],"firstRunAt":"` + firstRunAt + `","unknown":2}`))
	if err != nil {
		t.Fatal(err)
	}
	fullJSON, err := marshalJS(full)
	if err != nil {
		t.Fatal(err)
	}
	wantFull := `{"customerId":"` + customerID + `","frequency":"monthly","memo":"Managed hosting","lines":[{"description":"Hosting","quantity":1500,"unitPriceMinor":9900,"taxMinor":743},{"description":"Support","quantity":1000,"unitPriceMinor":50000,"taxCodeId":"` + taxCodeID + `"}],"firstRunAt":"` + firstRunAt + `"}`
	if string(fullJSON) != wantFull {
		t.Fatalf("parsed create input = %s, want %s", fullJSON, wantFull)
	}
	minimal, err := ParseCreateRecurringTemplateInput(json.RawMessage(`{"customerId":"` + customerID + `","frequency":"weekly","lines":[{"description":"Backup","quantity":1000,"unitPriceMinor":2500}]}`))
	if err != nil {
		t.Fatal(err)
	}
	minimalJSON, err := marshalJS(minimal)
	if err != nil {
		t.Fatal(err)
	}
	wantMinimal := `{"customerId":"` + customerID + `","frequency":"weekly","lines":[{"description":"Backup","quantity":1000,"unitPriceMinor":2500}]}`
	if string(minimalJSON) != wantMinimal {
		t.Fatalf("minimal create input = %s, want %s", minimalJSON, wantMinimal)
	}
	for _, raw := range []string{
		`{}`,
		`{"customerId":"not-a-uuid","frequency":"monthly","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"frequency":"monthly","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":null,"frequency":"monthly","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","frequency":"daily","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","frequency":null,"lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","frequency":7,"lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","memo":null,"lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","memo":"` + strings.Repeat("m", 301) + `","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly"}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":null}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":{}}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":["Hosting"]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"quantity":1000,"unitPriceMinor":9900}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"","quantity":1000,"unitPriceMinor":9900}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":null,"quantity":1000,"unitPriceMinor":9900}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":0,"unitPriceMinor":9900}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":-1000,"unitPriceMinor":9900}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1.5,"unitPriceMinor":9900}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":-1}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900,"taxMinor":-1}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900,"taxMinor":null}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900,"taxCodeId":"nope"}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900,"taxCodeId":null}]}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}],"firstRunAt":"2026-10-01T09:30:00+02:00"}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}],"firstRunAt":"next tuesday"}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}],"firstRunAt":null}`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}],"firstRunAt":123}`,
		`[]`,
		`null`,
		`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}]} trailing`,
	} {
		if _, err := ParseCreateRecurringTemplateInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateRecurringTemplateInput accepted %s", raw)
		}
	}
	if _, err := ParseCreateRecurringTemplateInput(json.RawMessage(`{"customerId":"` + customerID + `","frequency":"monthly","memo":"` + strings.Repeat("m", 300) + `","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}]}`)); err != nil {
		t.Fatalf("300-character memo rejected: %v", err)
	}
	_, err = ParseCreateRecurringTemplateInput(json.RawMessage(`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900,"taxMinor":1,"taxCodeId":"` + taxCodeID + `"}]}`))
	if err == nil || err.Error() != "use a configured tax code or a manual tax amount, not both" {
		t.Fatalf("combined tax fields error=%v, want the refine message", err)
	}

	paused, err := ParsePauseRecurringTemplateInput(json.RawMessage(`{"templateId":"` + templateID + `","unknown":1}`))
	if err != nil || paused.TemplateID != templateID {
		t.Fatalf("pause input=%+v err=%v", paused, err)
	}
	resumed, err := ParseResumeRecurringTemplateInput(json.RawMessage(`{"templateId":"` + templateID + `"}`))
	if err != nil || resumed.TemplateID != templateID {
		t.Fatalf("resume input=%+v err=%v", resumed, err)
	}
	for _, raw := range []string{`{}`, `{"templateId":"bad"}`, `{"templateId":null}`, `{"templateId":5}`, `[]`} {
		if _, err := ParsePauseRecurringTemplateInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePauseRecurringTemplateInput accepted %s", raw)
		}
		if _, err := ParseResumeRecurringTemplateInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseResumeRecurringTemplateInput accepted %s", raw)
		}
	}
	if _, err := ParseListRecurringTemplatesInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("empty list input rejected: %v", err)
	}
	if _, err := ParseListRecurringTemplatesInput(json.RawMessage(`{"ignored":true}`)); err != nil {
		t.Fatalf("list input with unknown field rejected: %v", err)
	}
	for _, raw := range []string{`null`, `[]`, `"templates"`, `{} trailing`} {
		if _, err := ParseListRecurringTemplatesInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseListRecurringTemplatesInput accepted %s", raw)
		}
	}

	outputs := []struct {
		value any
		want  string
	}{
		{CreateRecurringTemplateOutput{TemplateID: templateID, NextRunAt: firstRunAt}, `{"templateId":"` + templateID + `","nextRunAt":"` + firstRunAt + `"}`},
		{PauseRecurringTemplateOutput{Active: false}, `{"active":false}`},
		{ResumeRecurringTemplateOutput{Active: true}, `{"active":true}`},
		{ListRecurringTemplatesOutput{Templates: []RecurringTemplateSummary{}}, `{"templates":[]}`},
		{ListRecurringTemplatesOutput{Templates: []RecurringTemplateSummary{{ID: templateID, CustomerID: customerID, Frequency: "monthly", Active: true, NextRunAt: firstRunAt}}}, `{"templates":[{"id":"` + templateID + `","customerId":"` + customerID + `","frequency":"monthly","active":true,"nextRunAt":"` + firstRunAt + `"}]}`},
	}
	for _, output := range outputs {
		encoded, err := marshalJS(output.value)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != output.want {
			t.Fatalf("output = %s, want %s", encoded, output.want)
		}
	}
}

func TestGoAccountingRecurringCreatePersistsTemplates(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Recurring buyer")
	foreignCustomerID := seedCRMDealCustomer(t, fx, fx.otherOrgID, "Foreign buyer")
	actorID := fx.userID
	claims := authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
	now := time.Date(2026, 9, 27, 12, 0, 0, 125_000_000, time.UTC)

	input, err := ParseCreateRecurringTemplateInput(json.RawMessage(`{"customerId":"` + customerID + `","frequency":"monthly","memo":"Managed hosting","lines":[{"description":"Hosting","quantity":1500,"unitPriceMinor":9900,"taxMinor":743},{"description":"Support","quantity":1000,"unitPriceMinor":50000}],"firstRunAt":"2026-10-01T00:00:00.000Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRecurringTemplateOutput, error) {
		return createRecurringTemplate(fx.ctx, tx, claims, input, now)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.TemplateID) || created.NextRunAt != "2026-10-01T00:00:00.000Z" {
		t.Fatalf("create output=%+v, want template id and scheduled first run", created)
	}
	var frequency, memo, actorType string
	var linesMatch, active bool
	var nextRunAt time.Time
	var createdByActorID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT frequency, memo, lines = $3::jsonb, active, next_run_at, created_by_actor_type, created_by_actor_id::text
		FROM recurring_invoices WHERE org_id = $1::uuid AND id = $2::uuid`,
		fx.orgID, created.TemplateID,
		`[{"description":"Hosting","quantity":1500,"unitPriceMinor":9900,"taxMinor":743},{"description":"Support","quantity":1000,"unitPriceMinor":50000}]`).
		Scan(&frequency, &memo, &linesMatch, &active, &nextRunAt, &actorType, &createdByActorID); err != nil {
		t.Fatal(err)
	}
	firstRun := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if frequency != "monthly" || memo != "Managed hosting" || !linesMatch || !active || !nextRunAt.Equal(firstRun) ||
		actorType != "human" || createdByActorID == nil || *createdByActorID != fx.userID {
		t.Fatalf("stored template frequency=%q memo=%q lines=%t active=%t nextRunAt=%s actor=%s/%v", frequency, memo, linesMatch, active, nextRunAt, actorType, createdByActorID)
	}

	defaulted, err := ParseCreateRecurringTemplateInput(json.RawMessage(`{"customerId":"` + customerID + `","frequency":"weekly","lines":[{"description":"Backup","quantity":1000,"unitPriceMinor":2500}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defaultCreated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRecurringTemplateOutput, error) {
		return createRecurringTemplate(fx.ctx, tx, claims, defaulted, now)
	})
	if err != nil {
		t.Fatal(err)
	}
	if defaultCreated.NextRunAt != "2026-09-27T12:00:00.125Z" {
		t.Fatalf("defaulted next run = %q, want ctx.now", defaultCreated.NextRunAt)
	}
	var storedMemo *string
	var storedNextRun time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo, next_run_at FROM recurring_invoices WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, defaultCreated.TemplateID).Scan(&storedMemo, &storedNextRun); err != nil {
		t.Fatal(err)
	}
	if storedMemo != nil || !storedNextRun.Equal(now.Truncate(time.Millisecond)) {
		t.Fatalf("defaulted template memo=%v nextRunAt=%s, want null memo and ctx.now", storedMemo, storedNextRun)
	}

	lines := []CreateRecurringTemplateLine{{Description: "Hosting", Quantity: 1000, UnitPriceMinor: 9900}}
	for _, missingCustomer := range []string{foreignCustomerID, "55555555-5555-4555-8555-555555555555"} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRecurringTemplateOutput, error) {
			return createRecurringTemplate(fx.ctx, tx, claims, CreateRecurringTemplateInput{CustomerID: missingCustomer, Frequency: "weekly", Lines: lines}, now)
		})
		if err == nil || err.Error() != "customer not found" {
			t.Fatalf("create for customer %s error=%v, want customer not found", missingCustomer, err)
		}
	}
	if got := fx.count(`SELECT count(*) FROM recurring_invoices WHERE org_id=$1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("org templates=%d, want two", got)
	}
	if got := fx.count(`SELECT count(*) FROM recurring_invoices WHERE org_id=$1::uuid`, fx.otherOrgID); got != 0 {
		t.Fatalf("other org templates=%d, want zero", got)
	}
}

func TestGoAccountingRecurringPauseResumeTransitions(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Pause buyer")
	foreignCustomerID := seedCRMDealCustomer(t, fx, fx.otherOrgID, "Foreign pause buyer")
	scheduledFor := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	templateID := seedRecurringTemplate(t, fx, fx.orgID, seedRecurringTemplateValues{CustomerID: customerID, Frequency: "monthly", Lines: `[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}]`, Active: true, NextRunAt: scheduledFor, CreatedAt: scheduledFor})
	foreignTemplateID := seedRecurringTemplate(t, fx, fx.otherOrgID, seedRecurringTemplateValues{CustomerID: foreignCustomerID, Frequency: "weekly", Lines: `[{"description":"Foreign","quantity":1000,"unitPriceMinor":100}]`, Active: true, NextRunAt: scheduledFor, CreatedAt: scheduledFor})

	paused, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PauseRecurringTemplateOutput, error) {
		return pauseRecurringTemplate(fx.ctx, tx, fx.orgID, PauseRecurringTemplateInput{TemplateID: templateID})
	})
	if err != nil || paused.Active {
		t.Fatalf("pause result=%+v err=%v, want inactive", paused, err)
	}
	var active bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT active FROM recurring_invoices WHERE id=$1::uuid`, templateID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active {
		t.Fatal("pause left the template active")
	}
	again, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PauseRecurringTemplateOutput, error) {
		return pauseRecurringTemplate(fx.ctx, tx, fx.orgID, PauseRecurringTemplateInput{TemplateID: templateID})
	})
	if err != nil || again.Active {
		t.Fatalf("repeated pause result=%+v err=%v, want idempotent success", again, err)
	}

	for _, missingTemplate := range []string{foreignTemplateID, "66666666-6666-4666-8666-666666666666"} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PauseRecurringTemplateOutput, error) {
			return pauseRecurringTemplate(fx.ctx, tx, fx.orgID, PauseRecurringTemplateInput{TemplateID: missingTemplate})
		})
		if err == nil || err.Error() != "template not found" {
			t.Fatalf("pause %s error=%v, want template not found", missingTemplate, err)
		}
	}
	if got := fx.count(`SELECT count(*) FROM recurring_invoices WHERE id=$1::uuid AND active`, foreignTemplateID); got != 1 {
		t.Fatalf("foreign template active rows=%d, want untouched", got)
	}

	resumeAt := time.Date(2026, 10, 5, 8, 15, 30, 0, time.UTC)
	resumed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ResumeRecurringTemplateOutput, error) {
		return resumeRecurringTemplate(fx.ctx, tx, fx.orgID, ResumeRecurringTemplateInput{TemplateID: templateID}, resumeAt)
	})
	if err != nil || !resumed.Active {
		t.Fatalf("resume result=%+v err=%v, want active", resumed, err)
	}
	var nextRunAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT active, next_run_at FROM recurring_invoices WHERE id=$1::uuid`, templateID).Scan(&active, &nextRunAt); err != nil {
		t.Fatal(err)
	}
	if !active || !nextRunAt.Equal(resumeAt) {
		t.Fatalf("resumed template active=%t nextRunAt=%s, want active at %s", active, nextRunAt, resumeAt)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ResumeRecurringTemplateOutput, error) {
		return resumeRecurringTemplate(fx.ctx, tx, fx.orgID, ResumeRecurringTemplateInput{TemplateID: foreignTemplateID}, resumeAt)
	})
	if err == nil || err.Error() != "template not found" {
		t.Fatalf("foreign resume error=%v, want template not found", err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT next_run_at FROM recurring_invoices WHERE id=$1::uuid`, foreignTemplateID).Scan(&nextRunAt); err != nil {
		t.Fatal(err)
	}
	if !nextRunAt.Equal(scheduledFor) {
		t.Fatalf("foreign next_run_at=%s, want untouched schedule", nextRunAt)
	}
}

func TestGoAccountingRecurringListScopesOrdersAndFormats(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "List buyer")
	foreignCustomerID := seedCRMDealCustomer(t, fx, fx.otherOrgID, "Foreign list buyer")
	lines := `[{"description":"Hosting","quantity":1000,"unitPriceMinor":9900}]`
	oldest := seedRecurringTemplate(t, fx, fx.orgID, seedRecurringTemplateValues{CustomerID: customerID, Frequency: "weekly", Lines: lines, Active: true, NextRunAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), CreatedAt: time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)})
	middle := seedRecurringTemplate(t, fx, fx.orgID, seedRecurringTemplateValues{CustomerID: customerID, Frequency: "monthly", Lines: lines, Active: false, NextRunAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), CreatedAt: time.Date(2026, 8, 11, 9, 0, 0, 0, time.UTC)})
	newest := seedRecurringTemplate(t, fx, fx.orgID, seedRecurringTemplateValues{CustomerID: customerID, Frequency: "quarterly", Lines: lines, Active: true, NextRunAt: time.Date(2026, 10, 1, 9, 30, 0, 123_000_000, time.UTC), CreatedAt: time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC)})
	foreignTemplateID := seedRecurringTemplate(t, fx, fx.otherOrgID, seedRecurringTemplateValues{CustomerID: foreignCustomerID, Frequency: "weekly", Lines: lines, Active: true, NextRunAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), CreatedAt: time.Date(2026, 8, 13, 9, 0, 0, 0, time.UTC)})

	listed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListRecurringTemplatesOutput, error) {
		return listRecurringTemplates(fx.ctx, tx, fx.orgID)
	})
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"templates":[{"id":"` + newest + `","customerId":"` + customerID + `","frequency":"quarterly","active":true,"nextRunAt":"2026-10-01T09:30:00.123Z"},{"id":"` + middle + `","customerId":"` + customerID + `","frequency":"monthly","active":false,"nextRunAt":"2026-09-01T00:00:00.000Z"},{"id":"` + oldest + `","customerId":"` + customerID + `","frequency":"weekly","active":true,"nextRunAt":"2026-08-01T00:00:00.000Z"}]}`
	encoded, err := marshalJS(listed)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != wantJSON {
		t.Fatalf("list output = %s, want %s", encoded, wantJSON)
	}

	foreignListed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (ListRecurringTemplatesOutput, error) {
		return listRecurringTemplates(fx.ctx, tx, fx.otherOrgID)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(foreignListed.Templates) != 1 || foreignListed.Templates[0].ID != foreignTemplateID {
		t.Fatalf("other org templates=%+v, want only its own template", foreignListed.Templates)
	}
}

type seedRecurringTemplateValues struct {
	CustomerID string
	Frequency  string
	Lines      string
	Memo       *string
	Active     bool
	NextRunAt  time.Time
	CreatedAt  time.Time
}

func seedRecurringTemplate(t *testing.T, fx *executorFixture, orgID string, values seedRecurringTemplateValues) string {
	t.Helper()
	var memo any
	if values.Memo != nil {
		memo = *values.Memo
	}
	var templateID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO recurring_invoices (org_id, customer_id, frequency, lines, memo, active, next_run_at, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, 'human', $8)
		RETURNING id::text`, orgID, values.CustomerID, values.Frequency, values.Lines, memo, values.Active, values.NextRunAt, values.CreatedAt).Scan(&templateID); err != nil {
		t.Fatal(err)
	}
	return templateID
}
