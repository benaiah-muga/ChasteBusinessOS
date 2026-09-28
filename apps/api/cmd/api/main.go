package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/httpapi"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/metrics"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/orgswitch"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("api server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	databaseURL := os.Getenv("GO_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("GO_DATABASE_URL is required")
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return errors.New("could not configure PostgreSQL pool")
	}
	defer pool.Close()
	if err := dbx.VerifyAppRuntimeRole(context.Background(), pool); err != nil {
		return errors.New("GO_DATABASE_URL must use the chaste_app role without superuser or BYPASSRLS privileges")
	}

	addr := os.Getenv("GO_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}

	capabilityExecutor := capability.NewExecutor(pool, os.Getenv("NOTIFICATION_WEBHOOK_URL"), os.Getenv("SMTP_HOST"), os.Getenv("SMTP_TO"))
	approvalDecider := capability.NewApprovalDecider(pool, capabilityExecutor)
	server := &http.Server{
		Addr: addr,
		Handler: httpapi.NewRouterWithApprovalInbox(
			pool,
			logger,
			os.Getenv("GO_INTERNAL_AUTH_SECRET"),
			policy.NewPostgresReader(pool),
			ledger.NewPostgresReader(pool),
			orgswitch.NewPostgresMembershipChecker(pool),
			capabilityExecutor,
			metrics.NewPostgresReader(pool),
			httpapi.NewPostgresApprovalInboxReader(pool),
			approvalDecider,
		),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("Go API listening", "addr", addr)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}
