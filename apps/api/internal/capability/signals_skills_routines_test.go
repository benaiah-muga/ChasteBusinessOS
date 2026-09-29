package capability

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestSignalsSkillsParsers(t *testing.T) {
	list, err := ParseSignalsListInput(json.RawMessage(`{"severity":"red","module":"inventory"}`))
	if err != nil || list.Severity == nil || *list.Severity != "red" {
		t.Fatalf("signals parse=%+v err=%v", list, err)
	}
	if _, err := ParseSignalsListInput(json.RawMessage(`{"severity":"blue"}`)); err == nil {
		t.Fatal("unknown severity refused")
	}
	find, err := ParseSkillsFindInput(json.RawMessage(`{"task":"buy stock from a vendor"}`))
	if err != nil || find.Task != "buy stock from a vendor" {
		t.Fatalf("skills find parse=%+v err=%v", find, err)
	}
	if _, err := ParseSkillsFindInput(json.RawMessage(`{"task":"ab"}`)); err == nil {
		t.Fatal("task under 3 characters refused")
	}
	if _, err := parseSkillsInput(skillsLoadCapabilityID, json.RawMessage(`{"id":"procure-to-pay"}`)); err != nil {
		t.Fatalf("dispatcher refused skills.load: %v", err)
	}
	if _, err := parseSignalsInput("signals.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("signals dispatcher refused unknown id")
	}
}

func TestSkillsFindAndLoad(t *testing.T) {
	found, err := skillsFind(SkillsFindInput{Task: "buy stock from a new vendor"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Skills) == 0 || found.Skills[0].ID != "procure-to-pay" {
		t.Fatalf("skills find output=%+v, want procure-to-pay first", found.Skills)
	}
	loaded, err := skillsLoad(SkillsLoadInput{ID: "procure-to-pay"})
	if err != nil || len(loaded.Steps) == 0 || loaded.Notes == nil {
		t.Fatalf("skills load output=%+v err=%v", loaded, err)
	}
	if _, err := skillsLoad(SkillsLoadInput{ID: "nope"}); err == nil {
		t.Fatal("unknown skill refused")
	}
}

func TestSignalsAggregator(t *testing.T) {
	RegisterSignalsProducer(func(ctx context.Context, orgID string, now time.Time) ([]BusinessSignal, error) {
		if orgID != "org-under-test" {
			return nil, nil
		}
		return []BusinessSignal{
			{ID: "s2", Severity: "green", Module: "inventory", Subject: "Dead stock"},
			{ID: "s1", Severity: "red", Module: "inventory", Subject: "Stockout risk"},
		}, nil
	})
	RegisterSignalsProducer(func(ctx context.Context, orgID string, now time.Time) ([]BusinessSignal, error) {
		return nil, errors.New("producer failure degrades to missing signals")
	})
	t.Cleanup(func() {
		signalsProducersMu.Lock()
		signalsProducers = nil
		signalsProducersMu.Unlock()
	})
	out, err := signalsList(context.Background(), "org-under-test", SignalsListInput{}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Signals) != 2 || out.Signals[0].ID != "s1" || out.Signals[0].Severity != "red" {
		t.Fatalf("signals output=%+v, want red first with failing producer absorbed", out.Signals)
	}
	filtered, err := signalsList(context.Background(), "org-under-test", SignalsListInput{Severity: strPtrPurchasing("green")}, time.Now().UTC())
	if err != nil || len(filtered.Signals) != 1 || filtered.Signals[0].ID != "s2" {
		t.Fatalf("filtered signals output=%+v err=%v, want only the green signal", filtered.Signals, err)
	}
}

func TestRoutinesScheduleMath(t *testing.T) {
	if schedule, ok := routinesParseScheduleText("Every 30 minutes"); !ok || schedule.EveryMinutes == nil || *schedule.EveryMinutes != 30 {
		t.Fatalf("interval parse=%+v ok=%v", schedule, ok)
	}
	if schedule, ok := routinesParseScheduleText("weekdays at 9am"); !ok || schedule.AtTime == nil || *schedule.AtTime != "09:00" {
		t.Fatalf("weekdays parse=%+v ok=%v", schedule, ok)
	}
	if schedule, ok := routinesParseScheduleText("weekly on monday at 09:00"); !ok || schedule.DayOfWeek == nil || *schedule.DayOfWeek != 1 {
		t.Fatalf("weekly parse=%+v ok=%v", schedule, ok)
	}
	if _, ok := routinesParseScheduleText("whenever possible"); ok {
		t.Fatal("unparseable schedule refused")
	}
	if label := routinesDescribeSchedule(RoutineSchedule{Kind: "daily", AtTime: strPtrPurchasing("08:00")}); label != "Daily at 08:00" {
		t.Fatalf("daily label=%s", label)
	}
	from := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	intervalNext := routinesNextRun(RoutineSchedule{Kind: "interval", EveryMinutes: int64Ptr(30)}, from)
	if !intervalNext.Equal(from.Add(30 * time.Minute)) {
		t.Fatalf("interval next=%v", intervalNext)
	}
	dailyNext := routinesNextRun(RoutineSchedule{Kind: "daily", AtTime: strPtrPurchasing("08:00")}, from)
	if !dailyNext.Equal(time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("daily next=%v, want tomorrow at 08:00", dailyNext)
	}
}

func int64Ptr(v int64) *int64 {
	return &v
}

func TestRoutinesLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		claims := authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human"}
		created, err := routinesCreate(context.Background(), tx, claims, RoutinesCreateInput{
			Name: "Nightly digest", Prompt: "Summarize yesterday", ScheduleText: strPtrPurchasing("daily at 08:00"),
		}, time.Now().UTC())
		if err != nil {
			return struct{}{}, err
		}
		if created.ScheduleLabel != "Daily at 08:00" || created.WebhookToken != nil {
			t.Fatalf("create output=%+v", created)
		}
		listed, err := routinesList(context.Background(), tx, fx.orgID, RoutinesListInput{Limit: 50})
		if err != nil || len(listed.Routines) != 1 || !listed.Routines[0].Enabled {
			t.Fatalf("list output=%+v err=%v", listed, err)
		}
		enabled := true
		updated, err := routinesUpdate(context.Background(), tx, fx.orgID, RoutinesUpdateInput{
			RoutineID: created.RoutineID, Name: strPtrPurchasing("Morning digest"), Enabled: &enabled,
			ScheduleText: strPtrPurchasing("every 30 minutes"),
		}, time.Now().UTC())
		if err != nil {
			return struct{}{}, err
		}
		if updated.ScheduleLabel != "Every 30 minutes" {
			t.Fatalf("update output=%+v", updated)
		}
		run, err := routinesRunNow(context.Background(), tx, claims, RoutinesRunNowInput{RoutineID: created.RoutineID})
		if err != nil {
			return struct{}{}, err
		}
		deleted, err := routinesDelete(context.Background(), tx, fx.orgID, RoutinesDeleteInput{RoutineID: created.RoutineID})
		if err != nil || deleted.Name != "Morning digest" {
			t.Fatalf("delete output=%+v err=%v", deleted, err)
		}
		if _, err := routinesUpdate(context.Background(), tx, fx.orgID, RoutinesUpdateInput{RoutineID: created.RoutineID}, time.Now().UTC()); err == nil || err.Error() != "routine not found" {
			t.Fatalf("update after delete err=%v, want routine not found", err)
		}
		_ = run
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND type='routines.executeRoutine'`, fx.orgID); got != 1 {
		t.Fatalf("routine jobs=%d, want one", got)
	}
}
