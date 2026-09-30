package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	routinesCreateCapabilityID = "routines.create"
	routinesListCapabilityID   = "routines.list"
	routinesUpdateCapabilityID = "routines.update"
	routinesDeleteCapabilityID = "routines.delete"
	routinesRunNowCapabilityID = "routines.runNow"

	routineNameMax         = 120
	routinePromptMax       = 4000
	routineScheduleTextMax = 200
	routineListLimit       = 100
	routineJobType         = "routines.executeRoutine"

	routinesMinIntervalMinutes = 5
	routinesMaxIntervalMinutes = 10080
)

type RoutineSchedule struct {
	Kind         string  `json:"kind"`
	EveryMinutes *int64  `json:"everyMinutes,omitempty"`
	AtTime       *string `json:"atTime,omitempty"`
	DayOfWeek    *int64  `json:"dayOfWeek,omitempty"`
}

func routinesParseTime(hhmm string) (string, bool) {
	pattern := regexp.MustCompile(`^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$`)
	match := pattern.FindStringSubmatch(strings.TrimSpace(hhmm))
	if match == nil {
		return "", false
	}
	hours, _ := strconv.Atoi(match[1])
	minutes := 0
	if match[2] != "" {
		minutes, _ = strconv.Atoi(match[2])
	}
	meridiem := strings.ToLower(match[3])
	if meridiem == "pm" && hours < 12 {
		hours += 12
	}
	if meridiem == "am" && hours == 12 {
		hours = 0
	}
	if hours > 23 || minutes > 59 {
		return "", false
	}
	return fmt.Sprintf("%02d:%02d", hours, minutes), true
}

var routinesDayNames = []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}

func routinesDayFromName(word string) (int, bool) {
	if len(word) < 3 {
		return 0, false
	}
	lower := strings.ToLower(word)
	for idx, name := range routinesDayNames {
		if strings.HasPrefix(name, lower) {
			return idx, true
		}
	}
	return 0, false
}

func routinesParseScheduleText(raw string) (RoutineSchedule, bool) {
	text := strings.ToLower(strings.TrimSpace(raw))
	if text == "" {
		return RoutineSchedule{}, false
	}
	minutes := int64(-1)
	intervalPattern := regexp.MustCompile(`^every\s+(\d+)\s*(min(?:ute)?s?|hours?|h)$`)
	if match := intervalPattern.FindStringSubmatch(text); match != nil {
		n, _ := strconv.ParseInt(match[1], 10, 64)
		if strings.HasPrefix(match[2], "h") {
			minutes = n * 60
		} else {
			minutes = n
		}
	} else if regexp.MustCompile(`^every\s+half\s+hour$`).MatchString(text) {
		minutes = 30
	} else if regexp.MustCompile(`^every\s+quarter\s+hour$`).MatchString(text) {
		minutes = 15
	} else if regexp.MustCompile(`^hourly$`).MatchString(text) {
		minutes = 60
	}
	if minutes >= 0 {
		if minutes < routinesMinIntervalMinutes || minutes > routinesMaxIntervalMinutes {
			return RoutineSchedule{}, false
		}
		value := minutes
		return RoutineSchedule{Kind: "interval", EveryMinutes: &value}, true
	}

	if match := regexp.MustCompile(`^weekdays?\s+(?:at\s+)?(.+)$`).FindStringSubmatch(text); match != nil {
		atTime, ok := routinesParseTime(match[1])
		if !ok {
			return RoutineSchedule{}, false
		}
		return RoutineSchedule{Kind: "weekdays", AtTime: &atTime}, true
	}

	daily := regexp.MustCompile(`^(?:daily|every\s+day)\s+(?:at\s+)?(.+)$`).FindStringSubmatch(text)
	if daily == nil {
		daily = regexp.MustCompile(`^at\s+(.+)\s+(?:daily|every\s+day)$`).FindStringSubmatch(text)
	}
	if daily != nil {
		atTime, ok := routinesParseTime(daily[1])
		if !ok {
			return RoutineSchedule{}, false
		}
		return RoutineSchedule{Kind: "daily", AtTime: &atTime}, true
	}

	weekly := regexp.MustCompile(`^(?:weekly\s+(?:on\s+)?|every\s+)([a-z]+)\s+(?:at\s+)?(.+)$`).FindStringSubmatch(text)
	if weekly == nil {
		weekly = regexp.MustCompile(`^([a-z]+)s\s+at\s+(.+)$`).FindStringSubmatch(text)
	}
	if weekly != nil {
		day, ok := routinesDayFromName(weekly[1])
		if !ok {
			return RoutineSchedule{}, false
		}
		atTime, ok := routinesParseTime(weekly[2])
		if !ok {
			return RoutineSchedule{}, false
		}
		dayValue := int64(day)
		return RoutineSchedule{Kind: "weekly", AtTime: &atTime, DayOfWeek: &dayValue}, true
	}
	return RoutineSchedule{}, false
}

