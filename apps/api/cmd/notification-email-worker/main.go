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
		logger.Error("notification email outbox worker stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	databaseURL := os.Getenv("NOTIFICATION_EMAIL_OUTBOX_WORKER_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("NOTIFICATION_EMAIL_OUTBOX_WORKER_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return errors.New("could not configure notification email worker database pool")
	}
	defer pool.Close()
	if err := dbx.VerifyNotificationEmailWorkerRole(context.Background(), pool); err != nil {
		return errors.New("NOTIFICATION_EMAIL_OUTBOX_WORKER_DATABASE_URL must use the dedicated NOBYPASSRLS notification email worker role")
	}
	workerID := os.Getenv("NOTIFICATION_EMAIL_OUTBOX_WORKER_ID")
	if workerID == "" {
		workerID, err = newWorkerID()
		if err != nil {
			return errors.New("could not create notification email worker identifier")
		}
	}
	port, err := smtpPort(os.Getenv("SMTP_PORT"))
	if err != nil {
		return err
	}
	worker, err := outbox.NewNotificationEmailWorker(pool, pool, outbox.NotificationEmailWorkerOptions{
		WorkerID: workerID,
		Config: outbox.MarketingEmailConfig{
			Host: os.Getenv("SMTP_HOST"), Port: port, Secure: os.Getenv("SMTP_SECURE") == "true",
			User: os.Getenv("SMTP_USER"), Pass: os.Getenv("SMTP_PASS"), From: os.Getenv("SMTP_FROM"),
		},
		Logger: logger,
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("notification email outbox worker started", "worker_id", workerID)
	err = worker.Run(ctx)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func smtpPort(value string) (int, error) {
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
	return "go-notification-email:" + hex.EncodeToString(value[:]), nil
}
