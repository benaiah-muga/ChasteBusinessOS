package httpapi

import (
	"context"
	"errors"
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

type ledgerCursorReader interface {
	BeforeForOrg(context.Context, string, int64, int) ([]ledger.Event, error)
}

const maxSafeLedgerSequence int64 = 1<<53 - 1

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
	before, valid := parseLedgerCursor(r.URL.Query().Get("before"), r.URL.Query().Has("before"))
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ledger cursor"})
		return
	}
	events, err := readLedgerPage(r.Context(), h.reader, claims.OrganizationID, before, limit)
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

func readLedgerPage(ctx context.Context, reader LedgerReader, orgID string, before int64, limit int) ([]ledger.Event, error) {
	if before == 0 {
		return reader.RecentForOrg(ctx, orgID, limit)
	}
	cursorReader, ok := reader.(ledgerCursorReader)
	if !ok {
		return nil, errors.New("ledger reader does not support cursors")
	}
	return cursorReader.BeforeForOrg(ctx, orgID, before, limit)
}

func parseLedgerCursor(value string, present bool) (int64, bool) {
	if !present {
		return 0, true
	}
	cursor, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	return cursor, err == nil && cursor > 0 && cursor <= maxSafeLedgerSequence
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
		digits := trimmed[2:]
		if digits == "" {
			return 60
		}
		parsed = 0
		for i := 0; i < len(digits); i++ {
			char := digits[i]
			digit := -1
			switch {
			case char >= '0' && char <= '9':
				digit = int(char - '0')
			case char >= 'a' && char <= 'f':
				digit = int(char-'a') + 10
			case char >= 'A' && char <= 'F':
				digit = int(char-'A') + 10
			}
			if digit < 0 || digit >= base {
				return 60
			}
			parsed = parsed*float64(base) + float64(digit)
		}
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
