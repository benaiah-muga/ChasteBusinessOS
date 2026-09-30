package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/jobs"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("Go capability jobs worker stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	workerURL := os.Getenv("JOBS_WORKER_DATABASE_URL")
	if workerURL == "" {
		return errors.New("JOBS_WORKER_DATABASE_URL is required")
	}
	appURL := os.Getenv("GO_DATABASE_URL")
	if appURL == "" {
		return errors.New("GO_DATABASE_URL is required for tenant-scoped capability execution")
	}
	ctx := context.Background()
	workerPool, err := pgxpool.New(ctx, workerURL)
	if err != nil {
		return errors.New("could not configure capability jobs worker database pool")
	}
	defer workerPool.Close()
	if err := jobs.VerifyRole(ctx, workerPool); err != nil {
		return errors.New("JOBS_WORKER_DATABASE_URL must use the dedicated NOBYPASSRLS jobs worker role")
	}
	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		return errors.New("could not configure Go runtime database pool")
	}
	defer appPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		return errors.New("GO_DATABASE_URL must use the chaste_app role without superuser or BYPASSRLS privileges")
	}
	workerID := os.Getenv("JOBS_WORKER_ID")
	if workerID == "" {
		workerID, err = newWorkerID()
		if err != nil {
			return errors.New("could not create capability jobs worker identifier")
		}
	}
	executor := capability.NewExecutor(appPool, os.Getenv("NOTIFICATION_WEBHOOK_URL"), os.Getenv("SMTP_HOST"), os.Getenv("SMTP_TO"))
	worker, err := jobs.NewWorker(workerPool, workerPool, appPool, executor, jobs.Options{
		WorkerID:           workerID,
		Logger:             logger,
		RoutineScheduler:   os.Getenv("GO_ROUTINE_SCHEDULER") == "1",
		RoutineAgentRunner: os.Getenv("GO_ROUTINE_AGENT_RUNNER") == "1",
	})
	if err != nil {
		return err
	}
	runCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("Go capability jobs worker started", "worker_id", workerID,
		"routine_scheduler_enabled", os.Getenv("GO_ROUTINE_SCHEDULER") == "1",
		"routine_agent_runner_enabled", os.Getenv("GO_ROUTINE_AGENT_RUNNER") == "1")
	return worker.Run(runCtx)
}

func newWorkerID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("go-jobs:%s", hex.EncodeToString(value[:])), nil
}
