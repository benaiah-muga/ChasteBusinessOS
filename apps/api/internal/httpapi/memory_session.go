package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const memorySessionBodyLimit = 16 << 10
const memorySessionRowsLimit = 200

type orgMemoryProjection struct {
	ID        string
	Kind      string
	Source    *string
	Content   string
	CreatedAt time.Time
}

type orgMemoryReader interface {
	ListOrganizationMemory(context.Context, string) ([]orgMemoryProjection, error)
}

type pgOrgMemoryReader struct{ pool *pgxpool.Pool }

func (r pgOrgMemoryReader) ListOrganizationMemory(ctx context.Context, orgID string) ([]orgMemoryProjection, error) {
	if r.pool == nil {
		return nil, errors.New("memory database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) ([]orgMemoryProjection, error) {
		rows, err := tx.Query(ctx, `
			SELECT id::text, kind, source, content, created_at
			FROM memories
			WHERE org_id=$1::uuid
			ORDER BY created_at DESC
			LIMIT $2`, orgID, memorySessionRowsLimit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		memories := make([]orgMemoryProjection, 0)
		for rows.Next() {
			var memory orgMemoryProjection
			if err := rows.Scan(&memory.ID, &memory.Kind, &memory.Source, &memory.Content, &memory.CreatedAt); err != nil {
				return nil, err
			}
			memories = append(memories, memory)
		}
		return memories, rows.Err()
	})
}

type MemorySessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	reader            orgMemoryReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewMemorySessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &MemorySessionHandler{
		resolver: resolver, executor: executor, reader: pgOrgMemoryReader{pool: pool},
		logger: logger, trustedProxyCIDRs: trusted,
	}
}

func (h *MemorySessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "memory service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		h.unauthorized(w)
		return
	}
	resolved, bearer, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		h.unauthorized(w)
		return
	}
	if r.Method == http.MethodPost && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.list(w, r, resolved)
		return
	}
	h.delete(w, r, resolved)
}

func (h *MemorySessionHandler) resolve(r *http.Request, activeOrg string) (*session.ResolvedUser, bool, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err
}

func (h *MemorySessionHandler) list(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	rows, err := h.reader.ListOrganizationMemory(r.Context(), *resolved.OrgID)
	if err != nil {
		h.logger.Error("Go memory list query failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	kind := r.URL.Query().Get("kind")
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if kind != "" && row.Kind != kind {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(row.Content), query) &&
			(row.Source == nil || !strings.Contains(strings.ToLower(*row.Source), query)) {
			continue
		}
		items = append(items, map[string]any{
			"id": row.ID, "kind": row.Kind, "source": row.Source, "content": row.Content,
			"preview": memoryPreview(row.Content), "createdAt": memoryTimestamp(row.CreatedAt),
		})
	}
	canEdit := resolved.Permissions["*"] || resolved.HasPermission("documents.write")
	writeJSON(w, http.StatusOK, map[string]any{"memories": items, "total": len(rows), "canEdit": canEdit})
}

func memoryPreview(content string) string {
	units := utf16.Encode([]rune(content))
	if len(units) > 240 {
		units = units[:240]
	}
	return string(utf16.Decode(units))
}

func memoryTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func (h *MemorySessionHandler) delete(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, memorySessionBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if decoder.Decode(&fields) != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var action, memoryID string
	if json.Unmarshal(fields["action"], &action) != nil || action != "delete" ||
		json.Unmarshal(fields["memoryId"], &memoryID) != nil || !isUUID(memoryID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID := ""
	if raw, ok := fields["intentId"]; ok {
		var valid bool
		intentID, valid = parseProjectIntentID(raw)
		if !valid {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	} else {
		var err error
		intentID, err = newMemoryIntentID()
		if err != nil {
			h.logger.Error("Go memory intent generation failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	}
	input, err := json.Marshal(struct {
		MemoryID string `json:"memoryId"`
	}{MemoryID: memoryID})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	claims := memorySessionClaims(resolved, intentID, input)
	result, err := h.executor.Execute(r.Context(), claims, "documents.deleteOrgMemory", input)
	if err != nil {
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.logger.Error("Go memory deletion failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if result.PendingApproval {
		writeJSON(w, http.StatusAccepted, map[string]any{
			"pendingApproval": true,
			"hint":            "Memory deletion proposed by the workmate waits for approval in the Approvals inbox.",
		})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func newMemoryIntentID() (string, error) {
	var uuid [16]byte
	if _, err := rand.Read(uuid[:]); err != nil {
		return "", err
	}
	uuid[6] = (uuid[6] & 0x0f) | 0x40
	uuid[8] = (uuid[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(uuid[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func memorySessionClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: "documents.deleteOrgMemory", InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func (h *MemorySessionHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}
