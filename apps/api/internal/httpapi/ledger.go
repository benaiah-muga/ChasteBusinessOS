package httpapi

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
)

type LedgerReader interface {
	RecentForOrg(context.Context, string, int) ([]ledger.Event, error)
}

type GoLedgerHandler struct {
	secret string
	reader LedgerReader
	logger *slog.Logger
}

func NewGoLedgerHandler(secret string, reader LedgerReader, logger *slog.Logger) http.Handler {
	return &GoLedgerHandler{secret: secret, reader: reader, logger: logger}
}

func (h *GoLedgerHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ledger service unavailable"})
		return
	}
	claims, err := authbridge.Verify(h.secret, r.Header.Get(sessionAssertionHeader), authbridge.LedgerReadAudience, time.Now())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !claims.CanReadLedger {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	limit := parseLedgerLimit(r.URL.Query().Get("limit"), r.URL.Query().Has("limit"))
	events, err := h.reader.RecentForOrg(r.Context(), claims.OrganizationID, limit)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go ledger read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	response := apicontract.GoLedgerResponse{Events: make([]apicontract.GoLedgerEvent, 0, len(events))}
	for _, event := range events {
		response.Events = append(response.Events, apicontract.GoLedgerEvent{
			Seq:           event.Seq,
			Kind:          event.Kind,
			CapabilityId:  event.CapabilityID,
			ActorType:     event.ActorType,
			ActorId:       event.ActorID,
			SessionId:     event.SessionID,
			AuthSessionId: event.AuthSessionID,
			Payload:       event.Payload,
			Hash:          event.Hash,
			PrevHash:      event.PrevHash,
			OccurredAt:    event.OccurredAt,
		})
	}
	writeJSON(w, http.StatusOK, response)
}

func parseLedgerLimit(value string, present bool) int {
	if !present {
		return 60
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 1
	}
	if strings.Contains(trimmed, "_") {
		return 60
	}
	var parsed float64
	var err error
	base := 0
	switch {
	case strings.HasPrefix(trimmed, "0x"), strings.HasPrefix(trimmed, "0X"):
		base = 16
	case strings.HasPrefix(trimmed, "0b"), strings.HasPrefix(trimmed, "0B"):
		base = 2
	case strings.HasPrefix(trimmed, "0o"), strings.HasPrefix(trimmed, "0O"):
		base = 8
	}
	if base == 0 {
		parsed, err = strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 60
		}
	} else {
		integer, parseErr := strconv.ParseUint(trimmed[2:], base, 64)
		if parseErr != nil {
			return 60
		}
		parsed = float64(integer)
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 60
	}
	if parsed <= 1 {
		return 1
	}
	if parsed >= 200 {
		return 200
	}
	return int(math.Floor(parsed))
}
