package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestCapabilityErrorStatusClassification(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantDomain bool
	}{
		{name: "module disabled", err: errors.New(`support module is disabled`), wantStatus: http.StatusForbidden, wantDomain: true},
		{name: "not found", err: errors.New("deal not found"), wantStatus: http.StatusNotFound, wantDomain: true},
		{name: "not a member", err: errors.New("caller is not a member"), wantStatus: http.StatusNotFound, wantDomain: true},
		{name: "forbidden prefix", err: errors.New("forbidden: missing crm.write"), wantStatus: http.StatusForbidden, wantDomain: true},
		{name: "domain refusal", err: errors.New("order is void"), wantStatus: http.StatusUnprocessableEntity, wantDomain: true},
		{name: "postgres failure stays internal", err: &pgconn.PgError{Code: "08006", Message: "connection failure"}, wantStatus: 0, wantDomain: false},
		{name: "canceled context stays internal", err: context.Canceled, wantStatus: 0, wantDomain: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, domain := capabilityErrorStatus(tc.err)
			if domain != tc.wantDomain || status != tc.wantStatus {
				t.Fatalf("status=%d domain=%t want status=%d domain=%t", status, domain, tc.wantStatus, tc.wantDomain)
			}
		})
	}
}
