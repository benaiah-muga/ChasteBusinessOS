package signals

import (
	"math/rand"
	"reflect"
	"testing"
	"time"
)

func TestFormatScaledMatchesJSToFixed(t *testing.T) {
	cases := []struct {
		value  int64
		scale  int
		expect string
	}{
		{12345, 3, "12.345"},
		{12345, 2, "123.45"},
		{0, 2, "0.00"},
		{0, 3, "0.000"},
		{999, 3, "0.999"},
		{1000, 3, "1.000"},
		{-5, 2, "-0.05"},
		{-600, 3, "-0.600"},
		{5000, 3, "5.000"},
	}
	for _, tc := range cases {
		if got := formatScaled(tc.value, tc.scale); got != tc.expect {
			t.Errorf("formatScaled(%d, %d) = %q, want %q", tc.value, tc.scale, got, tc.expect)
		}
	}
}

func TestAgeDaysFloorsLikeJS(t *testing.T) {
	day := 24 * time.Hour
	cases := []struct {
		elapsed time.Duration
		expect  int64
	}{
		{0, 0},
		{day - time.Millisecond, 0},
		{day, 1},
		{90*day + 23*time.Hour, 90},
		{-time.Millisecond, -1},
		{-day, -1},
		{-day - time.Millisecond, -2},
	}
	for _, tc := range cases {
		if got := ageDays(tc.elapsed); got != tc.expect {
			t.Errorf("ageDays(%v) = %d, want %d", tc.elapsed, got, tc.expect)
		}
	}
}

func TestDayWordPluralizesOnlyOne(t *testing.T) {
	if got := dayWord(1); got != "day" {
		t.Errorf("dayWord(1) = %q, want %q", got, "day")
	}
	for _, days := range []int64{0, 2, 7} {
		if got := dayWord(days); got != "days" {
			t.Errorf("dayWord(%d) = %q, want %q", days, got, "days")
		}
	}
}

var paymentBase = time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

func pay(id, invoiceID string, amountMinor int64, days int) paymentRecord {
	return paymentRecord{id: id, invoiceID: invoiceID, amountMinor: amountMinor, receivedAt: paymentBase.Add(time.Duration(days) * 24 * time.Hour)}
}

func TestFindDuplicatePaymentsFlagRulesAndWindow(t *testing.T) {
	payments := []paymentRecord{
		pay("a", "inv-1", 5_000, 0),
		pay("b", "inv-1", 5_000, 2),
		pay("c", "inv-2", 5_000, 3),
		pay("d", "inv-1", 6_000, 1),
		pay("e", "inv-1", 5_000, 30),
	}
	duplicates := findDuplicatePayments(payments)
	if len(duplicates) != 1 {
		t.Fatalf("expected 1 duplicate, got %d: %+v", len(duplicates), duplicates)
	}
	want := duplicatePaymentPair{paymentIDA: "a", paymentIDB: "b", invoiceID: "inv-1", amountMinor: 5_000, daysApart: 2}
	if duplicates[0] != want {
		t.Errorf("duplicate = %+v, want %+v", duplicates[0], want)
	}
}

func TestFindDuplicatePaymentsWindowIsHonestAtSevenDays(t *testing.T) {
	edge := []paymentRecord{pay("a", "i", 100, 0), pay("b", "i", 100, 7)}
	if got := findDuplicatePayments(edge); len(got) != 1 {
		t.Fatalf("day 7 should flag, got %+v", got)
	}
	outside := []paymentRecord{pay("a", "i", 100, 0), pay("b", "i", 100, 8)}
	if got := findDuplicatePayments(outside); len(got) != 0 {
		t.Fatalf("day 8 should not flag, got %+v", got)
	}
}

