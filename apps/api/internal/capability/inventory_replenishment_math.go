package capability

import "math"

func replenishmentServiceZ(level string) (float64, bool) {
	switch level {
	case "90":
		return 1.2816, true
	case "95":
		return 1.6449, true
	case "98":
		return 2.0537, true
	case "99":
		return 2.3263, true
	default:
		return 0, false
	}
}

func replenishmentAverageDaily(totalThousandths int64, days int) int64 {
	if days <= 0 || totalThousandths < 0 {
		return 0
	}
	divisor := int64(days)
	quotient := totalThousandths / divisor
	remainder := totalThousandths % divisor
	if remainder >= divisor-remainder {
		quotient++
	}
	return quotient
}

func replenishmentStdDev(daily []int64) float64 {
	if len(daily) == 0 {
		return 0
	}
	var sum float64
	for _, value := range daily {
		if value > 0 {
			sum += float64(value)
		}
	}
	count := float64(len(daily))
	mean := sum / count
	var squaredDeviations float64
	for _, value := range daily {
		if value < 0 {
			value = 0
		}
		deviation := float64(value) - mean
		squaredDeviations += deviation * deviation
	}
	return math.Sqrt(squaredDeviations / count)
}

func replenishmentSafetyStock(stdDev float64, leadDays int, z float64) int64 {
	if stdDev <= 0 || leadDays <= 0 || z <= 0 {
		return 0
	}
	return int64(math.Round(z * stdDev * math.Sqrt(float64(leadDays))))
}

func replenishmentTargetStock(reorderPoint, avgDaily int64, reviewDays int) int64 {
	if reorderPoint < 0 || avgDaily < 0 || reviewDays < 0 {
		return 0
	}
	return reorderPoint + avgDaily*int64(reviewDays)
}

func replenishmentSuggestedQty(available, incoming, target int64) int64 {
	if incoming < 0 {
		if incoming == math.MinInt64 {
			return math.MaxInt64
		}
		extra := uint64(-incoming)
		if available >= target {
			deficit := uint64(available) - uint64(target)
			if extra <= deficit {
				return 0
			}
			return int64(extra - deficit)
		}
		gap := uint64(target) - uint64(available)
		if gap > math.MaxInt64 || extra > math.MaxInt64-gap {
			return math.MaxInt64
		}
		return int64(gap + extra)
	}
	if available >= target {
		return 0
	}
	// Unsigned arithmetic keeps the full target-available gap representable
	// even when the two operands sit at opposite ends of int64.
	gap := uint64(target) - uint64(available)
	if uint64(incoming) >= gap {
		return 0
	}
	qty := gap - uint64(incoming)
	if qty > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(qty)
}

func replenishmentDaysOfCover(available, avgDaily int64) (float64, bool) {
	if avgDaily <= 0 || available < 0 {
		return 0, false
	}
	return float64(available) / float64(avgDaily), true
}