var routinesDayLabels = []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

func routinesDescribeSchedule(schedule RoutineSchedule) string {
	switch schedule.Kind {
	case "interval":
		minutes := int64(60)
		if schedule.EveryMinutes != nil {
			minutes = *schedule.EveryMinutes
		}
		if minutes%60 == 0 {
			hours := minutes / 60
			if hours == 1 {
				return "Hourly"
			}
			return fmt.Sprintf("Every %d hours", hours)
		}
		return fmt.Sprintf("Every %d minutes", minutes)
	case "daily":
		return fmt.Sprintf("Daily at %s", *schedule.AtTime)
	case "weekdays":
		return fmt.Sprintf("Weekdays at %s", *schedule.AtTime)
	case "weekly":
		dayIndex := int64(0)
		if schedule.DayOfWeek != nil {
			dayIndex = *schedule.DayOfWeek
		}
		return fmt.Sprintf("Weekly on %s at %s", routinesDayLabels[dayIndex], *schedule.AtTime)
	}
	return "(unchanged)"
}

func routinesAtOrAfter(from time.Time, atTime string) time.Time {
	parts := strings.Split(atTime, ":")
	hours, _ := strconv.Atoi(parts[0])
	minutes := 0
	if len(parts) > 1 {
		minutes, _ = strconv.Atoi(parts[1])
	}
	return time.Date(from.Year(), from.Month(), from.Day(), hours, minutes, 0, 0, from.Location())
}

func routinesNextRun(schedule RoutineSchedule, from time.Time) time.Time {
	return RoutinesNextRun(schedule, from)
}

func RoutinesNextRun(schedule RoutineSchedule, from time.Time) time.Time {
	switch schedule.Kind {
	case "interval":
		minutes := int64(60)
		if schedule.EveryMinutes != nil {
			minutes = *schedule.EveryMinutes
		}
		return from.Add(time.Duration(minutes) * time.Minute)
	case "daily":
		atTime := "08:00"
		if schedule.AtTime != nil {
			atTime = *schedule.AtTime
		}
		today := routinesAtOrAfter(from, atTime)
		if today.After(from) {
			return today
		}
		return today.Add(24 * time.Hour)
	case "weekdays":
		atTime := "08:00"
		if schedule.AtTime != nil {
			atTime = *schedule.AtTime
		}
		probe := from
		for i := 0; i < 8; i++ {
			candidate := routinesAtOrAfter(probe, atTime)
			day := candidate.Weekday()
			if day >= time.Monday && day <= time.Friday && candidate.After(from) {
				return candidate
			}
			probe = time.Date(probe.Year(), probe.Month(), probe.Day()+1, 0, 0, 0, 0, probe.Location())
		}
		return from.Add(24 * time.Hour)
	case "weekly":
		target := time.Monday
		if schedule.DayOfWeek != nil {
			target = time.Weekday(int(*schedule.DayOfWeek))
		}
		atTime := "08:00"
		if schedule.AtTime != nil {
			atTime = *schedule.AtTime
		}
		probe := from
		for i := 0; i < 8; i++ {
			candidate := routinesAtOrAfter(probe, atTime)
			if candidate.Weekday() == target && candidate.After(from) {
				return candidate
			}
			probe = time.Date(probe.Year(), probe.Month(), probe.Day()+1, 0, 0, 0, 0, probe.Location())
		}
		return from.Add(7 * 24 * time.Hour)
	}
	return from
}

