package dashboard

import "testing"

func TestFormatWorkThousandths(t *testing.T) {
	for _, test := range []struct {
		value int64
		want  string
	}{
		{value: 0, want: "0 units"},
		{value: 1000, want: "1 units"},
		{value: 1250, want: "1.25 units"},
		{value: 1234, want: "1.234 units"},
	} {
		if got := FormatWorkThousandths(test.value); got != test.want {
			t.Errorf("FormatWorkThousandths(%d) = %q, want %q", test.value, got, test.want)
		}
	}
}

func TestRemainingReceiptQuantityAddsBackReturnsAndSubtractsRejected(t *testing.T) {
	got := remainingReceiptQuantity(10_000, 4_000, 500, 1_000)
	if got != 6_500 {
		t.Fatalf("remaining receipt quantity = %d, want 6500", got)
	}
}
