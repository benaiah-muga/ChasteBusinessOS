package authn

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSAMLTransactionConsumptionIsOneUseAndRejectsReplays(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := NewService(pool, "saml-http-test-secret-0123456789012345", Options{BaseURL: "https://api.example.test/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	stamp := fmt.Sprintf("%d", time.Now().UnixNano())
	state := "saml-state-" + stamp + "-00000000000000000000000000000000"
	secondState := "saml-state-" + stamp + "-11111111111111111111111111111111"
	requestID := "id-request-" + stamp
	responseID := "response-" + stamp
	assertionID := "assertion-" + stamp
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM auth_verification WHERE identifier = ANY($1::text[])`, []string{
			samlIdentifier(samlTransactionPrefix, state), samlIdentifier(samlTransactionPrefix, secondState),
			samlIdentifier(samlReplayPrefix, responseID), samlIdentifier(samlReplayPrefix, assertionID),
		})
	})
	if err := service.CreateSAMLTransaction(ctx, state, requestID); err != nil {
		t.Fatal(err)
	}
	lookedUp, err := service.LookupSAMLTransaction(ctx, state)
	if err != nil || lookedUp.RequestID != requestID {
		t.Fatalf("transaction lookup mismatch: transaction=%+v err=%v", lookedUp, err)
	}
	if _, err := service.ConsumeSAMLTransaction(ctx, state, requestID, responseID, assertionID); err != nil {
		t.Fatalf("valid transaction consumption failed: %v", err)
	}
	if _, err := service.ConsumeSAMLTransaction(ctx, state, requestID, responseID, assertionID); !errors.Is(err, ErrInvalidSAMLTransaction) {
		t.Fatalf("consumed transaction was reusable: %v", err)
	}
	if err := service.CreateSAMLTransaction(ctx, secondState, requestID+"-second"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ConsumeSAMLTransaction(ctx, secondState, requestID+"-second", responseID, assertionID+"-second"); !errors.Is(err, ErrSAMLReplay) {
		t.Fatalf("replayed response identifier was accepted: %v", err)
	}
}