func routinesValidateSchedule(schedule RoutineSchedule) error {
	if schedule.Kind == "interval" && schedule.EveryMinutes == nil {
		return errors.New("interval schedules need everyMinutes")
	}
	if schedule.Kind != "interval" && schedule.AtTime == nil {
		return errors.New("time-based schedules need atTime (HH:MM)")
	}
	if schedule.Kind == "weekly" && schedule.DayOfWeek == nil {
		return errors.New("weekly schedules need dayOfWeek (0=Sunday..6=Saturday)")
	}
	return nil
}

func ValidateRoutineSchedule(schedule RoutineSchedule) error {
	return routinesValidateSchedule(schedule)
}

type RoutinesCreateInput struct {
	Name         string           `json:"name"`
	Prompt       string           `json:"prompt"`
	ScheduleText *string          `json:"scheduleText,omitempty"`
	Schedule     *RoutineSchedule `json:"schedule,omitempty"`
	WithWebhook  bool             `json:"withWebhook"`
}

type RoutinesCreateOutput struct {
	RoutineID     string          `json:"routineId"`
	Schedule      RoutineSchedule `json:"schedule"`
	ScheduleLabel string          `json:"scheduleLabel"`
	NextRunAt     string          `json:"nextRunAt"`
	WebhookToken  *string         `json:"webhookToken"`
}

type RoutinesListInput struct {
	Limit int64 `json:"limit"`
}

type RoutinesListItem struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	ScheduleLabel string  `json:"scheduleLabel"`
	TriggerType   string  `json:"triggerType"`
	Enabled       bool    `json:"enabled"`
	NextRunAt     *string `json:"nextRunAt"`
	LastRunAt     *string `json:"lastRunAt"`
	LastStatus    *string `json:"lastStatus"`
	LastError     *string `json:"lastError"`
}

type RoutinesListOutput struct {
	Routines []RoutinesListItem `json:"routines"`
}

type RoutinesUpdateInput struct {
	RoutineID    string           `json:"routineId"`
	Name         *string          `json:"name,omitempty"`
	Prompt       *string          `json:"prompt,omitempty"`
	ScheduleText *string          `json:"scheduleText,omitempty"`
	Schedule     *RoutineSchedule `json:"schedule,omitempty"`
	Enabled      *bool            `json:"enabled,omitempty"`
}

type RoutinesUpdateOutput struct {
	RoutineID     string  `json:"routineId"`
	ScheduleLabel string  `json:"scheduleLabel"`
	NextRunAt     *string `json:"nextRunAt"`
}

type RoutinesDeleteInput struct {
	RoutineID string `json:"routineId"`
}

type RoutinesDeleteOutput struct {
	Name         string          `json:"name"`
	Prompt       string          `json:"prompt"`
	ScheduleText *string         `json:"scheduleText"`
	Schedule     RoutineSchedule `json:"schedule"`
}

type RoutinesRunNowInput struct {
	RoutineID string `json:"routineId"`
}

type RoutinesRunNowOutput struct {
	JobID string `json:"jobId"`
}

