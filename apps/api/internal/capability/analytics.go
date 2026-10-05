package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	analyticsRenderReportCapabilityID    = "analytics.renderReport"
	analyticsPipelineByStageCapabilityID = "analytics.pipelineByStage"
	analyticsRevenueByMonthCapabilityID  = "analytics.revenueByMonth"
	analyticsInvoiceAgingCapabilityID    = "analytics.invoiceAging"
	analyticsSalesByCustomerCapabilityID = "analytics.salesByCustomer"
	analyticsStockLevelsCapabilityID     = "analytics.stockLevels"
	analyticsExplainChangeCapabilityID   = "analytics.explainChange"
	analyticsAskYourBusinessCapabilityID = "analytics.askYourBusiness"

	analyticsMaxReportSections = 8
)

const AnalyticsRenderReportCapabilityID = analyticsRenderReportCapabilityID

// ── Frame engine: declarative dataframe ops over plain JSON rows ──

type analyticsFrame struct {
	columns []string
	rows    []map[string]any
}

type analyticsFrameOp struct {
	Op      string           `json:"op"`
	Column  *string          `json:"column,omitempty"`
	Matches *string          `json:"matches,omitempty"`
	Value   any              `json:"value,omitempty"`
	By      *string          `json:"by,omitempty"`
	Desc    bool             `json:"desc"`
	N       *int64           `json:"n,omitempty"`
	Columns []string         `json:"columns,omitempty"`
	Keys    []string         `json:"keys,omitempty"`
	Aggs    []analyticsAggOp `json:"aggregations,omitempty"`
	As      *string          `json:"as,omitempty"`
}

type analyticsAggOp struct {
	Column *string `json:"column,omitempty"`
	Fn     string  `json:"fn"`
	As     string  `json:"as"`
}

func analyticsCompare(a, b any) int {
	if a == b {
		return 0
	}
	if a == nil || b == nil {
		if a == nil {
			return -1
		}
		return 1
	}
	aNum, aIsNum := a.(float64)
	bNum, bIsNum := b.(float64)
	if aIsNum && bIsNum {
		if aNum < bNum {
			return -1
		}
		if aNum > bNum {
			return 1
		}
		return 0
	}
	return strings.Compare(toJSONString(a), toJSONString(b))
}

func toJSONString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	encoded, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(encoded)
}

func analyticsCellNumber(v any) (float64, bool) {
	num, ok := v.(float64)
	return num, ok
}

func analyticsParseFrameOps(raw json.RawMessage) ([]analyticsFrameOp, error) {
	var rawOps []json.RawMessage
	if err := json.Unmarshal(raw, &rawOps); err != nil {
		return nil, errors.New("ops must be an array")
	}
	if len(rawOps) > 10 {
		return nil, errors.New("ops must have at most 10 items")
	}
	var ops []analyticsFrameOp
	for _, rawOp := range rawOps {
		var op analyticsFrameOp
		if err := json.Unmarshal(rawOp, &op); err != nil {
			return nil, errors.New("ops must be objects")
		}
		switch op.Op {
		case "filter":
			if op.Column == nil || *op.Column == "" {
				return nil, errors.New("filter needs a column")
			}
			if op.Matches == nil {
				return nil, errors.New("filter needs matches")
			}
			switch *op.Matches {
			case "eq", "ne", "gt", "gte", "lt", "lte", "contains":
			default:
				return nil, errors.New("filter matches must be eq, ne, gt, gte, lt, lte or contains")
			}
		case "sort":
			if op.By == nil || *op.By == "" {
				return nil, errors.New("sort needs by")
			}
		case "top":
			if op.N == nil || *op.N < 1 || *op.N > 500 {
				return nil, errors.New("top n must be between 1 and 500")
			}
		case "pick":
			if len(op.Columns) < 1 {
				return nil, errors.New("pick needs at least one column")
			}
		case "groupBy":
			if len(op.Keys) < 1 {
				return nil, errors.New("groupBy needs at least one key")
			}
			if len(op.Aggs) < 1 {
				return nil, errors.New("groupBy needs at least one aggregation")
			}
			for _, agg := range op.Aggs {
				if agg.As == "" {
					return nil, errors.New("each aggregation needs as")
				}
				switch agg.Fn {
				case "count", "sum", "mean", "min", "max":
				default:
					return nil, errors.New("aggregation fn must be count, sum, mean, min or max")
				}
			}
		case "pctOfTotal":
			if op.Column == nil || *op.Column == "" || op.As == nil || *op.As == "" {
				return nil, errors.New("pctOfTotal needs column and as")
			}
		default:
			return nil, errors.New("op must be filter, sort, top, pick, groupBy or pctOfTotal")
		}
		ops = append(ops, op)
	}
	return ops, nil
}

func opsArray(raw json.RawMessage) []json.RawMessage {
	var ops []json.RawMessage
	_ = json.Unmarshal(raw, &ops)
	return ops
}

