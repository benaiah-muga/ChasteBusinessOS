package capability

import (
	"math"
	"testing"
)

func TestReplenishmentMathServiceZ(t *testing.T) {
	tests := []struct {
		name  string
		level string
		want  float64
		ok    bool
	}{
		{name: "90", level: "90", want: 1.2816, ok: true},
		{name: "95", level: "95", want: 1.6449, ok: true},
		{name: "98", level: "98", want: 2.0537, ok: true},
		{name: "99", level: "99", want: 2.3263, ok: true},
		{name: "unknown", level: "97", want: 0, ok: false},
		{name: "empty", level: "", want: 0, ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := replenishmentServiceZ(tt.level)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("replenishmentServiceZ(%q) = (%v, %v), want (%v, %v)", tt.level, got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestReplenishmentMathAverageDaily(t *testing.T) {
	tests := []struct {
		name  string
		total int64
		days  int
		want  int64
	}{
		{name: "1000 over 30 days", total: 1000, days: 30, want: 33},
		{name: "1500 over 30 days", total: 1500, days: 30, want: 50},
		{name: "half rounds up", total: 5, days: 2, want: 3},
		{name: "just below half rounds down", total: 4, days: 3, want: 1},
		{name: "fraction rounds up", total: 29, days: 30, want: 1},
		{name: "tiny fraction rounds down", total: 1, days: 30, want: 0},
		{name: "zero total", total: 0, days: 30, want: 0},
		{name: "zero days", total: 1000, days: 0, want: 0},
		{name: "negative days", total: 1000, days: -1, want: 0},
		{name: "negative total", total: -1, days: 30, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := replenishmentAverageDaily(tt.total, tt.days); got != tt.want {
				t.Fatalf("replenishmentAverageDaily(%d, %d) = %d, want %d", tt.total, tt.days, got, tt.want)
			}
		})
	}
}

func TestReplenishmentMathStdDev(t *testing.T) {
	tests := []struct {
		name  string
		daily []int64
		want  float64
	}{
		{name: "empty", daily: nil, want: 0},
		{name: "zero inclusive buckets", daily: []int64{0, 2, 4}, want: 1.632993161855452},
		{name: "negative buckets treated as zero", daily: []int64{-3, 0, 3}, want: math.Sqrt(2)},
		{name: "constant buckets", daily: []int64{7, 7, 7}, want: 0},
		{name: "single zero bucket", daily: []int64{0}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := replenishmentStdDev(tt.daily)
			if diff := math.Abs(got - tt.want); diff > 1e-9 {
				t.Fatalf("replenishmentStdDev(%v) = %v, want %v (diff %v)", tt.daily, got, tt.want, diff)
			}
		})
	}
}

func TestReplenishmentMathSafetyStock(t *testing.T) {
	tests := []struct {
		name     string
		stdDev   float64
		leadDays int
		z        float64
		want     int64
	}{
		{name: "rounded", stdDev: 10, leadDays: 4, z: 1.6449, want: 33},
		{name: "zero stddev", stdDev: 0, leadDays: 4, z: 1.6449, want: 0},
		{name: "negative stddev", stdDev: -1, leadDays: 4, z: 1.6449, want: 0},
		{name: "zero lead days", stdDev: 10, leadDays: 0, z: 1.6449, want: 0},
		{name: "negative lead days", stdDev: 10, leadDays: -1, z: 1.6449, want: 0},
		{name: "zero z", stdDev: 10, leadDays: 4, z: 0, want: 0},
		{name: "negative z", stdDev: 10, leadDays: 4, z: -1.6449, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := replenishmentSafetyStock(tt.stdDev, tt.leadDays, tt.z); got != tt.want {
				t.Fatalf("replenishmentSafetyStock(%v, %d, %v) = %d, want %d", tt.stdDev, tt.leadDays, tt.z, got, tt.want)
			}
		})
	}
}

func TestReplenishmentMathTargetStock(t *testing.T) {
	tests := []struct {
		name         string
		reorderPoint int64
		avgDaily     int64
		reviewDays   int
		want         int64
	}{
		{name: "reorder point plus review demand", reorderPoint: 100, avgDaily: 10, reviewDays: 7, want: 170},
		{name: "zero review days", reorderPoint: 100, avgDaily: 10, reviewDays: 0, want: 100},
		{name: "negative reorder point", reorderPoint: -1, avgDaily: 10, reviewDays: 7, want: 0},
		{name: "negative average", reorderPoint: 100, avgDaily: -1, reviewDays: 7, want: 0},
		{name: "negative review days", reorderPoint: 100, avgDaily: 10, reviewDays: -1, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := replenishmentTargetStock(tt.reorderPoint, tt.avgDaily, tt.reviewDays); got != tt.want {
				t.Fatalf("replenishmentTargetStock(%d, %d, %d) = %d, want %d", tt.reorderPoint, tt.avgDaily, tt.reviewDays, got, tt.want)
			}
		})
	}
}

func TestReplenishmentMathSuggestedQty(t *testing.T) {
	tests := []struct {
		name      string
		available int64
		incoming  int64
		target    int64
		want      int64
	}{
		{name: "reduced by incoming", available: 40, incoming: 20, target: 100, want: 40},
		{name: "incoming exactly covers gap", available: 40, incoming: 60, target: 100, want: 0},
		{name: "incoming exceeds gap", available: 40, incoming: 80, target: 100, want: 0},
		{name: "available meets target", available: 100, incoming: 0, target: 100, want: 0},
		{name: "available above target", available: 120, incoming: 0, target: 100, want: 0},
		{name: "no incoming", available: 40, incoming: 0, target: 100, want: 60},
		{name: "zero target", available: 0, incoming: 0, target: 0, want: 0},
		{name: "saturates at max int64", available: math.MinInt64, incoming: 0, target: math.MaxInt64, want: math.MaxInt64},
		{name: "negative incoming widens gap above target", available: 100, incoming: -50, target: 90, want: 40},
		{name: "negative incoming inside surplus", available: 100, incoming: -10, target: 90, want: 0},
		{name: "negative incoming widens open gap", available: 40, incoming: -20, target: 100, want: 80},
		{name: "negative incoming saturates", available: 0, incoming: math.MinInt64, target: 10, want: math.MaxInt64},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := replenishmentSuggestedQty(tt.available, tt.incoming, tt.target); got != tt.want {
				t.Fatalf("replenishmentSuggestedQty(%d, %d, %d) = %d, want %d", tt.available, tt.incoming, tt.target, got, tt.want)
			}
		})
	}
}

func TestReplenishmentMathDaysOfCover(t *testing.T) {
	tests := []struct {
		name      string
		available int64
		avgDaily  int64
		want      float64
		ok        bool
	}{
		{name: "plain", available: 100, avgDaily: 10, want: 10, ok: true},
		{name: "fractional", available: 5, avgDaily: 2, want: 2.5, ok: true},
		{name: "zero available", available: 0, avgDaily: 10, want: 0, ok: true},
		{name: "no demand", available: 100, avgDaily: 0, want: 0, ok: false},
		{name: "negative demand", available: 100, avgDaily: -1, want: 0, ok: false},
		{name: "negative available", available: -1, avgDaily: 10, want: 0, ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := replenishmentDaysOfCover(tt.available, tt.avgDaily)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("replenishmentDaysOfCover(%d, %d) = (%v, %v), want (%v, %v)", tt.available, tt.avgDaily, got, ok, tt.want, tt.ok)
			}
		})
	}
}
