package capability

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestParseAPAgingInputRequiresAnObject(t *testing.T) {
	for _, raw := range []string{`{}`, `{"ignored":true}`} {
		if _, err := parseAPAgingInput(json.RawMessage(raw)); err != nil {
			t.Errorf("parseAPAgingInput(%s) error = %v", raw, err)
		}
	}
	for _, raw := range []string{`[]`, `null`, `"value"`, `{`} {
		if _, err := parseAPAgingInput(json.RawMessage(raw)); err == nil {
			t.Errorf("parseAPAgingInput(%s) accepted invalid input", raw)
		}
	}
}

func TestPurchasingAPAgingBoundariesAndOrgScope(t *testing.T) {
	fx := newExecutorFixture(t)
	const billOutstanding int64 = 100
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	orgVendor := insertAPAgingVendor(t, fx, fx.orgID)
	foreignVendor := insertAPAgingVendor(t, fx, fx.otherOrgID)
	t.Cleanup(func() {
		for _, orgID := range []string{fx.orgID, fx.otherOrgID} {
			if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM vendor_bills WHERE org_id = $1::uuid`, orgID); err != nil {
				t.Errorf("delete AP aging fixture bills: %v", err)
			}
			if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM vendors WHERE org_id = $1::uuid`, orgID); err != nil {
				t.Errorf("delete AP aging fixture vendors: %v", err)
			}
		}
	})

	for index, ageDays := range []int{30, 31, 60, 61, 90, 91} {
		insertAPAgingBill(t, fx, fx.orgID, orgVendor, int64(index+1), now.AddDate(0, 0, -ageDays), 200, 100, 0)
	}
	// The legacy capability ignores credits and bill status, skips missing bill dates,
	// and includes future dated open bills in the current bucket.
	insertAPAgingBill(t, fx, fx.orgID, orgVendor, 7, now.Add(24*time.Hour), 200, 100, 100)
	insertAPAgingBill(t, fx, fx.orgID, orgVendor, 8, time.Time{}, 200, 100, 0)
	insertAPAgingBill(t, fx, fx.orgID, orgVendor, 9, now, 100, 100, 0)
	insertAPAgingBill(t, fx, fx.otherOrgID, foreignVendor, 1, now.AddDate(0, 0, -91), 500, 0, 0)

	current := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (APAgingOutput, error) {
		return purchasingAPAging(fx.ctx, tx, fx.orgID, APAgingInput{}, now)
	})
	want := APAgingBuckets{Current: 2 * billOutstanding, D30: 2 * billOutstanding, D60: 2 * billOutstanding, D90Plus: billOutstanding, TotalOutstanding: 7 * billOutstanding}
	if current.Buckets != want {
		t.Fatalf("purchasing AP aging buckets = %+v, want %+v", current.Buckets, want)
	}

	foreign := paymentRunsInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (APAgingOutput, error) {
		return purchasingAPAging(fx.ctx, tx, fx.otherOrgID, APAgingInput{}, now)
	})
	if foreign.Buckets != (APAgingBuckets{D90Plus: 500, TotalOutstanding: 500}) {
		t.Fatalf("foreign organization AP aging = %+v, want only its own bill", foreign.Buckets)
	}

	encoded, err := marshalJS(current)
	if err != nil {
		t.Fatal(err)
	}
	const wantJSON = `{"buckets":{"current":200,"d30":200,"d60":200,"d90plus":100,"totalOutstanding":700}}`
	if string(encoded) != wantJSON {
		t.Fatalf("AP aging JSON = %s, want %s", encoded, wantJSON)
	}
}

func insertAPAgingVendor(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, $2) RETURNING id::text`, orgID, "AP aging "+orgID[:8]).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	return vendorID
}

func insertAPAgingBill(t *testing.T, fx *executorFixture, orgID, vendorID string, number int64, billDate time.Time, totalMinor, paidMinor, creditedMinor int64) {
	t.Helper()
	var date any
	if !billDate.IsZero() {
		date = billDate
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, paid_minor, credited_minor, bill_date)
		VALUES ($1::uuid, $2::uuid, $3, 'draft', 'USD', $4, $5, $6, $7)`,
		orgID, vendorID, number, totalMinor, paidMinor, creditedMinor, date); err != nil {
		t.Fatalf("insert AP aging fixture bill %d: %v", number, err)
	}
}

func TestPurchasingAPAgingExecutorRequiresReadPermission(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{}`)
	claims := waveModuleClaims(fx, apAgingCapabilityID, "purchasing.read", input, "human", "", "ap-aging-executor")
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'purchasing.read', $2::uuid) ON CONFLICT DO NOTHING`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	result, err := fx.executor.Execute(fx.ctx, claims, apAgingCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("purchasing AP aging result=%+v err=%v", result, err)
	}
	deniedClaims := waveModuleClaims(fx, apAgingCapabilityID, "crm.write", input, "human", "", "ap-aging-denied")
	denied, err := fx.executor.Execute(fx.ctx, deniedClaims, apAgingCapabilityID, input)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: purchasing.read" {
		t.Fatalf("purchasing AP aging denied result=%+v err=%v", denied, err)
	}
}