func analyticsApplyFrameOps(rowsIn []map[string]any, ops []analyticsFrameOp) analyticsFrame {
	frame := analyticsFrame{rows: rowsIn}
	if len(rowsIn) > 0 {
		seen := map[string]bool{}
		for _, row := range rowsIn {
			for key := range row {
				if !seen[key] {
					seen[key] = true
					frame.columns = append(frame.columns, key)
				}
			}
		}
	}
	for _, op := range ops {
		switch op.Op {
		case "filter":
			var kept []map[string]any
			for _, row := range frame.rows {
				cell := row[*op.Column]
				matches := false
				switch *op.Matches {
				case "eq":
					matches = analyticsCompare(cell, op.Value) == 0 && sameKind(cell, op.Value)
				case "ne":
					matches = !(analyticsCompare(cell, op.Value) == 0 && sameKind(cell, op.Value))
				case "gt":
					matches = analyticsCompare(cell, op.Value) > 0
				case "gte":
					matches = analyticsCompare(cell, op.Value) >= 0
				case "lt":
					matches = analyticsCompare(cell, op.Value) < 0
				case "lte":
					matches = analyticsCompare(cell, op.Value) <= 0
				case "contains":
					matches = strings.Contains(strings.ToLower(toJSONString(cell)), strings.ToLower(toJSONString(op.Value)))
				}
				if matches {
					kept = append(kept, row)
				}
			}
			frame.rows = kept
		case "sort":
			by, descending := *op.By, op.Desc
			sort.SliceStable(frame.rows, func(i, j int) bool {
				cmp := analyticsCompare(frame.rows[i][by], frame.rows[j][by])
				if descending {
					return cmp > 0
				}
				return cmp < 0
			})
		case "top":
			if int(*op.N) < len(frame.rows) {
				frame.rows = frame.rows[:*op.N]
			}
		case "pick":
			frame.columns = append([]string{}, op.Columns...)
			picked := make([]map[string]any, 0, len(frame.rows))
			for _, row := range frame.rows {
				next := map[string]any{}
				for _, column := range op.Columns {
					next[column] = row[column]
				}
				picked = append(picked, next)
			}
			frame.rows = picked
		case "groupBy":
			groups := map[string]map[string]any{}
			var groupOrder []string
			for _, row := range frame.rows {
				keyParts := make([]string, 0, len(op.Keys))
				for _, key := range op.Keys {
					keyParts = append(keyParts, toJSONString(row[key]))
				}
				key := strings.Join(keyParts, "\x00")
				entry, exists := groups[key]
				if !exists {
					entry = map[string]any{}
					for _, k := range op.Keys {
						entry[k] = row[k]
					}
					for _, agg := range op.Aggs {
						if agg.Fn == "count" {
							entry[agg.As] = float64(0)
						} else {
							entry[agg.As] = nil
						}
					}
					groups[key] = entry
					groupOrder = append(groupOrder, key)
				}
				for _, agg := range op.Aggs {
					if agg.Fn == "count" {
						count, _ := entry[agg.As].(float64)
						entry[agg.As] = count + 1
						continue
					}
					if agg.Column == nil {
						continue
					}
					cell, isNumber := analyticsCellNumber(row[*agg.Column])
					if !isNumber {
						continue
					}
					prev := entry[agg.As]
					switch agg.Fn {
					case "sum":
						prevNum, _ := prev.(float64)
						entry[agg.As] = prevNum + cell
					case "mean":
						type meanState struct {
							sum float64
							n   float64
						}
						state := meanState{}
						if prevMap, ok := prev.(map[string]any); ok {
							state.sum, _ = prevMap["sum"].(float64)
							state.n, _ = prevMap["n"].(float64)
						}
						entry[agg.As] = map[string]any{"sum": state.sum + cell, "n": state.n + 1}
					case "min":
						if prev == nil || cell < prev.(float64) {
							entry[agg.As] = cell
						}
					case "max":
						if prev == nil || cell > prev.(float64) {
							entry[agg.As] = cell
						}
					}
				}
			}
			grouped := make([]map[string]any, 0, len(groupOrder))
			for _, key := range groupOrder {
				entry := groups[key]
				for _, agg := range op.Aggs {
					if agg.Fn == "mean" {
						if stateMap, ok := entry[agg.As].(map[string]any); ok {
							sum, _ := stateMap["sum"].(float64)
							n, _ := stateMap["n"].(float64)
							if n == 0 {
								entry[agg.As] = nil
							} else {
								entry[agg.As] = sum / n
							}
						}
					}
				}
				grouped = append(grouped, entry)
			}
			if len(op.Keys) > 0 {
				sort.SliceStable(grouped, func(i, j int) bool {
					return analyticsCompare(grouped[i][op.Keys[0]], grouped[j][op.Keys[0]]) < 0
				})
			}
			frame.rows = grouped
			frame.columns = append([]string{}, op.Keys...)
			for _, agg := range op.Aggs {
				frame.columns = append(frame.columns, agg.As)
			}
		case "pctOfTotal":
			var total float64
			for _, row := range rowsIn {
				if num, ok := analyticsCellNumber(row[*op.Column]); ok {
					total += num
				}
			}
			for _, row := range frame.rows {
				num, _ := analyticsCellNumber(row[*op.Column])
				if total == 0 {
					row[*op.As] = float64(0)
				} else {
					row[*op.As] = num / total
				}
			}
			frame.columns = append(frame.columns, *op.As)
		}
	}
	if frame.rows == nil {
		frame.rows = []map[string]any{}
	}
	return frame
}

func sameKind(a, b any) bool {
	_, aNum := a.(float64)
	_, bNum := b.(float64)
	aStr, aIsStr := a.(string)
	bStr, bIsStr := b.(string)
	_, aBool := a.(bool)
	_, bBool := b.(bool)
	if aNum != bNum {
		return false
	}
	if aIsStr != bIsStr {
		return false
	}
	if aIsStr && aStr != bStr {
		return false
	}
	if aBool != bBool {
		return false
	}
	return true
}

// ── Report rendering ──

type analyticsChartSpec struct {
	Type  string   `json:"type"`
	Title *string  `json:"title,omitempty"`
	X     string   `json:"x"`
	Y     []string `json:"y"`
}

type analyticsReportSectionInput struct {
	Heading string           `json:"heading"`
	Columns []string         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
	Ops     []analyticsFrameOp
	Chart   *analyticsChartSpec `json:"chart,omitempty"`
}

func analyticsHTMLEscape(v any) string {
	out := toJSONString(v)
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return replacer.Replace(out)
}