func routinesParseStructuredSchedule(fields map[string]json.RawMessage, key string) (*RoutineSchedule, error) {
	rawSchedule, ok := fields[key]
	if !ok {
		return nil, nil
	}
	var schedule RoutineSchedule
	if err := json.Unmarshal(rawSchedule, &schedule); err != nil {
		return nil, errors.New("schedule must be an object")
	}
	switch schedule.Kind {
	case "interval", "daily", "weekdays", "weekly":
	default:
		return nil, errors.New("schedule kind must be interval, daily, weekdays or weekly")
	}
	if schedule.Kind == "interval" {
		if schedule.EveryMinutes == nil {
			return nil, errors.New("interval schedules need everyMinutes")
		}
		if *schedule.EveryMinutes < routinesMinIntervalMinutes || *schedule.EveryMinutes > routinesMaxIntervalMinutes {
			return nil, errors.New(fmt.Sprintf("everyMinutes must be between %d and %d", routinesMinIntervalMinutes, routinesMaxIntervalMinutes))
		}
	}
	if schedule.Kind != "interval" && schedule.AtTime != nil {
		if _, ok := routinesParseTime(*schedule.AtTime); !ok {
			return nil, errors.New("atTime must be a valid HH:MM time")
		}
	}
	if schedule.Kind == "weekly" && schedule.DayOfWeek != nil {
		if *schedule.DayOfWeek < 0 || *schedule.DayOfWeek > 6 {
			return nil, errors.New("dayOfWeek must be between 0 and 6")
		}
	}
	return &schedule, nil
}

func ParseRoutinesCreateInput(raw json.RawMessage) (RoutinesCreateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RoutinesCreateInput{}, err
	}
	var input RoutinesCreateInput
	if input.Name, err = requiredCRMDealString(fields, "name", 1, routineNameMax); err != nil {
		return RoutinesCreateInput{}, err
	}
	if input.Prompt, err = requiredCRMDealString(fields, "prompt", 1, routinePromptMax); err != nil {
		return RoutinesCreateInput{}, err
	}
	if rawScheduleText, ok := fields["scheduleText"]; ok && string(rawScheduleText) != "null" {
		var scheduleText string
		if err := json.Unmarshal(rawScheduleText, &scheduleText); err != nil {
			return RoutinesCreateInput{}, errors.New("scheduleText must be a string")
		}
		if len(scheduleText) < 3 || len(scheduleText) > routineScheduleTextMax {
			return RoutinesCreateInput{}, errors.New(fmt.Sprintf("scheduleText must be between 3 and %d characters", routineScheduleTextMax))
		}
		input.ScheduleText = &scheduleText
	}
	schedule, err := routinesParseStructuredSchedule(fields, "schedule")
	if err != nil {
		return RoutinesCreateInput{}, err
	}
	input.Schedule = schedule
	if rawWithWebhook, ok := fields["withWebhook"]; ok {
		if err := json.Unmarshal(rawWithWebhook, &input.WithWebhook); err != nil {
			return RoutinesCreateInput{}, errors.New("withWebhook must be a boolean")
		}
	}
	return input, nil
}

func ParseRoutinesListInput(raw json.RawMessage) (RoutinesListInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RoutinesListInput{}, err
	}
	input := RoutinesListInput{Limit: 50}
	if _, ok := fields["limit"]; ok {
		if input.Limit, err = requiredSafeInteger(fields, "limit"); err != nil {
			return RoutinesListInput{}, err
		}
		if input.Limit < 1 || input.Limit > routineListLimit {
			return RoutinesListInput{}, errors.New(fmt.Sprintf("limit must be between 1 and %d", routineListLimit))
		}
	}
	return input, nil
}

