package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/outbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("marketing email outbox worker stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	databaseURL := os.Getenv("MARKETING_EMAIL_OUTBOX_WORKER_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("MARKETING_EMAIL_OUTBOX_WORKER_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return errors.New("could not configure marketing email worker database pool")
	}
	defer pool.Close()
	if err := dbx.VerifyMarketingEmailWorkerRole(context.Background(), pool); err != nil {
		return errors.New("MARKETING_EMAIL_OUTBOX_WORKER_DATABASE_URL must use the dedicated NOBYPASSRLS marketing email worker role")
	}
	workerID := os.Getenv("MARKETING_EMAIL_OUTBOX_WORKER_ID")
	if workerID == "" {
		workerID, err = newWorkerID()
		if err != nil {
			return errors.New("could not create marketing email worker identifier")
		}
	}
	port, err := marketingSMTPPort(os.Getenv("SMTP_PORT"))
	if err != nil {
		return err
	}
	worker, err := outbox.NewMarketingEmailWorker(pool, pool, outbox.MarketingEmailOptions{
		WorkerID: workerID,
		Config:   outbox.MarketingEmailConfig{Host: os.Getenv("SMTP_HOST"), Port: port, Secure: os.Getenv("SMTP_SECURE") == "true", User: os.Getenv("SMTP_USER"), Pass: os.Getenv("SMTP_PASS"), From: os.Getenv("SMTP_FROM")},
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("marketing email outbox worker started", "worker_id", workerID)
	err = worker.Run(ctx)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func marketingSMTPPort(value string) (int, error) {
	if value == "" {
		return 587, nil
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, errors.New("SMTP_PORT must be an integer from 1 to 65535")
	}
	return port, nil
}

func newWorkerID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return "go-marketing-email:" + hex.EncodeToString(value[:]), nil
}
