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

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/outbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("webhook outbox worker stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	databaseURL := os.Getenv("OUTBOX_WORKER_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("OUTBOX_WORKER_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return errors.New("could not configure webhook outbox database pool")
	}
	defer pool.Close()
	if err := dbx.VerifyOutboxWorkerRole(context.Background(), pool); err != nil {
		return errors.New("OUTBOX_WORKER_DATABASE_URL must use the dedicated NOBYPASSRLS webhook worker role")
	}
	workerID := os.Getenv("OUTBOX_WORKER_ID")
	if workerID == "" {
		workerID, err = newWorkerID()
		if err != nil {
			return errors.New("could not create webhook worker identifier")
		}
	}
	worker, err := outbox.NewWorker(pool, pool, outbox.Options{WorkerID: workerID})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("webhook outbox worker started", "worker_id", workerID)
	err = worker.Run(ctx)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func newWorkerID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("go-outbox:%s", hex.EncodeToString(value[:])), nil
}
