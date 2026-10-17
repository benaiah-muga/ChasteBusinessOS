package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// capabilityErrorStatus maps executor errors that are not auth failures onto
// the legacy HTTP statuses: module-disablement is 403, missing domain objects
// are 404, and every other domain refusal is 422. Infrastructure failures
// report ok=false so callers keep logging them and answer 500.
func capabilityErrorStatus(err error) (int, bool) {
	var postgresErr *pgconn.PgError
	if errors.As(err, &postgresErr) {
		return 0, false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return 0, false
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "module") && strings.Contains(lower, "disabled"):
		return http.StatusForbidden, true
	case strings.Contains(lower, "not found") || strings.Contains(lower, "not a member"):
		return http.StatusNotFound, true
	case strings.HasPrefix(lower, "forbidden"):
		return http.StatusForbidden, true
	default:
		return http.StatusUnprocessableEntity, true
	}
}