func TestFindDuplicatePaymentsOrderIndependentAndSymmetric(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	amounts := []int64{1_000, 2_000, 3_000}
	invoices := []string{"i1", "i2", "i3"}
	var payments []paymentRecord
	for i := 0; i < 12; i++ {
		payments = append(payments, pay(
			string(rune('a'+i)),
			invoices[rng.Intn(len(invoices))],
			amounts[rng.Intn(len(amounts))],
			rng.Intn(11),
		))
	}
	first := findDuplicatePayments(payments)
	shuffled := append([]paymentRecord(nil), payments...)
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	second := findDuplicatePayments(shuffled)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("order-dependent output:\n%+v\nvs\n%+v", first, second)
	}
	reversed := append([]paymentRecord(nil), payments...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	if !reflect.DeepEqual(first, findDuplicatePayments(reversed)) {
		t.Fatal("reversed input changed output")
	}
	for _, duplicate := range first {
		if !(duplicate.paymentIDA < duplicate.paymentIDB) {
			t.Fatalf("pair ids not ordered: %+v", duplicate)
		}
	}
}

var claimBase = time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

func claim(id, claimant string, amountMinor int64, days int) expenseClaimRecord {
	return expenseClaimRecord{id: id, claimantUserID: claimant, amountMinor: amountMinor, submittedAt: claimBase.Add(time.Duration(days) * 24 * time.Hour)}
}

func TestFindDuplicateExpenseClaimsFlagRulesAndWindow(t *testing.T) {
	claims := []expenseClaimRecord{
		claim("a", "u1", 5_000, 0),
		claim("b", "u1", 5_000, 2),
		claim("c", "u2", 5_000, 1),
		claim("d", "u1", 7_000, 1),
		claim("e", "u1", 5_000, 9),
	}
	duplicates := findDuplicateExpenseClaims(claims)
	if len(duplicates) != 1 {
		t.Fatalf("expected 1 duplicate, got %d: %+v", len(duplicates), duplicates)
	}
	want := duplicateClaimPair{claimIDA: "a", claimIDB: "b", claimantUserID: "u1", amountMinor: 5_000, daysApart: 2}
	if duplicates[0] != want {
		t.Errorf("duplicate = %+v, want %+v", duplicates[0], want)
	}
}

func TestFindDuplicateExpenseClaimsWindowIsHonestAtThreeDays(t *testing.T) {
	edge := []expenseClaimRecord{claim("a", "u", 100, 0), claim("b", "u", 100, 3)}
	if got := findDuplicateExpenseClaims(edge); len(got) != 1 {
		t.Fatalf("day 3 should flag, got %+v", got)
	}
	outside := []expenseClaimRecord{claim("a", "u", 100, 0), claim("b", "u", 100, 4)}
	if got := findDuplicateExpenseClaims(outside); len(got) != 0 {
		t.Fatalf("day 4 should not flag, got %+v", got)
	}
}