func ParseRoutinesUpdateInput(raw json.RawMessage) (RoutinesUpdateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RoutinesUpdateInput{}, err
	}
	var input RoutinesUpdateInput
	if input.RoutineID, err = projectRequiredUUID(fields, "routineId"); err != nil {
		return RoutinesUpdateInput{}, err
	}
	if rawName, ok := fields["name"]; ok && string(rawName) != "null" {
		var name string
		if err := json.Unmarshal(rawName, &name); err != nil {
			return RoutinesUpdateInput{}, errors.New("name must be a string")
		}
		if len(name) < 1 || len(name) > routineNameMax {
			return RoutinesUpdateInput{}, errors.New(fmt.Sprintf("name must be between 1 and %d characters", routineNameMax))
		}
		input.Name = &name
	}
	if rawPrompt, ok := fields["prompt"]; ok && string(rawPrompt) != "null" {
		var prompt string
		if err := json.Unmarshal(rawPrompt, &prompt); err != nil {
			return RoutinesUpdateInput{}, errors.New("prompt must be a string")
		}
		if len(prompt) < 1 || len(prompt) > routinePromptMax {
			return RoutinesUpdateInput{}, errors.New(fmt.Sprintf("prompt must be between 1 and %d characters", routinePromptMax))
		}
		input.Prompt = &prompt
	}
	if rawScheduleText, ok := fields["scheduleText"]; ok && string(rawScheduleText) != "null" {
		var scheduleText string
		if err := json.Unmarshal(rawScheduleText, &scheduleText); err != nil {
			return RoutinesUpdateInput{}, errors.New("scheduleText must be a string")
		}
		if len(scheduleText) < 3 || len(scheduleText) > routineScheduleTextMax {
			return RoutinesUpdateInput{}, errors.New(fmt.Sprintf("scheduleText must be between 3 and %d characters", routineScheduleTextMax))
		}
		input.ScheduleText = &scheduleText
	}
	schedule, err := routinesParseStructuredSchedule(fields, "schedule")
	if err != nil {
		return RoutinesUpdateInput{}, err
	}
	input.Schedule = schedule
	if rawEnabled, ok := fields["enabled"]; ok && string(rawEnabled) != "null" {
		var enabled bool
		if err := json.Unmarshal(rawEnabled, &enabled); err != nil {
			return RoutinesUpdateInput{}, errors.New("enabled must be a boolean")
		}
		input.Enabled = &enabled
	}
	return input, nil
}

func ParseRoutinesDeleteInput(raw json.RawMessage) (RoutinesDeleteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RoutinesDeleteInput{}, err
	}
	var input RoutinesDeleteInput
	if input.RoutineID, err = projectRequiredUUID(fields, "routineId"); err != nil {
		return RoutinesDeleteInput{}, err
	}
	return input, nil
}

func ParseRoutinesRunNowInput(raw json.RawMessage) (RoutinesRunNowInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RoutinesRunNowInput{}, err
	}
	var input RoutinesRunNowInput
	if input.RoutineID, err = projectRequiredUUID(fields, "routineId"); err != nil {
		return RoutinesRunNowInput{}, err
	}
	return input, nil
}

func parseRoutinesInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case routinesCreateCapabilityID:
		return ParseRoutinesCreateInput(raw)
	case routinesListCapabilityID:
		return ParseRoutinesListInput(raw)
	case routinesUpdateCapabilityID:
		return ParseRoutinesUpdateInput(raw)
	case routinesDeleteCapabilityID:
		return ParseRoutinesDeleteInput(raw)
	case routinesRunNowCapabilityID:
		return ParseRoutinesRunNowInput(raw)
	default:
		return nil, errors.New("unsupported routines capability")
	}
}

func routinesResolveSchedule(scheduleText *string, structured *RoutineSchedule) (RoutineSchedule, *string, error) {
	if structured != nil {
		return *structured, nil, routinesValidateSchedule(*structured)
	}
	if scheduleText != nil {
		parsed, ok := routinesParseScheduleText(*scheduleText)
		if !ok {
			return RoutineSchedule{}, nil, errors.New("could not parse the schedule: try shapes like 'every 30 minutes', 'daily at 08:00', 'weekdays at 9am' or 'weekly on monday at 09:00'")
		}
		return parsed, scheduleText, nil
	}
	return RoutineSchedule{}, nil, errors.New("a schedule is required: pass scheduleText or a structured schedule")
}