func analyticsRenderChartSVG(spec analyticsChartSpec, rows []map[string]any) *string {
	if len(rows) == 0 {
		return nil
	}
	width, height := 640, 360
	var body strings.Builder
	categories := make([]string, 0, len(rows))
	for _, row := range rows {
		categories = append(categories, toJSONString(row[spec.X]))
	}
	if spec.Type == "pie" {
		valueCol := spec.Y[0]
		var total float64
		for _, row := range rows {
			num, _ := analyticsCellNumber(row[valueCol])
			if num < 0 {
				num = 0
			}
			total += num
		}
		colors := []string{"#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"}
		angle := 0.0
		cx, cy, radius := float64(width/2), float64(height/2), float64(height)*0.31
		for i, row := range rows {
			num, _ := analyticsCellNumber(row[valueCol])
			if num < 0 {
				num = 0
			}
			share := 0.0
			if total > 0 {
				share = num / total
			}
			next := angle + share*2*3.141592653589793
			x2 := cx + radius*cos(next)
			y2 := cy + radius*sin(next)
			large := 0
			if next-angle > 3.141592653589793 {
				large = 1
			}
			color := colors[i%len(colors)]
			if share >= 0.999999 {
				body.WriteString(fmt.Sprintf(`<circle cx="%g" cy="%g" r="%g" fill="%s"/>`, cx, cy, radius, color))
			} else {
				body.WriteString(fmt.Sprintf(`<path d="M%g %g A%g %g 0 %d 1 %g %g Z" fill="%s"><title>%s</title></path>`, cx, cy, radius, radius, large, x2, y2, color, analyticsHTMLEscape(categories[i])))
			}
			angle = next
		}
	} else {
		left, right, top, bottom := 48.0, float64(width-16), float64(24), float64(height-28)
		if spec.Title != nil {
			top = 40
		}
		if len(spec.Y) > 1 {
			bottom = float64(height - 36)
		}
		plotWidth, plotHeight := right-left, bottom-top
		var maxValue float64
		for _, row := range rows {
			for _, col := range spec.Y {
				num, _ := analyticsCellNumber(row[col])
				if num > maxValue {
					maxValue = num
				}
			}
		}
		if maxValue <= 0 {
			maxValue = 1
		}
		body.WriteString(fmt.Sprintf(`<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#e7e5e4"/>`, left, bottom, right, bottom))
		body.WriteString(fmt.Sprintf(`<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#e7e5e4"/>`, left, bottom, left, top))
		slot := plotWidth
		if len(rows) > 0 {
			slot = plotWidth / float64(len(rows))
		}
		colors := []string{"#4e79a7", "#f28e2b", "#e15759"}
		for seriesIndex, col := range spec.Y {
			color := colors[seriesIndex%len(colors)]
			switch spec.Type {
			case "bar":
				barWidth := slot * 0.6
				for i, row := range rows {
					num, _ := analyticsCellNumber(row[col])
					barHeight := plotHeight * num / maxValue
					x := left + slot*float64(i) + (slot-barWidth)/2
					body.WriteString(fmt.Sprintf(`<rect x="%g" y="%g" width="%g" height="%g" fill="%s"><title>%s</title></rect>`, x, bottom-barHeight, barWidth, barHeight, color, analyticsHTMLEscape(categories[i])))
				}
			case "line", "area":
				var points strings.Builder
				for i, row := range rows {
					num, _ := analyticsCellNumber(row[col])
					x := left + slot*float64(i) + slot/2
					y := bottom - plotHeight*num/maxValue
					points.WriteString(fmt.Sprintf("%g,%g ", x, y))
				}
				if spec.Type == "area" {
					body.WriteString(fmt.Sprintf(`<polygon points="%s%g %g" fill="%s" fill-opacity="0.25"/>`, points.String(), left+plotWidth, bottom, color))
				}
				body.WriteString(fmt.Sprintf(`<polyline points="%s" fill="none" stroke="%s" stroke-width="2"/>`, points.String(), color))
			}
		}
		for i, category := range categories {
			x := left + slot*float64(i) + slot/2
			body.WriteString(fmt.Sprintf(`<text x="%g" y="%g" font-size="10" text-anchor="middle" fill="#78716c">%s</text>`, x, bottom+14, analyticsHTMLEscape(category)))
		}
	}
	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">`, width, height, width, height)
	if spec.Title != nil {
		svg += fmt.Sprintf(`<text x="%d" y="20" font-size="13" text-anchor="middle" fill="#1c1917">%s</text>`, width/2, analyticsHTMLEscape(*spec.Title))
	}
	svg += body.String() + `</svg>`
	return &svg
}

func cos(radians float64) float64 {
	series := 0.0
	term := 1.0
	x := radians
	for n := 1; n <= 12; n++ {
		term *= x * x / float64((2*n-1)*(2*n))
		if n%2 == 1 {
			series -= term
		} else {
			series += term
		}
	}
	return 1 + series
}

func sin(radians float64) float64 {
	series := 0.0
	term := radians
	x := radians
	for n := 1; n <= 12; n++ {
		term *= x * x / float64((2*n)*(2*n+1))
		if n%2 == 1 {
			series -= term
		} else {
			series += term
		}
	}
	return series
}

