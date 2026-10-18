// Package signals ports the retiring TypeScript module signal producers into
// the Go runtime. Producers are pure per-org collection for one instant: they
// read through the runtime pool under dbx.WithOrgTx so PostgreSQL RLS applies
// and return either a real collection or an error. The capability aggregator
// owns sorting, deduplication, and severity or module filters, and absorbs a
// failing producer as missing signals so the feed still renders.
package signals

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/jackc/pgx/v5/pgxpool"
)

const millisPerDay = int64(24 * time.Hour / time.Millisecond)

// Register wires every module producer into the capability aggregator. Call it
// once from the app layer after the executor exists and before serving.
func Register(pool *pgxpool.Pool) {
	capability.RegisterSignalsProducer(NewInventoryProducer(pool))
	capability.RegisterSignalsProducer(NewAccountingProducer(pool))
	capability.RegisterSignalsProducer(NewCRMProducer(pool))
	capability.RegisterSignalsProducer(NewHRProducer(pool))
	capability.RegisterSignalsProducer(NewSupportProducer(pool))
	capability.RegisterSignalsProducer(NewDocumentsProducer(pool))
}

// formatScaled renders an integer scaled value with an exact number of decimal
// places. It matches JavaScript (value / scale).toFixed(digits) for integer
// input without the binary floating point rounding hazards.
func formatScaled(value int64, scale int) string {
	negative := value < 0
	if negative {
		value = -value
	}
	divisor := int64(1)
	for i := 0; i < scale; i++ {
		divisor *= 10
	}
	whole := strconv.FormatInt(value/divisor, 10)
	fraction := strconv.FormatInt(value%divisor, 10)
	if padding := scale - len(fraction); padding > 0 {
		fraction = strings.Repeat("0", padding) + fraction
	}
	if negative {
		return "-" + whole + "." + fraction
	}
	return whole + "." + fraction
}

func formatThousandths(value int64) string {
	return formatScaled(value, 3)
}

func formatMinor(value int64) string {
	return formatScaled(value, 2)
}

// ageDays floors an elapsed duration to whole days, matching
// Math.floor((now - ref) / 86_400_000) including negative elapsed times.
func ageDays(elapsed time.Duration) int64 {
	millis := elapsed.Milliseconds()
	if millis >= 0 {
		return millis / millisPerDay
	}
	return -((-millis + millisPerDay - 1) / millisPerDay)
}

func dayWord(days int64) string {
	if days == 1 {
		return "day"
	}
	return "days"
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// quoteTitle mirrors the TypeScript producer templates, which wrap a title in
// plain quotes; Go's %q would escape inner quotes and backslashes instead.
func quoteTitle(value string) string {
	return "\"" + value + "\""
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func evidence(refType, refID string) *capability.BusinessSignalEvidence {
	return &capability.BusinessSignalEvidence{RefType: refType, RefID: &refID}
}

// suggestedAction encodes the draft here so producers keep returning plain
// signals and the capability id still ships if a draft (which is always a
// small JSON object) cannot marshal.
func suggestedAction(capabilityID string, draft any) *capability.BusinessSignalSuggestedAction {
	encoded, err := json.Marshal(draft)
	if err != nil {
		return &capability.BusinessSignalSuggestedAction{CapabilityID: capabilityID}
	}
	return &capability.BusinessSignalSuggestedAction{CapabilityID: capabilityID, InputDraft: encoded}
}