func routinesFormatISO(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func routinesCreate(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RoutinesCreateInput, now time.Time) (RoutinesCreateOutput, error) {
	schedule, scheduleText, err := routinesResolveSchedule(input.ScheduleText, input.Schedule)
	if err != nil {
		return RoutinesCreateOutput{}, err
	}
	nextRunAt := routinesNextRun(schedule, now)
	var webhookToken *string
	triggerType := "schedule"
	if input.WithWebhook {
		token, err := manufacturingNewRunRef()
		if err != nil {
			return RoutinesCreateOutput{}, err
		}
		webhookToken = &token
		triggerType = "webhook"
	}
	scheduleJSON, err := json.Marshal(schedule)
	if err != nil {
		return RoutinesCreateOutput{}, err
	}
	var routineID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO routines (org_id, name, prompt, schedule_text, schedule, trigger_type, webhook_token, next_run_at, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
		RETURNING id::text`,
		claims.OrganizationID, input.Name, input.Prompt, scheduleText, string(scheduleJSON), triggerType, webhookToken, nextRunAt, claims.ActorType, claims.ActorID).Scan(&routineID); err != nil {
		return RoutinesCreateOutput{}, err
	}
	return RoutinesCreateOutput{
		RoutineID: routineID, Schedule: schedule,
		ScheduleLabel: routinesDescribeSchedule(schedule),
		NextRunAt:     routinesFormatISO(nextRunAt), WebhookToken: webhookToken,
	}, nil
}

func routinesList(ctx context.Context, tx pgx.Tx, orgID string, input RoutinesListInput) (RoutinesListOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, schedule, trigger_type, enabled, next_run_at, last_run_at, last_status, last_error
		FROM routines WHERE org_id=$1::uuid ORDER BY created_at DESC LIMIT $2`, orgID, input.Limit)
	if err != nil {
		return RoutinesListOutput{}, err
	}
	defer rows.Close()
	out := RoutinesListOutput{Routines: []RoutinesListItem{}}
	for rows.Next() {
		var item RoutinesListItem
		var scheduleJSON []byte
		var nextRunAt, lastRunAt *time.Time
		if err := rows.Scan(&item.ID, &item.Name, &scheduleJSON, &item.TriggerType, &item.Enabled, &nextRunAt, &lastRunAt, &item.LastStatus, &item.LastError); err != nil {
			return RoutinesListOutput{}, err
		}
		var schedule RoutineSchedule
		_ = json.Unmarshal(scheduleJSON, &schedule)
		item.ScheduleLabel = routinesDescribeSchedule(schedule)
		if nextRunAt != nil {
			formatted := routinesFormatISO(*nextRunAt)
			item.NextRunAt = &formatted
		}
		if lastRunAt != nil {
			formatted := routinesFormatISO(*lastRunAt)
			item.LastRunAt = &formatted
		}
		out.Routines = append(out.Routines, item)
	}
	return out, rows.Err()
}

func routinesUpdate(ctx context.Context, tx pgx.Tx, orgID string, input RoutinesUpdateInput, now time.Time) (RoutinesUpdateOutput, error) {
	var scheduleJSON []byte
	var existingNextRunAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT schedule, next_run_at FROM routines WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.RoutineID, orgID).Scan(&scheduleJSON, &existingNextRunAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoutinesUpdateOutput{}, errors.New("routine not found")
	}
	if err != nil {
		return RoutinesUpdateOutput{}, err
	}
	sets := []string{}
	args := []any{}
	arg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if input.Name != nil {
		sets = append(sets, "name="+arg(*input.Name))
	}
	if input.Prompt != nil {
		sets = append(sets, "prompt="+arg(*input.Prompt))
	}
	if input.Enabled != nil {
		sets = append(sets, "enabled="+arg(*input.Enabled))
	}
	var schedule *RoutineSchedule
	scheduleChanged := input.Schedule != nil || input.ScheduleText != nil
	if input.Schedule != nil {
		schedule = input.Schedule
		encoded, err := json.Marshal(*input.Schedule)
		if err != nil {
			return RoutinesUpdateOutput{}, err
		}
		sets = append(sets, "schedule="+arg(string(encoded))+"::jsonb")
		sets = append(sets, "schedule_text="+arg(nil))
	} else if input.ScheduleText != nil {
		parsed, ok := routinesParseScheduleText(*input.ScheduleText)
		if !ok {
			return RoutinesUpdateOutput{}, errors.New("could not parse the new schedule")
		}
		schedule = &parsed
		encoded, err := json.Marshal(parsed)
		if err != nil {
			return RoutinesUpdateOutput{}, err
		}
		sets = append(sets, "schedule="+arg(string(encoded))+"::jsonb")
		sets = append(sets, "schedule_text="+arg(*input.ScheduleText))
	} else {
		var existing RoutineSchedule
		_ = json.Unmarshal(scheduleJSON, &existing)
		schedule = &existing
	}
	var nextRunAt *time.Time
	if scheduleChanged && schedule != nil {
		next := routinesNextRun(*schedule, now)
		nextRunAt = &next
		sets = append(sets, "next_run_at="+arg(next))
	}
	if len(sets) > 0 {
		query := "UPDATE routines SET "
		for i, set := range sets {
			if i > 0 {
				query += ", "
			}
			query += set
		}
		query += " WHERE id=" + arg(input.RoutineID) + "::uuid"
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			return RoutinesUpdateOutput{}, err
		}
	}
	label := "(unchanged)"
	if schedule != nil {
		label = routinesDescribeSchedule(*schedule)
	}
	out := RoutinesUpdateOutput{RoutineID: input.RoutineID, ScheduleLabel: label}
	if nextRunAt != nil {
		formatted := routinesFormatISO(*nextRunAt)
		out.NextRunAt = &formatted
	} else if existingNextRunAt != nil {
		formatted := routinesFormatISO(*existingNextRunAt)
		out.NextRunAt = &formatted
	}
	return out, nil
}

