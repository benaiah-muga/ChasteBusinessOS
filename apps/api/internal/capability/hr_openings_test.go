package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func hrOpeningsInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, run func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, run)
	if err != nil {
		t.Fatalf("HR openings transaction: %v", err)
	}
	return output
}

func hrOpeningsExpectError(t *testing.T, fx *executorFixture, orgID, wantErr string, run func(tx pgx.Tx) error) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, run(tx)
	}); err == nil || err.Error() != wantErr {
		t.Fatalf("HR openings error = %v, want %q", err, wantErr)
	}
}

func TestHROpeningsParsersMirrorZodContracts(t *testing.T) {
	openingUUID := "11111111-1111-4111-8111-111111111111"
	created, err := ParseHRCreateOpeningInput(json.RawMessage(`{"title":"Field Technician","department":"Field Ops","note":"Night shift","unknown":true}`))
	if err != nil || created.Title != "Field Technician" || created.Department == nil || *created.Department != "Field Ops" || created.Note == nil || *created.Note != "Night shift" {
		t.Fatalf("ParseHRCreateOpeningInput() = %+v, %v", created, err)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != `{"title":"Field Technician","department":"Field Ops","note":"Night shift"}` {
		t.Fatalf("createOpening input JSON = %s, %v", encoded, err)
	}
	minimal, err := ParseHRCreateOpeningInput(json.RawMessage(`{"title":"Min"}`))
	if err != nil || minimal.Title != "Min" || minimal.Department != nil || minimal.Note != nil {
		t.Fatalf("minimal createOpening input=%+v err=%v, want absent optional fields", minimal, err)
	}
	astral := "a\U0001F600"
	if _, err := ParseHRCreateOpeningInput(json.RawMessage(`{"title":"` + strings.Repeat(astral, 40) + `"}`)); err != nil {
		t.Fatalf("astral title counts UTF-16 code units, err = %v", err)
	}
	if _, err := ParseHRCreateOpeningInput(json.RawMessage(`{"title":"` + strings.Repeat("x", 120) + `"}`)); err != nil {
		t.Fatalf("ParseHRCreateOpeningInput(120 chars) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`{"title":""}`,
		`{"title":"` + strings.Repeat("x", 121) + `"}`,
		`{"title":null}`,
		`{"title":5}`,
		`{"title":"Role","department":"` + strings.Repeat("x", 101) + `"}`,
		`{"title":"Role","department":null}`,
		`{"title":"Role","note":"` + strings.Repeat("x", 501) + `"}`,
		`{"title":"Role","note":null}`,
		`[]`,
	} {
		if _, err := ParseHRCreateOpeningInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRCreateOpeningInput accepted %s", raw)
		}
	}

	closed, err := ParseHRCloseOpeningInput(json.RawMessage(`{"openingId":"` + openingUUID + `","unknown":1}`))
	if err != nil || closed.OpeningID != openingUUID {
		t.Fatalf("ParseHRCloseOpeningInput() = %+v, %v", closed, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"openingId":"nope"}`,
		`{"openingId":null}`,
		`{"openingId":"11111111-1111-0111-8111-111111111111"}`,
		`{"openingId":5}`,
		`[]`,
	} {
		if _, err := ParseHRCloseOpeningInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRCloseOpeningInput accepted %s", raw)
		}
	}

	if _, err := parseHROpeningInput("hr.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported HR opening capability" {
		t.Fatalf("parseHROpeningInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		hrCreateOpeningCapabilityID: `{"title":"Role"}`,
		hrCloseOpeningCapabilityID:  `{"openingId":"` + openingUUID + `"}`,
	} {
		if _, err := parseHROpeningInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseHROpeningInput(%s) err = %v", capabilityID, err)
		}
	}
}

func TestHROpeningsCreateAndCloseLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)

	created := hrOpeningsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCreateOpeningOutput, error) {
		return hrCreateOpening(fx.ctx, tx, fx.orgID, HRCreateOpeningInput{Title: "Field Technician", Department: crmStringPointer("Field Ops"), Note: crmStringPointer("Night shift")})
	})
	if !isUUID(created.OpeningID) {
		t.Fatalf("hrCreateOpening output = %+v, want an opening id", created)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != fmt.Sprintf(`{"openingId":%q}`, created.OpeningID) {
		t.Fatalf("hrCreateOpening output JSON = %s, %v", encoded, err)
	}
	var title, department, note, status string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT title, department, note, status
		FROM job_openings WHERE id = $1::uuid AND org_id = $2::uuid`, created.OpeningID, fx.orgID).
		Scan(&title, &department, &note, &status); err != nil {
		t.Fatal(err)
	}
	if title != "Field Technician" || department != "Field Ops" || note != "Night shift" || status != "open" {
		t.Fatalf("stored opening = %q %q %q %s, want the full row defaulting to open", title, department, note, status)
	}

	minimal := hrOpeningsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCreateOpeningOutput, error) {
		return hrCreateOpening(fx.ctx, tx, fx.orgID, HRCreateOpeningInput{Title: "Minimal Role"})
	})
	var minimalDepartment, minimalNote *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT department, note, status FROM job_openings WHERE id = $1::uuid`, minimal.OpeningID).
		Scan(&minimalDepartment, &minimalNote, &status); err != nil {
		t.Fatal(err)
	}
	if minimalDepartment != nil || minimalNote != nil || status != "open" {
		t.Fatalf("minimal opening = %v %v %s, want null department and note with open status", minimalDepartment, minimalNote, status)
	}

	foreign := hrOpeningsInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (HRCreateOpeningOutput, error) {
		return hrCreateOpening(fx.ctx, tx, fx.otherOrgID, HRCreateOpeningInput{Title: "Foreign Role"})
	})
	var foreignOrg string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT org_id::text FROM job_openings WHERE id = $1::uuid`, foreign.OpeningID).Scan(&foreignOrg); err != nil {
		t.Fatal(err)
	}
	if foreignOrg != fx.otherOrgID {
		t.Fatalf("foreign opening org = %s, want %s", foreignOrg, fx.otherOrgID)
	}

	closed := hrOpeningsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCloseOpeningOutput, error) {
		return hrCloseOpening(fx.ctx, tx, fx.orgID, HRCloseOpeningInput{OpeningID: created.OpeningID})
	})
	if !closed.Closed {
		t.Fatalf("hrCloseOpening output = %+v, want closed", closed)
	}
	if encoded, err := marshalJS(closed); err != nil || string(encoded) != `{"closed":true}` {
		t.Fatalf("hrCloseOpening output JSON = %s, %v", encoded, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM job_openings WHERE id = $1::uuid`, created.OpeningID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "closed" {
		t.Fatalf("closed opening status = %s, want closed", status)
	}
	reclosed := hrOpeningsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCloseOpeningOutput, error) {
		return hrCloseOpening(fx.ctx, tx, fx.orgID, HRCloseOpeningInput{OpeningID: created.OpeningID})
	})
	if !reclosed.Closed {
		t.Fatalf("re-closing = %+v, want the TS update to stay idempotent", reclosed)
	}

	hrOpeningsExpectError(t, fx, fx.orgID, "opening not found", func(tx pgx.Tx) error {
		_, err := hrCloseOpening(fx.ctx, tx, fx.orgID, HRCloseOpeningInput{OpeningID: executorUUID(t)})
		return err
	})
	hrOpeningsExpectError(t, fx, fx.orgID, "opening not found", func(tx pgx.Tx) error {
		_, err := hrCloseOpening(fx.ctx, tx, fx.orgID, HRCloseOpeningInput{OpeningID: foreign.OpeningID})
		return err
	})
	foreignClosed := hrOpeningsInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (HRCloseOpeningOutput, error) {
		return hrCloseOpening(fx.ctx, tx, fx.otherOrgID, HRCloseOpeningInput{OpeningID: foreign.OpeningID})
	})
	if !foreignClosed.Closed {
		t.Fatalf("foreign close = %+v, want its own organization able to close", foreignClosed)
	}

	applicantID := seedHRPayrollApplicant(t, fx, fx.orgID, minimal.OpeningID, "Grace Njeri", nil, nil, "applied", time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC))
	hrOpeningsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCloseOpeningOutput, error) {
		return hrCloseOpening(fx.ctx, tx, fx.orgID, HRCloseOpeningInput{OpeningID: minimal.OpeningID})
	})
	hrOpeningsExpectError(t, fx, fx.orgID, "opening is closed", func(tx pgx.Tx) error {
		_, err := hrAddApplicant(fx.ctx, tx, fx.orgID, HRAddApplicantInput{OpeningID: minimal.OpeningID, Name: "Late Applicant"})
		return err
	})
	var stage string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage FROM job_applicants WHERE id = $1::uuid`, applicantID).Scan(&stage); err != nil {
		t.Fatal(err)
	}
	if stage != "applied" {
		t.Fatalf("applicant stage after close = %s, want existing applicants untouched", stage)
	}
	if got := fx.count(`SELECT count(*) FROM job_applicants WHERE opening_id = $1::uuid`, minimal.OpeningID); got != 1 {
		t.Fatalf("applicants after close = %d, want the existing applicant kept", got)
	}
}
