package signals

import (
	"math"
	"sort"
	"time"
)

const (
	duplicatePaymentWindowDays = 7
	duplicateClaimWindowDays   = 3
	deadStockDays              = 90
)

type paymentRecord struct {
	id          string
	invoiceID   string
	amountMinor int64
	receivedAt  time.Time
}

type duplicatePaymentPair struct {
	paymentIDA  string
	paymentIDB  string
	invoiceID   string
	amountMinor int64
	daysApart   int64
}

type expenseClaimRecord struct {
	id             string
	claimantUserID string
	amountMinor    int64
	submittedAt    time.Time
}

type duplicateClaimPair struct {
	claimIDA       string
	claimIDB       string
	claimantUserID string
	amountMinor    int64
	daysApart      int64
}

type expensePolicy struct {
	category   string
	limitMinor int64
}

// findDuplicatePayments mirrors the legacy detector: same invoice, same amount,
// inside the window, with stable id ordering so output never depends on input
// order.
func findDuplicatePayments(payments []paymentRecord) []duplicatePaymentPair {
	sorted := append([]paymentRecord(nil), payments...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].invoiceID != sorted[j].invoiceID {
			return sorted[i].invoiceID < sorted[j].invoiceID
		}
		return sorted[i].id < sorted[j].id
	})
	var out []duplicatePaymentPair
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			left, right := sorted[i], sorted[j]
			if left.invoiceID != right.invoiceID {
				break
			}
			if left.amountMinor != right.amountMinor {
				continue
			}
			daysApart := float64(absInt64(left.receivedAt.UnixMilli()-right.receivedAt.UnixMilli())) / float64(millisPerDay)
			if daysApart > duplicatePaymentWindowDays {
				continue
			}
			paymentIDA, paymentIDB := left.id, right.id
			if paymentIDB < paymentIDA {
				paymentIDA, paymentIDB = paymentIDB, paymentIDA
			}
			out = append(out, duplicatePaymentPair{
				paymentIDA: paymentIDA, paymentIDB: paymentIDB, invoiceID: left.invoiceID,
				amountMinor: left.amountMinor, daysApart: int64(math.Round(daysApart)),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].invoiceID != out[j].invoiceID {
			return out[i].invoiceID < out[j].invoiceID
		}
		if out[i].paymentIDA != out[j].paymentIDA {
			return out[i].paymentIDA < out[j].paymentIDA
		}
		return out[i].paymentIDB < out[j].paymentIDB
	})
	return out
}

// findDuplicateExpenseClaims mirrors the legacy detector: same claimant, same
// amount, inside the window, with stable id ordering.
func findDuplicateExpenseClaims(claims []expenseClaimRecord) []duplicateClaimPair {
	sorted := append([]expenseClaimRecord(nil), claims...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].claimantUserID != sorted[j].claimantUserID {
			return sorted[i].claimantUserID < sorted[j].claimantUserID
		}
		return sorted[i].id < sorted[j].id
	})
	var out []duplicateClaimPair
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			left, right := sorted[i], sorted[j]
			if left.claimantUserID != right.claimantUserID {
				break
			}
			if left.amountMinor != right.amountMinor {
				continue
			}
			daysApart := float64(absInt64(left.submittedAt.UnixMilli()-right.submittedAt.UnixMilli())) / float64(millisPerDay)
			if daysApart > duplicateClaimWindowDays {
				continue
			}
			claimIDA, claimIDB := left.id, right.id
			if claimIDB < claimIDA {
				claimIDA, claimIDB = claimIDB, claimIDA
			}
			out = append(out, duplicateClaimPair{
				claimIDA: claimIDA, claimIDB: claimIDB, claimantUserID: left.claimantUserID,
				amountMinor: left.amountMinor, daysApart: int64(math.Round(daysApart)),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].claimantUserID != out[j].claimantUserID {
			return out[i].claimantUserID < out[j].claimantUserID
		}
		if out[i].claimIDA != out[j].claimIDA {
			return out[i].claimIDA < out[j].claimIDA
		}
		return out[i].claimIDB < out[j].claimIDB
	})
	return out
}

func needsReorder(onHand, reorderPoint int64) bool {
	return reorderPoint > 0 && onHand <= reorderPoint
}

func documentOutstandingMinor(totalMinor, paidMinor, creditedMinor int64) int64 {
	outstanding := totalMinor - paidMinor - creditedMinor
	if outstanding < 0 {
		return 0
	}
	return outstanding
}

// evaluateExpensePolicy returns overLimit, the matched ceiling, and whether a
// policy row exists for the category at all.
func evaluateExpensePolicy(category string, amountMinor int64, policies []expensePolicy) (bool, int64, bool) {
	for _, policy := range policies {
		if policy.category == category {
			return amountMinor > policy.limitMinor, policy.limitMinor, true
		}
	}
	return false, 0, false
}