func analyticsRenderReportHTML(title string, region *string, narrative *string, sections []analyticsReportSection) string {
	var body strings.Builder
	for _, section := range sections {
		var table strings.Builder
		table.WriteString(`<table><thead><tr>`)
		for _, column := range section.Columns {
			table.WriteString(`<th>` + analyticsHTMLEscape(column) + `</th>`)
		}
		table.WriteString(`</tr></thead><tbody>`)
		for _, row := range section.Rows {
			table.WriteString(`<tr>`)
			for _, column := range section.Columns {
				table.WriteString(`<td>` + analyticsHTMLEscape(row[column]) + `</td>`)
			}
			table.WriteString(`</tr>`)
		}
		table.WriteString(`</tbody></table>`)
		chart := ""
		if section.SVG != nil {
			chart = `<div class="chart">` + *section.SVG + `</div>`
		}
		empty := ""
		if len(section.Rows) == 0 {
			empty = `<p class="empty">No data for this selection.</p>`
		}
		body.WriteString(`<section><h2>` + analyticsHTMLEscape(section.Heading) + `</h2>` + chart + empty + table.String() + `</section>`)
	}
	regionLabel := "unspecified"
	if region != nil {
		regionLabel = *region
	}
	narrativeHTML := ""
	if narrative != nil {
		narrativeHTML = `<div class="narrative">` + analyticsHTMLEscape(*narrative) + `</div>`
	}
	stamp := time.Now().UTC().Format("2006-01-02 15:04") + " UTC"
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>` + analyticsHTMLEscape(title) + `</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 40px auto; max-width: 760px; color: #1c1917; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #78716c; font-size: 12px; margin-bottom: 24px; }
  .narrative { background: #fafaf9; border: 1px solid #e7e5e4; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; }
  section { margin-bottom: 32px; page-break-inside: avoid; }
  h2 { font-size: 15px; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e7e5e4; padding: 6px 10px; text-align: left; }
  th { background: #fafaf9; font-weight: 600; }
  td { font-variant-numeric: tabular-nums; }
  .chart svg { max-width: 100%; height: auto; }
  .empty { color: #a8a29e; font-style: italic; }
</style>
</head>
<body>
<h1>` + analyticsHTMLEscape(title) + `</h1>
<p class="meta">Generated by ChasteBusinessOS on ` + stamp + ` · Data region: ` + analyticsHTMLEscape(regionLabel) + `</p>
` + narrativeHTML + `
` + body.String() + `
</body>
</html>`
}

// ── Pure metric-change decomposition (erp-core explainChange) ──

type analyticsMetricRow struct {
	Key        string
	ValueMinor int64
}

type analyticsContribution struct {
	Key          string   `json:"key"`
	PriorMinor   int64    `json:"priorMinor"`
	CurrentMinor int64    `json:"currentMinor"`
	DeltaMinor   int64    `json:"deltaMinor"`
	ShareOfDelta *float64 `json:"shareOfDelta"`
}

func analyticsExplainChangePure(rowsA, rowsB []analyticsMetricRow) (priorTotal, currentTotal, delta int64, contributions []analyticsContribution) {
	prior := map[string]int64{}
	for _, row := range rowsA {
		prior[row.Key] += row.ValueMinor
	}
	current := map[string]int64{}
	for _, row := range rowsB {
		current[row.Key] += row.ValueMinor
	}
	keys := map[string]bool{}
	for key := range prior {
		keys[key] = true
	}
	for key := range current {
		keys[key] = true
	}
	for _, value := range prior {
		priorTotal += value
	}
	for _, value := range current {
		currentTotal += value
	}
	delta = currentTotal - priorTotal
	for key := range keys {
		p, c := prior[key], current[key]
		contribution := analyticsContribution{Key: key, PriorMinor: p, CurrentMinor: c, DeltaMinor: c - p}
		if delta != 0 {
			share := float64(c-p) / float64(delta)
			contribution.ShareOfDelta = &share
		}
		contributions = append(contributions, contribution)
	}
	sort.SliceStable(contributions, func(i, j int) bool {
		if contributions[i].DeltaMinor != contributions[j].DeltaMinor {
			return contributions[i].DeltaMinor < contributions[j].DeltaMinor
		}
		return contributions[i].Key < contributions[j].Key
	})
	return priorTotal, currentTotal, delta, contributions
}

// ── Inputs and outputs ──

type AnalyticsRenderReportInput struct {
	Title     string                        `json:"title"`
	Narrative *string                       `json:"narrative,omitempty"`
	Sections  []analyticsReportSectionInput `json:"sections"`
}

type analyticsReportSection struct {
	Heading string           `json:"heading"`
	SVG     *string          `json:"svg"`
	Columns []string         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
}

type AnalyticsRenderReportOutput struct {
	Region   *string                  `json:"region"`
	HTML     string                   `json:"html"`
	Sections []analyticsReportSection `json:"sections"`
}

type AnalyticsPipelineByStageInput struct{}
type AnalyticsInvoiceAgingInput struct{}
type AnalyticsStockLevelsInput struct{}

type AnalyticsDatasetOutput struct {
	Region  *string          `json:"region"`
	Columns []string         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
}

type AnalyticsRevenueByMonthInput struct {
	MonthsBack int64 `json:"monthsBack"`
}

type AnalyticsSalesByCustomerInput struct {
	Limit int64 `json:"limit"`
}

type AnalyticsExplainChangeInput struct {
	Dimension   string `json:"dimension"`
	PeriodAFrom string `json:"periodAFrom"`
	PeriodATo   string `json:"periodATo"`
	PeriodBFrom string `json:"periodBFrom"`
	PeriodBTo   string `json:"periodBTo"`
}

type AnalyticsExplainChangeOutput struct {
	PriorTotalMinor   int64                   `json:"priorTotalMinor"`
	CurrentTotalMinor int64                   `json:"currentTotalMinor"`
	DeltaMinor        int64                   `json:"deltaMinor"`
	Contributions     []analyticsContribution `json:"contributions"`
	Drill             []analyticsExplainDrill `json:"drill"`
}

type analyticsExplainDrill struct {
	Key        string   `json:"key"`
	InvoiceIDs []string `json:"invoiceIds"`
}

type AnalyticsAskYourBusinessInput struct {
	Focus *string `json:"focus,omitempty"`
}

type analyticsAskSection struct {
	Heading   string   `json:"heading"`
	Citations []string `json:"citations"`
	Lines     []string `json:"lines"`
}

type AnalyticsAskYourBusinessOutput struct {
	Sections       []analyticsAskSection    `json:"sections"`
	ProposedAction *analyticsProposedAction `json:"proposedAction"`
}

type analyticsProposedAction struct {
	CapabilityID string         `json:"capabilityId"`
	InputDraft   map[string]any `json:"inputDraft"`
	Why          string         `json:"why"`
}

func parseAnalyticsChartSpec(raw json.RawMessage) (*analyticsChartSpec, error) {
	var spec analyticsChartSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return nil, errors.New("chart must be an object")
	}
	switch spec.Type {
	case "bar", "line", "area", "pie":
	default:
		return nil, errors.New("chart type must be bar, line, area or pie")
	}
	if spec.X == "" {
		return nil, errors.New("chart needs x")
	}
	if len(spec.Y) < 1 || len(spec.Y) > 3 {
		return nil, errors.New("chart y must have between 1 and 3 columns")
	}
	for _, column := range spec.Y {
		if column == "" {
			return nil, errors.New("chart y columns must be non-empty")
		}
	}
	if spec.Title != nil && len(*spec.Title) > 160 {
		return nil, errors.New("chart title must be at most 160 characters")
	}
	return &spec, nil
}

func ParseAnalyticsRenderReportInput(raw json.RawMessage) (AnalyticsRenderReportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AnalyticsRenderReportInput{}, err
	}
	var input AnalyticsRenderReportInput
	if input.Title, err = requiredCRMDealString(fields, "title", 1, 200); err != nil {
		return AnalyticsRenderReportInput{}, err
	}
	if rawNarrative, ok := fields["narrative"]; ok && string(rawNarrative) != "null" {
		var narrative string
		if err := json.Unmarshal(rawNarrative, &narrative); err != nil {
			return AnalyticsRenderReportInput{}, errors.New("narrative must be a string")
		}
		if len(narrative) > 6000 {
			return AnalyticsRenderReportInput{}, errors.New("narrative must be at most 6000 characters")
		}
		input.Narrative = &narrative
	}
	rawSections, ok := fields["sections"]
	if !ok {
		return AnalyticsRenderReportInput{}, errors.New("sections is required")
	}
	var rawSectionList []json.RawMessage
	if err := json.Unmarshal(rawSections, &rawSectionList); err != nil {
		return AnalyticsRenderReportInput{}, errors.New("sections must be an array")
	}
	if len(rawSectionList) < 1 || len(rawSectionList) > analyticsMaxReportSections {
		return AnalyticsRenderReportInput{}, errors.New(fmt.Sprintf("sections must have between 1 and %d items", analyticsMaxReportSections))
	}
	for _, rawSection := range rawSectionList {
		var sectionFields map[string]json.RawMessage
		if err := json.Unmarshal(rawSection, &sectionFields); err != nil {
			return AnalyticsRenderReportInput{}, errors.New("sections must be objects")
		}
		section := analyticsReportSectionInput{}
		if section.Heading, err = requiredCRMDealString(sectionFields, "heading", 1, 200); err != nil {
			return AnalyticsRenderReportInput{}, err
		}
		if err := json.Unmarshal(sectionFields["columns"], &section.Columns); err != nil || len(section.Columns) < 1 || len(section.Columns) > 30 {
			return AnalyticsRenderReportInput{}, errors.New("columns must be an array of 1 to 30 strings")
		}
		for _, column := range section.Columns {
			if column == "" {
				return AnalyticsRenderReportInput{}, errors.New("columns must be non-empty")
			}
		}
		if err := json.Unmarshal(sectionFields["rows"], &section.Rows); err != nil {
			return AnalyticsRenderReportInput{}, errors.New("rows must be an array of objects")
		}
		if len(section.Rows) > 5000 {
			return AnalyticsRenderReportInput{}, errors.New("rows must have at most 5000 items")
		}
		if rawOps, ok := sectionFields["ops"]; ok && string(rawOps) != "null" {
			if section.Ops, err = analyticsParseFrameOps(rawOps); err != nil {
				return AnalyticsRenderReportInput{}, err
			}
		}
		if rawChart, ok := sectionFields["chart"]; ok && string(rawChart) != "null" {
			if section.Chart, err = parseAnalyticsChartSpec(rawChart); err != nil {
				return AnalyticsRenderReportInput{}, err
			}
		}
		input.Sections = append(input.Sections, section)
	}
	return input, nil
}

func ParseAnalyticsRevenueByMonthInput(raw json.RawMessage) (AnalyticsRevenueByMonthInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AnalyticsRevenueByMonthInput{}, err
	}
	input := AnalyticsRevenueByMonthInput{MonthsBack: 12}
	if _, ok := fields["monthsBack"]; ok {
		if input.MonthsBack, err = requiredSafeInteger(fields, "monthsBack"); err != nil {
			return AnalyticsRevenueByMonthInput{}, err
		}
		if input.MonthsBack < 1 || input.MonthsBack > 36 {
			return AnalyticsRevenueByMonthInput{}, errors.New("monthsBack must be between 1 and 36")
		}
	}
	return input, nil
}

func ParseAnalyticsSalesByCustomerInput(raw json.RawMessage) (AnalyticsSalesByCustomerInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AnalyticsSalesByCustomerInput{}, err
	}
	input := AnalyticsSalesByCustomerInput{Limit: 10}
	if _, ok := fields["limit"]; ok {
		if input.Limit, err = requiredSafeInteger(fields, "limit"); err != nil {
			return AnalyticsSalesByCustomerInput{}, err
		}
		if input.Limit < 1 || input.Limit > 50 {
			return AnalyticsSalesByCustomerInput{}, errors.New("limit must be between 1 and 50")
		}
	}
	return input, nil
}

func ParseAnalyticsExplainChangeInput(raw json.RawMessage) (AnalyticsExplainChangeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AnalyticsExplainChangeInput{}, err
	}
	var input AnalyticsExplainChangeInput
	if input.Dimension, err = projectRequiredEnum(fields, "dimension", []string{"customer", "product"}); err != nil {
		return AnalyticsExplainChangeInput{}, err
	}
	for _, key := range []string{"periodAFrom", "periodATo", "periodBFrom", "periodBTo"} {
		var value string
		if value, err = requiredCRMDealString(fields, key, 0, 0); err != nil {
			return AnalyticsExplainChangeInput{}, err
		}
		switch key {
		case "periodAFrom":
			input.PeriodAFrom = value
		case "periodATo":
			input.PeriodATo = value
		case "periodBFrom":
			input.PeriodBFrom = value
		case "periodBTo":
			input.PeriodBTo = value
		}
		if _, err := time.Parse(time.RFC3339, value); err != nil {
			return AnalyticsExplainChangeInput{}, errors.New(key + " must be an ISO datetime")
		}
	}
	return input, nil
}

func ParseAnalyticsAskYourBusinessInput(raw json.RawMessage) (AnalyticsAskYourBusinessInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AnalyticsAskYourBusinessInput{}, err
	}
	var input AnalyticsAskYourBusinessInput
	if rawFocus, ok := fields["focus"]; ok && string(rawFocus) != "null" {
		var focus string
		if err := json.Unmarshal(rawFocus, &focus); err != nil {
			return AnalyticsAskYourBusinessInput{}, errors.New("focus must be a string")
		}
		if focus != "revenue" && focus != "collections" && focus != "pipeline" {
			return AnalyticsAskYourBusinessInput{}, errors.New("focus must be revenue, collections or pipeline")
		}
		input.Focus = &focus
	}
	return input, nil
}

func parseAnalyticsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case analyticsRenderReportCapabilityID:
		return ParseAnalyticsRenderReportInput(raw)
	case analyticsPipelineByStageCapabilityID:
		if _, err := decodeJSONObject(raw); err != nil {
			return nil, err
		}
		return AnalyticsPipelineByStageInput{}, nil
	case analyticsInvoiceAgingCapabilityID:
		if _, err := decodeJSONObject(raw); err != nil {
			return nil, err
		}
		return AnalyticsInvoiceAgingInput{}, nil
	case analyticsStockLevelsCapabilityID:
		if _, err := decodeJSONObject(raw); err != nil {
			return nil, err
		}
		return AnalyticsStockLevelsInput{}, nil
	case analyticsRevenueByMonthCapabilityID:
		return ParseAnalyticsRevenueByMonthInput(raw)
	case analyticsSalesByCustomerCapabilityID:
		return ParseAnalyticsSalesByCustomerInput(raw)
	case analyticsExplainChangeCapabilityID:
		return ParseAnalyticsExplainChangeInput(raw)
	case analyticsAskYourBusinessCapabilityID:
		return ParseAnalyticsAskYourBusinessInput(raw)
	default:
		return nil, errors.New("unsupported analytics capability")
	}
}

// ValidateAnalyticsDatasetInput validates request parameters for the dataset
// capabilities exposed by the authenticated analytics report endpoint.
func ValidateAnalyticsDatasetInput(capabilityID string, raw json.RawMessage) error {
	switch capabilityID {
	case analyticsPipelineByStageCapabilityID, analyticsRevenueByMonthCapabilityID,
		analyticsInvoiceAgingCapabilityID, analyticsSalesByCustomerCapabilityID,
		analyticsStockLevelsCapabilityID:
		_, err := parseAnalyticsInput(capabilityID, raw)
		return err
	default:
		return errors.New("unsupported analytics dataset")
	}
}

// ── Execute functions ──

func analyticsRegionOf(ctx context.Context, tx pgx.Tx, orgID string) (*string, error) {
	var region *string
	err := tx.QueryRow(ctx, `SELECT data_region FROM organizations WHERE id=$1::uuid`, orgID).Scan(&region)
	if err != nil {
		return nil, err
	}
	return region, nil
}

func analyticsRenderReport(ctx context.Context, tx pgx.Tx, orgID string, input AnalyticsRenderReportInput) (AnalyticsRenderReportOutput, error) {
	rendered := []analyticsReportSection{}
	for _, section := range input.Sections {
		frame := analyticsApplyFrameOps(section.Rows, section.Ops)
		entry := analyticsReportSection{Heading: section.Heading, Columns: section.Columns, Rows: frame.rows}
		if section.Chart != nil {
			entry.SVG = analyticsRenderChartSVG(*section.Chart, frame.rows)
		}
		rendered = append(rendered, entry)
	}
	region, err := analyticsRegionOf(ctx, tx, orgID)
	if err != nil {
		return AnalyticsRenderReportOutput{}, err
	}
	return AnalyticsRenderReportOutput{
		Region:   region,
		HTML:     analyticsRenderReportHTML(input.Title, region, input.Narrative, rendered),
		Sections: rendered,
	}, nil
}

func analyticsPipelineByStage(ctx context.Context, tx pgx.Tx, orgID string) (AnalyticsDatasetOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT stage, count(*)::int AS count, COALESCE(SUM(value_minor), 0)::int AS total_minor
		FROM deals WHERE org_id=$1::uuid GROUP BY stage`, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	type stageRow struct {
		stage      string
		count      int64
		totalMinor int64
	}
	byStage := map[string]stageRow{}
	for rows.Next() {
		var row stageRow
		if err := rows.Scan(&row.stage, &row.count, &row.totalMinor); err != nil {
			rows.Close()
			return AnalyticsDatasetOutput{}, err
		}
		byStage[row.stage] = row
	}
	rows.Close()
	stageWeights := map[string]float64{"lead": 0.1, "qualified": 0.3, "proposal": 0.5, "negotiation": 0.7, "won": 1, "lost": 0}
	region, err := analyticsRegionOf(ctx, tx, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	out := AnalyticsDatasetOutput{Region: region, Columns: []string{"stage", "count", "totalMinor", "weightedMinor"}, Rows: []map[string]any{}}
	for _, stage := range []string{"lead", "qualified", "proposal", "negotiation", "won", "lost"} {
		row := byStage[stage]
		weight := stageWeights[stage]
		out.Rows = append(out.Rows, map[string]any{
			"stage": stage, "count": float64(row.count), "totalMinor": float64(row.totalMinor),
			"weightedMinor": float64(int64(float64(row.totalMinor)*weight + 0.5)),
		})
	}
	return out, nil
}

func analyticsRevenueByMonth(ctx context.Context, tx pgx.Tx, orgID string, input AnalyticsRevenueByMonthInput) (AnalyticsDatasetOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT to_char(date_trunc('month', COALESCE(issued_at, created_at)), 'YYYY-MM') AS month,
		       count(*)::int AS invoiced_count,
		       COALESCE(SUM(total_minor), 0)::int AS total_minor
		FROM invoices
		WHERE org_id=$1::uuid AND status <> 'void' AND voided_at IS NULL
		  AND COALESCE(issued_at, created_at) >= date_trunc('month', now()) - ($2::int - 1) * interval '1 month'
		GROUP BY 1 ORDER BY 1`, orgID, input.MonthsBack)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	type monthRow struct {
		month        string
		count, total int64
	}
	var monthRows []monthRow
	for rows.Next() {
		var row monthRow
		if err := rows.Scan(&row.month, &row.count, &row.total); err != nil {
			rows.Close()
			return AnalyticsDatasetOutput{}, err
		}
		monthRows = append(monthRows, row)
	}
	rows.Close()
	region, err := analyticsRegionOf(ctx, tx, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	out := AnalyticsDatasetOutput{Region: region, Columns: []string{"month", "invoiceCount", "totalMinor"}, Rows: []map[string]any{}}
	for _, row := range monthRows {
		out.Rows = append(out.Rows, map[string]any{"month": row.month, "invoiceCount": float64(row.count), "totalMinor": float64(row.total)})
	}
	return out, rows.Err()
}

func analyticsInvoiceAging(ctx context.Context, tx pgx.Tx, orgID string) (AnalyticsDatasetOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT CASE
		         WHEN age < 30 THEN 'current'
		         WHEN age < 60 THEN '1-30_days_overdue'
		         WHEN age < 90 THEN '30-60_days_overdue'
		         ELSE '90+_days_overdue'
		       END AS bucket,
		       count(*)::int AS count,
		       COALESCE(SUM(balance_minor), 0)::int AS balance_minor
		FROM (
		  SELECT EXTRACT(DAY FROM now() - COALESCE(issued_at, created_at))::int AS age,
		         total_minor - credited_minor - paid_minor AS balance_minor
		  FROM invoices
		  WHERE org_id=$1::uuid AND status IN ('sent','paid') AND voided_at IS NULL
		    AND total_minor > credited_minor + paid_minor
		) open
		GROUP BY 1 ORDER BY 1`, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	type bucketRow struct {
		bucket       string
		count        int64
		balanceMinor int64
	}
	byBucket := map[string]bucketRow{}
	for rows.Next() {
		var row bucketRow
		if err := rows.Scan(&row.bucket, &row.count, &row.balanceMinor); err != nil {
			rows.Close()
			return AnalyticsDatasetOutput{}, err
		}
		byBucket[row.bucket] = row
	}
	rows.Close()
	region, err := analyticsRegionOf(ctx, tx, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	out := AnalyticsDatasetOutput{Region: region, Columns: []string{"bucket", "count", "balanceMinor"}, Rows: []map[string]any{}}
	for _, bucket := range []string{"current", "1-30_days_overdue", "30-60_days_overdue", "90+_days_overdue"} {
		row := byBucket[bucket]
		out.Rows = append(out.Rows, map[string]any{"bucket": bucket, "count": float64(row.count), "balanceMinor": float64(row.balanceMinor)})
	}
	return out, nil
}

func analyticsSalesByCustomer(ctx context.Context, tx pgx.Tx, orgID string, input AnalyticsSalesByCustomerInput) (AnalyticsDatasetOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT c.name AS customer_name, count(i.id)::int AS invoice_count, COALESCE(SUM(i.total_minor), 0)::int AS total_minor
		FROM customers c
		JOIN invoices i ON i.customer_id = c.id AND i.org_id=$1::uuid AND i.status <> 'void' AND i.voided_at IS NULL
		WHERE c.org_id=$1::uuid
		GROUP BY c.id, c.name
		ORDER BY total_minor DESC
		LIMIT $2`, orgID, input.Limit)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	type salesRow struct {
		name         string
		count, total int64
	}
	var salesRows []salesRow
	for rows.Next() {
		var row salesRow
		if err := rows.Scan(&row.name, &row.count, &row.total); err != nil {
			rows.Close()
			return AnalyticsDatasetOutput{}, err
		}
		salesRows = append(salesRows, row)
	}
	rows.Close()
	region, err := analyticsRegionOf(ctx, tx, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	out := AnalyticsDatasetOutput{Region: region, Columns: []string{"customerName", "invoiceCount", "totalMinor"}, Rows: []map[string]any{}}
	for _, row := range salesRows {
		out.Rows = append(out.Rows, map[string]any{"customerName": row.name, "invoiceCount": float64(row.count), "totalMinor": float64(row.total)})
	}
	return out, rows.Err()
}

func analyticsStockLevels(ctx context.Context, tx pgx.Tx, orgID string) (AnalyticsDatasetOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT i.sku, i.name, COALESCE(m.on_hand, 0)::int AS on_hand_thousandths, m.unit_cost_minor, i.reorder_point_thousandths
		FROM items i
		LEFT JOIN LATERAL (
		  SELECT SUM(sm.quantity_delta) AS on_hand,
		         (ARRAY_AGG(sm.unit_cost_minor ORDER BY sm.created_at DESC) FILTER (WHERE sm.unit_cost_minor IS NOT NULL))[1] AS unit_cost_minor
		  FROM stock_movements sm WHERE sm.item_id = i.id
		) m ON true
		WHERE i.org_id=$1::uuid AND i.archived_at IS NULL
		ORDER BY i.sku`, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	type stockRow struct {
		sku, name       string
		onHand, reorder int64
		unitCost        *int64
	}
	var stockRows []stockRow
	for rows.Next() {
		var row stockRow
		if err := rows.Scan(&row.sku, &row.name, &row.onHand, &row.unitCost, &row.reorder); err != nil {
			rows.Close()
			return AnalyticsDatasetOutput{}, err
		}
		stockRows = append(stockRows, row)
	}
	rows.Close()
	region, err := analyticsRegionOf(ctx, tx, orgID)
	if err != nil {
		return AnalyticsDatasetOutput{}, err
	}
	out := AnalyticsDatasetOutput{Region: region, Columns: []string{"sku", "name", "onHandThousandths", "unitCostMinor", "reorderPointThousandths", "valueMinor"}, Rows: []map[string]any{}}
	for _, row := range stockRows {
		entry := map[string]any{
			"sku": row.sku, "name": row.name, "onHandThousandths": float64(row.onHand),
			"unitCostMinor": nil, "reorderPointThousandths": float64(row.reorder), "valueMinor": nil,
		}
		if row.unitCost != nil {
			entry["unitCostMinor"] = float64(*row.unitCost)
			entry["valueMinor"] = float64(int64((float64(row.onHand)/1000)*float64(*row.unitCost) + 0.5))
		}
		out.Rows = append(out.Rows, entry)
	}
	return out, rows.Err()
}

func analyticsMetricRowsByDimension(ctx context.Context, tx pgx.Tx, orgID, dimension string, from, to time.Time) ([]analyticsMetricRow, error) {
	keyExpr := "invoice_lines.description"
	if dimension == "customer" {
		keyExpr = "coalesce(customers.name, invoices.customer_id::text)"
	}
	rows, err := tx.Query(ctx, `
		SELECT `+keyExpr+` AS key, COALESCE(SUM(invoice_lines.quantity * invoice_lines.unit_price_minor / 1000), 0) AS value_minor
		FROM invoice_lines
		INNER JOIN invoices ON invoice_lines.invoice_id = invoices.id
		LEFT JOIN customers ON customers.id = invoices.customer_id
		WHERE invoices.org_id=$1::uuid AND invoices.status IN ('sent','paid') AND invoices.voided_at IS NULL
		  AND invoices.issued_at >= $2::timestamptz AND invoices.issued_at < $3::timestamptz
		GROUP BY 1`, orgID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []analyticsMetricRow
	for rows.Next() {
		var key string
		var value float64
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		out = append(out, analyticsMetricRow{Key: key, ValueMinor: int64(value)})
	}
	return out, rows.Err()
}

func analyticsExplainChange(ctx context.Context, tx pgx.Tx, orgID string, input AnalyticsExplainChangeInput) (AnalyticsExplainChangeOutput, error) {
	fromA, _ := time.Parse(time.RFC3339, input.PeriodAFrom)
	toA, _ := time.Parse(time.RFC3339, input.PeriodATo)
	fromB, _ := time.Parse(time.RFC3339, input.PeriodBFrom)
	toB, _ := time.Parse(time.RFC3339, input.PeriodBTo)
	rowsA, err := analyticsMetricRowsByDimension(ctx, tx, orgID, input.Dimension, fromA, toA)
	if err != nil {
		return AnalyticsExplainChangeOutput{}, err
	}
	rowsB, err := analyticsMetricRowsByDimension(ctx, tx, orgID, input.Dimension, fromB, toB)
	if err != nil {
		return AnalyticsExplainChangeOutput{}, err
	}
	priorTotal, currentTotal, delta, contributions := analyticsExplainChangePure(rowsA, rowsB)
	out := AnalyticsExplainChangeOutput{
		PriorTotalMinor: priorTotal, CurrentTotalMinor: currentTotal, DeltaMinor: delta,
		Contributions: []analyticsContribution{}, Drill: []analyticsExplainDrill{},
	}
	if contributions == nil {
		contributions = []analyticsContribution{}
	}
	out.Contributions = contributions
	movers := contributions
	if len(movers) > 5 {
		movers = movers[:5]
	}
	for _, mover := range movers {
		keyExpr := "invoice_lines.description"
		if input.Dimension == "customer" {
			keyExpr = "coalesce(customers.name, invoices.customer_id::text)"
		}
		invoiceRows, err := tx.Query(ctx, `
			SELECT invoices.id::text
			FROM invoice_lines
			INNER JOIN invoices ON invoice_lines.invoice_id = invoices.id
			LEFT JOIN customers ON customers.id = invoices.customer_id
			WHERE invoices.org_id=$1::uuid AND invoices.status IN ('sent','paid') AND invoices.voided_at IS NULL
			  AND invoices.issued_at >= $2::timestamptz AND invoices.issued_at < $3::timestamptz
			  AND (`+keyExpr+`) = $4
			LIMIT 10`, orgID, fromB, toB, mover.Key)
		if err != nil {
			return AnalyticsExplainChangeOutput{}, err
		}
		drill := analyticsExplainDrill{Key: mover.Key, InvoiceIDs: []string{}}
		for invoiceRows.Next() {
			var invoiceID string
			if err := invoiceRows.Scan(&invoiceID); err != nil {
				invoiceRows.Close()
				return AnalyticsExplainChangeOutput{}, err
			}
			drill.InvoiceIDs = append(drill.InvoiceIDs, invoiceID)
		}
		invoiceRows.Close()
		out.Drill = append(out.Drill, drill)
	}
	return out, nil
}

func analyticsAskYourBusiness(ctx context.Context, tx pgx.Tx, orgID string, input AnalyticsAskYourBusinessInput, now time.Time) (AnalyticsAskYourBusinessOutput, error) {
	focus := "revenue"
	if input.Focus != nil {
		focus = *input.Focus
	}
	out := AnalyticsAskYourBusinessOutput{Sections: []analyticsAskSection{}}
	if focus == "revenue" {
		sales, err := analyticsSalesByCustomer(ctx, tx, orgID, AnalyticsSalesByCustomerInput{Limit: 3})
		if err != nil {
			return AnalyticsAskYourBusinessOutput{}, err
		}
		section := analyticsAskSection{Heading: "Top customers this period", Citations: []string{}, Lines: []string{}}
		for _, row := range sales.Rows {
			name := toJSONString(row["customerName"])
			section.Citations = append(section.Citations, name)
			section.Lines = append(section.Lines, fmt.Sprintf("%s: %s invoice(s), %s minor", name, toJSONString(row["invoiceCount"]), toJSONString(row["totalMinor"])))
		}
		out.Sections = append(out.Sections, section)
	} else if focus == "collections" {
		aging, err := analyticsInvoiceAging(ctx, tx, orgID)
		if err != nil {
			return AnalyticsAskYourBusinessOutput{}, err
		}
		section := analyticsAskSection{Heading: "Receivables aging", Citations: []string{}, Lines: []string{}}
		for index, row := range aging.Rows {
			if index >= 5 {
				break
			}
			section.Citations = append(section.Citations, toJSONString(row["bucket"]))
			encoded, _ := json.Marshal(row)
			section.Lines = append(section.Lines, string(encoded))
		}
		out.Sections = append(out.Sections, section)
	} else {
		pipeline, err := analyticsPipelineByStage(ctx, tx, orgID)
		if err != nil {
			return AnalyticsAskYourBusinessOutput{}, err
		}
		section := analyticsAskSection{Heading: "Pipeline by stage", Citations: []string{}, Lines: []string{}}
		for _, row := range pipeline.Rows {
			encoded, _ := json.Marshal(row)
			section.Lines = append(section.Lines, string(encoded))
		}
		out.Sections = append(out.Sections, section)
	}

	signalsProducersMu.RLock()
	producers := append([]SignalProducer{}, signalsProducers...)
	signalsProducersMu.RUnlock()
	var top *BusinessSignal
	for _, producer := range producers {
		produced, err := producer(ctx, orgID, now)
		if err != nil || len(produced) == 0 {
			continue
		}
		first := produced[0]
		top = &first
		break
	}
	if top != nil {
		out.Sections = append(out.Sections, analyticsAskSection{
			Heading: "Needs attention", Citations: []string{top.ID}, Lines: []string{top.Subject},
		})
		if top.SuggestedAction != nil {
			draft := map[string]any{}
			_ = json.Unmarshal(top.SuggestedAction.InputDraft, &draft)
			out.ProposedAction = &analyticsProposedAction{
				CapabilityID: top.SuggestedAction.CapabilityID, InputDraft: draft, Why: top.Subject,
			}
		}
	}
	return out, nil
}