func TestFindDuplicateExpenseClaimsOrderIndependentAndSymmetric(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	claimants := []string{"u1", "u2", "u3"}
	amounts := []int64{1_000, 2_000}
	var claims []expenseClaimRecord
	for i := 0; i < 12; i++ {
		claims = append(claims, claim(
			string(rune('a'+i)),
			claimants[rng.Intn(len(claimants))],
			amounts[rng.Intn(len(amounts))],
			rng.Intn(9),
		))
	}
	first := findDuplicateExpenseClaims(claims)
	reversed := append([]expenseClaimRecord(nil), claims...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	if !reflect.DeepEqual(first, findDuplicateExpenseClaims(reversed)) {
		t.Fatal("reversed input changed output")
	}
	for _, duplicate := range first {
		if !(duplicate.claimIDA < duplicate.claimIDB) {
			t.Fatalf("pair ids not ordered: %+v", duplicate)
		}
	}
}

func TestNeedsReorderRequiresPositiveReorderPoint(t *testing.T) {
	if !needsReorder(5_000, 5_000) {
		t.Error("on hand equal to reorder point should alert")
	}
	if !needsReorder(4_999, 5_000) {
		t.Error("on hand below reorder point should alert")
	}
	if needsReorder(5_001, 5_000) {
		t.Error("on hand above reorder point should not alert")
	}
	if needsReorder(0, 0) {
		t.Error("zero reorder point disables reorder alerts")
	}
}

func TestDocumentOutstandingFloorsAtZero(t *testing.T) {
	if got := documentOutstandingMinor(10_000, 2_000, 1_000); got != 7_000 {
		t.Errorf("outstanding = %d, want 7000", got)
	}
	if got := documentOutstandingMinor(10_000, 10_000, 0); got != 0 {
		t.Errorf("settled outstanding = %d, want 0", got)
	}
	if got := documentOutstandingMinor(10_000, 12_000, 0); got != 0 {
		t.Errorf("overpaid outstanding = %d, want 0", got)
	}
}

func TestEvaluateExpensePolicyIsExactAndMissingSafe(t *testing.T) {
	policies := []expensePolicy{{category: "meals", limitMinor: 5_000}, {category: "travel", limitMinor: 100_000}}
	if over, limit, found := evaluateExpensePolicy("meals", 5_000, policies); !found || over || limit != 5_000 {
		t.Errorf("at limit: over=%v limit=%d found=%v", over, limit, found)
	}
	if over, limit, found := evaluateExpensePolicy("meals", 5_001, policies); !found || !over || limit != 5_000 {
		t.Errorf("over limit: over=%v limit=%d found=%v", over, limit, found)
	}
	if over, limit, found := evaluateExpensePolicy("other", 999_999, policies); found || over || limit != 0 {
		t.Errorf("no policy: over=%v limit=%d found=%v", over, limit, found)
	}
}

func claimInCategory(id, category string, amountMinor int64) expenseClaimRecord {
	return expenseClaimRecord{id: id, claimantUserID: "u", category: category, amountMinor: amountMinor, submittedAt: claimBase}
}

func TestFindUnusualExpenseClaimsRequiresHistoryAndCategoryMatch(t *testing.T) {
	history := []expenseClaimRecord{
		claimInCategory("h1", "travel", 10_000),
		claimInCategory("h2", "travel", 20_000),
		claimInCategory("h3", "travel", 30_000),
		claimInCategory("h4", "office", 100_000),
		claimInCategory("h5", "office", 100_000),
		claimInCategory("h6", "office", 100_000),
	}
	pending := []expenseClaimRecord{
		claimInCategory("p1", "travel", 60_000),
		claimInCategory("p2", "office", 350_000),
		claimInCategory("p3", "travel", 59_999),
		claimInCategory("p4", "new", 999_999),
	}
	got := findUnusualExpenseClaims(pending, history, 3, 3)
	if len(got) != 2 {
		t.Fatalf("anomalies = %+v, want two flagged claims", got)
	}
	if got[0].claimID != "p2" || got[0].medianMinor != 100_000 || got[0].sampleSize != 3 {
		t.Errorf("first anomaly = %+v, want the office claim p2 at 3.5x a 100000 median", got[0])
	}
	if got[1].claimID != "p1" || got[1].medianMinor != 20_000 || got[1].sampleSize != 3 {
		t.Errorf("second anomaly = %+v, want travel claim p1 at 3x a 20000 median", got[1])
	}
}

func TestFindUnusualExpenseClaimsIgnoresThinHistoryAndLowMultiple(t *testing.T) {
	thin := []expenseClaimRecord{claimInCategory("h1", "travel", 10_000), claimInCategory("h2", "travel", 20_000)}
	pending := []expenseClaimRecord{claimInCategory("p1", "travel", 1_000_000)}
	if got := findUnusualExpenseClaims(pending, thin, 3, 3); len(got) != 0 {
		t.Fatalf("thin history flagged: %+v", got)
	}
	history := []expenseClaimRecord{
		claimInCategory("h1", "travel", 10_000),
		claimInCategory("h2", "travel", 20_000),
		claimInCategory("h3", "travel", 30_000),
	}
	if got := findUnusualExpenseClaims(pending, history, 3, 100); len(got) != 0 {
		t.Fatalf("a high multiple threshold flagged a claim below it: %+v", got)
	}
}