func routinesDelete(ctx context.Context, tx pgx.Tx, orgID string, input RoutinesDeleteInput) (RoutinesDeleteOutput, error) {
	var out RoutinesDeleteOutput
	var scheduleJSON []byte
	err := tx.QueryRow(ctx, `
		DELETE FROM routines WHERE id=$1::uuid AND org_id=$2::uuid
		RETURNING name, prompt, schedule_text, schedule`, input.RoutineID, orgID).Scan(
		&out.Name, &out.Prompt, &out.ScheduleText, &scheduleJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoutinesDeleteOutput{}, errors.New("routine not found")
	}
	if err != nil {
		return RoutinesDeleteOutput{}, err
	}
	_ = json.Unmarshal(scheduleJSON, &out.Schedule)
	return out, nil
}

func routinesRunNow(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RoutinesRunNowInput) (RoutinesRunNowOutput, error) {
	var routineID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM routines WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.RoutineID, claims.OrganizationID).Scan(&routineID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoutinesRunNowOutput{}, errors.New("routine not found")
	}
	if err != nil {
		return RoutinesRunNowOutput{}, err
	}
	payload, err := json.Marshal(map[string]any{"routineId": input.RoutineID, "trigger": "manual"})
	if err != nil {
		return RoutinesRunNowOutput{}, err
	}
	var jobID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO jobs (org_id, type, payload, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5)
		RETURNING id::text`,
		claims.OrganizationID, routineJobType, string(payload), claims.ActorType, claims.ActorID).Scan(&jobID); err != nil {
		return RoutinesRunNowOutput{}, err
	}
	return RoutinesRunNowOutput{JobID: jobID}, nil
}
