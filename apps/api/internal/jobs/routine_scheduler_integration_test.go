package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoRoutineSchedulerIsOptInAndConcurrentClaimsAreUnique(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the Go routine scheduler proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := envOr("CHASTE_APP_DB_PASSWORD", "chaste_app_dev_only")
	workerPassword := envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatal(err)
	}

	tag := fmt.Sprintf("go-routine-scheduler-%d", time.Now().UnixNano())
	orgA := insertJobsTestOrg(t, ctx, owner, tag+"-a")
	orgB := insertJobsTestOrg(t, ctx, owner, tag+"-b")
	defer cleanupJobsTestOrgs(t, owner, orgA, orgB)
	base := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	ids := make([]string, 12)
	for i := range ids {
		orgID := orgA
		if i%2 == 1 {
			orgID = orgB
		}
		scheduledAt := base.Add(time.Duration(i) * time.Minute)
		if err := owner.QueryRow(ctx, `
			INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type,next_run_at)
			VALUES($1::uuid,$2,'Scheduler proof','{"kind":"interval","everyMinutes":5}',true,'schedule',$3)
			RETURNING id::text`, orgID, fmt.Sprintf("Due routine %02d", i), scheduledAt).Scan(&ids[i]); err != nil {
			t.Fatalf("create due routine %d: %v", i, err)
		}
	}
	var candidateJSON []byte
	if err := workerPool.QueryRow(ctx, `
		SELECT COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY scheduled_at, routine_id), '[]'::jsonb)
		FROM jobs_worker.list_due_routine_candidates(100) AS candidate`).Scan(&candidateJSON); err != nil {
		t.Fatalf("list due routine candidates through worker grant: %v", err)
	}
	var candidates []map[string]json.RawMessage
	if err := json.Unmarshal(candidateJSON, &candidates); err != nil {
		t.Fatal(err)
	}
	if len(candidates) < 12 {
		t.Fatalf("global routine candidate count=%d, want at least the 12 seeded routines", len(candidates))
	}
	seenTenants := map[string]bool{}
	seededCandidateIDs := make(map[string]bool, len(ids))
	for _, candidate := range candidates {
		if len(candidate) != 3 || candidate["routine_id"] == nil || candidate["org_id"] == nil || candidate["scheduled_at"] == nil {
			t.Fatalf("scheduler exposed unexpected candidate metadata: %#v", candidate)
		}
		var routineID, orgID string
		if err := json.Unmarshal(candidate["routine_id"], &routineID); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(candidate["org_id"], &orgID); err != nil {
			t.Fatal(err)
		}
		seenTenants[orgID] = true
		seededCandidateIDs[routineID] = true
	}
	if !seenTenants[orgA] || !seenTenants[orgB] {
		t.Fatalf("scheduler did not discover both tenant ids: %#v", seenTenants)
	}
	for _, id := range ids {
		if !seededCandidateIDs[id] {
			t.Fatalf("scheduler candidate metadata omitted due routine %s", id)
		}
	}
	var boundedCandidateCount int
	if err := workerPool.QueryRow(ctx, `SELECT count(*) FROM jobs_worker.list_due_routine_candidates(10)`).Scan(&boundedCandidateCount); err != nil {
		t.Fatalf("query globally bounded candidates: %v", err)
	}
	if boundedCandidateCount > 10 {
		t.Fatalf("candidate function returned %d rows for global limit 10", boundedCandidateCount)
	}
	var leakedPrompt string
	if err := workerPool.QueryRow(ctx, `SELECT prompt FROM public.routines WHERE id=$1::uuid`, ids[0]).Scan(&leakedPrompt); err == nil {
		t.Fatal("jobs worker read routine prompt outside the metadata function")
	}

	executor := capability.NewExecutor(appPool, "", "", "")
	defaultWorker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-routine-scheduler-default"})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := defaultWorker.scheduleDueRoutines(ctx, time.Now().UTC()); err != nil || got != 0 {
		t.Fatalf("default-off scheduler claimed=%d err=%v", got, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM routine_occurrences WHERE org_id=ANY($1::uuid[])`, []string{orgA, orgB}); got != 0 {
		t.Fatalf("default-off scheduler created %d occurrences", got)
	}

	workerA, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-routine-scheduler-a", RoutineScheduler: true})
	if err != nil {
		t.Fatal(err)
	}
	workerB, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-routine-scheduler-b", RoutineScheduler: true})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	batch := func(worker *Worker, start, end int) (int, error) {
		var claimed int
		for _, orgID := range []string{orgA, orgB} {
			var routineIDs []string
			for index := start; index < end; index++ {
				belongsToOrg := orgA
				if index%2 == 1 {
					belongsToOrg = orgB
				}
				if orgID == belongsToOrg {
					routineIDs = append(routineIDs, ids[index])
				}
			}
			count, err := worker.scheduleOrgRoutines(ctx, orgID, routineIDs, now)
			if err != nil {
				return claimed, err
			}
			claimed += count
		}
		return claimed, nil
	}
	var wg sync.WaitGroup
	wg.Add(2)
	claimed := [2]int{}
	claimErrors := [2]error{}
	go func() {
		defer wg.Done()
		claimed[0], claimErrors[0] = batch(workerA, 0, 10)
	}()
	go func() {
		defer wg.Done()
		claimed[1], claimErrors[1] = batch(workerB, 0, 10)
	}()
	wg.Wait()
	for i, err := range claimErrors {
		if err != nil {
			t.Fatalf("concurrent scheduler %d: %v", i, err)
		}
	}
	if total := claimed[0] + claimed[1]; total != 10 {
		t.Fatalf("concurrent schedulers claimed %d routines, want one globally ordered batch of 10", total)
	}
	assertScheduledRoutineJobs(t, ctx, owner, orgA, orgB, ids[:10], base, now)
	if due := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM routines WHERE org_id=ANY($1::uuid[]) AND enabled=true AND trigger_type='schedule' AND next_run_at <= $2`, []string{orgA, orgB}, now); due != 2 {
		t.Fatalf("routines remaining due after first global batch=%d, want 2", due)
	}

	if count, err := batch(workerA, 10, 12); err != nil || count != 2 {
		t.Fatalf("second scheduler batch claimed=%d err=%v, want remaining 2", count, err)
	}
	assertScheduledRoutineJobs(t, ctx, owner, orgA, orgB, ids, base, now)
	if total := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM jobs WHERE org_id=ANY($1::uuid[]) AND type='routines.executeRoutine'`, []string{orgA, orgB}); total != 12 {
		t.Fatalf("routine jobs=%d, want one per scheduled occurrence", total)
	}

	var pending int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id=ANY($1::uuid[]) AND type='routines.executeRoutine' AND status='pending'`, []string{orgA, orgB}).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 12 {
		t.Fatalf("default-off Go agent claim changed routine jobs, pending=%d", pending)
	}
	var jobID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE org_id=$1::uuid AND type='routines.executeRoutine' ORDER BY created_at LIMIT 1`, orgA).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	for _, gate := range []struct {
		value string
		want  int
	}{{value: "0", want: 0}, {value: "1", want: 1}} {
		var visible int
		_, err := dbx.WithOrgTx(ctx, workerPool, orgA, func(tx pgx.Tx) (struct{}, error) {
			if _, err := tx.Exec(ctx, `SELECT set_config('app.go_routine_agent_runner',$1,true)`, gate.value); err != nil {
				return struct{}{}, err
			}
			err := tx.QueryRow(ctx, `SELECT count(*) FROM public.jobs WHERE id=$1::uuid AND org_id=$2::uuid`, jobID, orgA).Scan(&visible)
			return struct{}{}, err
		})
		if err != nil {
			t.Fatalf("routine job visibility with runner gate %s: %v", gate.value, err)
		}
		if visible != gate.want {
			t.Fatalf("routine job visibility with runner gate %s=%d, want %d", gate.value, visible, gate.want)
		}
	}
}

func assertScheduledRoutineJobs(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgA, orgB string, ids []string, base, now time.Time) {
	t.Helper()
	for index, id := range ids {
		var orgID string
		if index%2 == 1 {
			orgID = orgB
		} else {
			orgID = orgA
		}
		var occurrenceCount int
		if err := owner.QueryRow(ctx, `
			SELECT count(*)
			FROM routine_occurrences occurrence
			JOIN jobs job ON job.id=occurrence.job_id AND job.org_id=occurrence.org_id
			WHERE occurrence.org_id=$1::uuid AND occurrence.routine_id=$2::uuid
			  AND occurrence.scheduled_at=$3::timestamptz AND occurrence.status='queued'
			  AND job.type='routines.executeRoutine'
		  AND job.payload->>'routineId'=$2::text
			  AND job.payload->>'trigger'='schedule'
			  AND job.payload->>'occurrenceId'=occurrence.id::text
			  AND job.payload->>'scheduledAt' IS NOT NULL`, orgID, id, base.Add(time.Duration(index)*time.Minute)).Scan(&occurrenceCount); err != nil {
			t.Fatal(err)
		}
		if occurrenceCount != 1 {
			t.Fatalf("routine %s occurrence/job links=%d, want one", id, occurrenceCount)
		}
		var lastStatus string
		var nextRunAt time.Time
		if err := owner.QueryRow(ctx, `SELECT last_status,next_run_at FROM routines WHERE id=$1::uuid AND org_id=$2::uuid`, id, orgID).Scan(&lastStatus, &nextRunAt); err != nil {
			t.Fatal(err)
		}
		if lastStatus != "running" || !nextRunAt.After(now) {
			t.Fatalf("routine %s state status=%q next_run_at=%s", id, lastStatus, nextRunAt)
		}
	}
}
