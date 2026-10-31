package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoARAgingExecutorPreservesBucketsScopePermissionAndAudit(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")

	customerID := seedReportsCustomer(t, fx, fx.orgID, "AR aging executor customer")
	foreignCustomerID := seedReportsCustomer(t, fx, fx.otherOrgID, "Foreign AR aging customer")
	now := time.Now().UTC().Truncate(time.Millisecond)
	const day = 24 * time.Hour
	for _, seed := range []struct {
		number                int64
		ageDays               int
		total, paid, credited int64
	}{
		{number: 101, ageDays: 10, total: 1_000, paid: 100, credited: 50},
		{number: 102, ageDays: 31, total: 2_000, paid: 300, credited: 200},
		{number: 103, ageDays: 61, total: 3_000, paid: 500, credited: 500},
		{number: 104, ageDays: 91, total: 4_000, paid: 600, credited: 400},
	} {
		issuedAt := now.Add(-time.Duration(seed.ageDays) * day)
		seedReportsInvoice(t, fx, fx.orgID, customerID, seed.number, "sent", "USD", seed.total, 0, seed.total, seed.paid, seed.credited, &issuedAt, &issuedAt, nil)
	}

	foreignIssuedAt := now.Add(-100 * day)
	seedReportsInvoice(t, fx, fx.otherOrgID, foreignCustomerID, 105, "sent", "USD", 99_000, 0, 99_000, 0, 0, &foreignIssuedAt, &foreignIssuedAt, nil)
	closedIssuedAt := now.Add(-10 * day)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 106, "paid", "USD", 700, 0, 700, 700, 0, &closedIssuedAt, &closedIssuedAt, nil)
	partialPaidIssuedAt := now.Add(-40 * day)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 109, "paid", "USD", 2_000, 0, 2_000, 1_000, 0, &partialPaidIssuedAt, &partialPaidIssuedAt, nil)
	voidedAt := now
	seedReportsInvoice(t, fx, fx.orgID, customerID, 107, "sent", "USD", 800, 0, 800, 0, 0, &closedIssuedAt, &closedIssuedAt, &voidedAt)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 108, "draft", "USD", 900, 0, 900, 0, 0, &closedIssuedAt, &closedIssuedAt, nil)

	input := json.RawMessage(`{}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, arAgingCapabilityID, "crm.read", input, "human", "", "ar-aging-wrong-permission"),
		arAgingCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("arAging wrong-permission result=%+v err=%v, want accounting.read denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, arAgingCapabilityID); got != 0 {
		t.Fatalf("denied arAging audit events=%d, want none", got)
	}

	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, arAgingCapabilityID, "accounting.read", input, "human", "", "ar-aging-bucket-scope-audit"),
		arAgingCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("arAging result=%+v err=%v", result, err)
	}
	var output ArAgingOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode arAging output %s: %v", result.Data, err)
	}
	wantBuckets := ArAgingBucketTotals{Current: 850, D30: 2_500, D60: 2_000, D90Plus: 3_000, TotalOutstanding: 8_350}
	if output.Buckets != wantBuckets {
		t.Fatalf("arAging buckets=%+v, want %+v", output.Buckets, wantBuckets)
	}
	wantInvoices := []ArAgingInvoice{
		{Number: 101, OutstandingMinor: 850, AgeDays: 10},
		{Number: 102, OutstandingMinor: 1_500, AgeDays: 31},
		{Number: 103, OutstandingMinor: 2_000, AgeDays: 61},
		{Number: 104, OutstandingMinor: 3_000, AgeDays: 91},
		{Number: 109, OutstandingMinor: 1_000, AgeDays: 40},
	}
	if len(output.Invoices) != len(wantInvoices) {
		t.Fatalf("arAging invoices=%+v, want exactly %+v", output.Invoices, wantInvoices)
	}
	for i, want := range wantInvoices {
		if output.Invoices[i] != want {
			t.Fatalf("arAging invoice[%d]=%+v, want %+v", i, output.Invoices[i], want)
		}
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, arAgingCapabilityID); got != 1 {
		t.Fatalf("arAging audit events=%d, want one governed human execution", got)
	}
}
