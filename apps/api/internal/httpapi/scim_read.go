package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	scimReadLimit        = 60
	scimReadWindow       = time.Minute
	scimDefaultPageCount = 100
	scimCollectionLimit  = 200
)

var scimUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var scimUserNameFilter = regexp.MustCompile(`(?i)^\s*userName\s+eq\s+"([^"\\]{1,320})"\s*$`)

type scimReadHandler struct {
	pool              *pgxpool.Pool
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	limiter           *SCIMRateLimiter
}

// SCIMRateLimiter shares the collection and provisioning attempt budget for a
// source IP when the handlers are enabled independently.
type SCIMRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]scimRateWindow
	now     func() time.Time
}

type scimRateWindow struct {
	start time.Time
	count int
}

type scimUserResource struct {
	Schemas  []string        `json:"schemas"`
	ID       string          `json:"id"`
	UserName string          `json:"userName"`
	Name     scimUserName    `json:"name"`
	Emails   []scimUserEmail `json:"emails"`
	Active   bool            `json:"active"`
}

type scimUserName struct {
	GivenName string `json:"givenName,omitempty"`
}

type scimUserEmail struct {
	Value   string `json:"value"`
	Primary bool   `json:"primary"`
}

type scimListResponse struct {
	Schemas      []string           `json:"schemas"`
	TotalResults int                `json:"totalResults"`
	StartIndex   int                `json:"startIndex"`
	ItemsPerPage int                `json:"itemsPerPage"`
	Resources    []scimUserResource `json:"Resources"`
}

type scimErrorResponse struct {
	Schemas []string `json:"schemas"`
	Status  string   `json:"status"`
	Detail  string   `json:"detail"`
}

type scimMember struct {
	ID    string
	Email string
	Name  *string
}

// NewSCIMReadHandler creates an opt-in SCIM 2.0 user read handler. SCIM
// bearer tokens are SHA-256 hashed before lookup and only select the org via a
// narrowly granted database resolver. User reads always run in WithOrgTx.
func NewSCIMReadHandler(pool *pgxpool.Pool, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	return NewSCIMReadHandlerWithLimiter(pool, trustedProxyCIDRs, logger, NewSCIMRateLimiter())
}

// NewSCIMRateLimiter constructs the process-local SCIM auth attempt budget.
func NewSCIMRateLimiter() *SCIMRateLimiter {
	return &SCIMRateLimiter{buckets: make(map[string]scimRateWindow), now: time.Now}
}

// NewSCIMReadHandlerWithLimiter allows the server to share one attempt budget
// across its separately mounted SCIM read and write handlers.
func NewSCIMReadHandlerWithLimiter(pool *pgxpool.Pool, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger, limiter *SCIMRateLimiter) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("SCIM handler requires a database pool")
	}
	if limiter == nil {
		return nil, errors.New("SCIM handler requires a shared rate limiter")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &scimReadHandler{
		pool: pool, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs,
		limiter: limiter,
	}, nil
}

func (h *scimReadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/scim+json; charset=utf-8")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		h.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !h.allow(requestClientIP(r, h.trustedProxyCIDRs)) {
		h.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return
	}
	orgID, ok := h.resolveOrg(r.Context(), r.Header.Get("Authorization"))
	if !ok {
		h.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return
	}

	if id := strings.TrimPrefix(r.URL.Path, "/api/scim/v2/Users/"); id != r.URL.Path {
		if !scimUUIDPattern.MatchString(id) {
			h.writeError(w, http.StatusNotFound, "user not found")
			return
		}
		resource, found, err := h.getUser(r.Context(), orgID, id)
		if err != nil {
			h.unavailable(w, "read SCIM user")
			return
		}
		if !found {
			h.writeError(w, http.StatusNotFound, "user not found")
			return
		}
		writeSCIMJSON(w, http.StatusOK, resource)
		return
	}

	startIndex, count, validPage := parseSCIMPage(r.URL.Query().Get("startIndex"), r.URL.Query().Get("count"))
	if !validPage {
		h.writeError(w, http.StatusBadRequest, "startIndex and count must be non-negative integers; startIndex must be at least 1")
		return
	}
	filter := r.URL.Query().Get("filter")
	var emailFilter *string
	if filter != "" {
		match := scimUserNameFilter.FindStringSubmatch(filter)
		if len(match) != 2 {
			h.writeError(w, http.StatusBadRequest, "unsupported SCIM filter")
			return
		}
		email := strings.ToLower(match[1])
		emailFilter = &email
	}
	resources, totalResults, err := h.listUsers(r.Context(), orgID, emailFilter, startIndex, count)
	if err != nil {
		h.unavailable(w, "list SCIM users")
		return
	}
	writeSCIMJSON(w, http.StatusOK, scimListResponse{
		Schemas:      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		TotalResults: totalResults, StartIndex: startIndex,
		ItemsPerPage: len(resources), Resources: resources,
	})
}

func parseSCIMPage(startIndexRaw, countRaw string) (int, int, bool) {
	startIndex := 1
	if startIndexRaw != "" {
		parsed, err := strconv.ParseInt(startIndexRaw, 10, 32)
		if err != nil || parsed < 1 {
			return 0, 0, false
		}
		startIndex = int(parsed)
	}
	count := scimDefaultPageCount
	if countRaw != "" {
		parsed, err := strconv.ParseInt(countRaw, 10, 32)
		if err != nil || parsed < 0 {
			return 0, 0, false
		}
		count = int(parsed)
		if count > scimCollectionLimit {
			count = scimCollectionLimit
		}
	}
	return startIndex, count, true
}

func (h *scimReadHandler) resolveOrg(ctx context.Context, authorization string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(authorization, prefix) {
		return "", false
	}
	raw := strings.TrimSpace(strings.TrimPrefix(authorization, prefix))
	if raw == "" || len(raw) > 512 {
		return "", false
	}
	digest := sha256.Sum256([]byte(raw))
	var orgID string
	err := h.pool.QueryRow(ctx, `SELECT org_id::text FROM public.chaste_resolve_scim_token($1)`, hex.EncodeToString(digest[:])).Scan(&orgID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			h.logger.Error("SCIM token resolution failed", "error", err)
		}
		return "", false
	}
	return orgID, true
}

func (h *scimReadHandler) allow(clientIP string) bool {
	return h.limiter.allow(clientIP)
}

func (limiter *SCIMRateLimiter) allow(clientIP string) bool {
	if clientIP == "" {
		return false
	}
	now := limiter.now()
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if len(limiter.buckets) > 10_000 {
		for key, window := range limiter.buckets {
			if now.Sub(window.start) >= scimReadWindow {
				delete(limiter.buckets, key)
			}
		}
	}
	window, exists := limiter.buckets[clientIP]
	if !exists || now.Sub(window.start) >= scimReadWindow {
		limiter.buckets[clientIP] = scimRateWindow{start: now, count: 1}
		return true
	}
	if window.count >= scimReadLimit {
		return false
	}
	window.count++
	limiter.buckets[clientIP] = window
	return true
}

func (h *scimReadHandler) listUsers(ctx context.Context, orgID string, email *string, startIndex, count int) ([]scimUserResource, int, error) {
	type result struct {
		resources []scimUserResource
		total     int
	}
	value, err := dbx.WithOrgTx(ctx, h.pool, orgID, func(tx pgx.Tx) (result, error) {
		countQuery := `SELECT count(*)
			FROM memberships m JOIN users u ON u.id = m.user_id
			WHERE m.org_id = $1::uuid`
		countArgs := []any{orgID}
		query := `SELECT u.id::text, u.email, u.name
			FROM memberships m JOIN users u ON u.id = m.user_id
			WHERE m.org_id = $1::uuid
			ORDER BY lower(u.email), u.id
			LIMIT $2 OFFSET $3`
		args := []any{orgID, count, startIndex - 1}
		if email != nil {
			countQuery += ` AND lower(u.email) = $2`
			countArgs = append(countArgs, *email)
			query = `SELECT u.id::text, u.email, u.name
				FROM memberships m JOIN users u ON u.id = m.user_id
				WHERE m.org_id = $1::uuid AND lower(u.email) = $2
				ORDER BY lower(u.email), u.id
				LIMIT $3 OFFSET $4`
			args = []any{orgID, *email, count, startIndex - 1}
		}
		var total int
		if err := tx.QueryRow(ctx, countQuery, countArgs...).Scan(&total); err != nil {
			return result{}, err
		}
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return result{}, err
		}
		defer rows.Close()
		resources := make([]scimUserResource, 0)
		for rows.Next() {
			var member scimMember
			if err := rows.Scan(&member.ID, &member.Email, &member.Name); err != nil {
				return result{}, err
			}
			resources = append(resources, toSCIMResource(member))
		}
		if err := rows.Err(); err != nil {
			return result{}, err
		}
		return result{resources: resources, total: total}, nil
	})
	return value.resources, value.total, err
}

func (h *scimReadHandler) getUser(ctx context.Context, orgID, userID string) (scimUserResource, bool, error) {
	type result struct {
		resource scimUserResource
		found    bool
	}
	value, err := dbx.WithOrgTx(ctx, h.pool, orgID, func(tx pgx.Tx) (result, error) {
		var member scimMember
		err := tx.QueryRow(ctx, `SELECT u.id::text, u.email, u.name
			FROM memberships m JOIN users u ON u.id = m.user_id
			WHERE m.org_id = $1::uuid AND u.id = $2::uuid`, orgID, userID).
			Scan(&member.ID, &member.Email, &member.Name)
		if errors.Is(err, pgx.ErrNoRows) {
			return result{}, nil
		}
		if err != nil {
			return result{}, err
		}
		return result{resource: toSCIMResource(member), found: true}, nil
	})
	return value.resource, value.found, err
}

func toSCIMResource(member scimMember) scimUserResource {
	name := scimUserName{}
	if member.Name != nil {
		name.GivenName = *member.Name
	}
	return scimUserResource{
		Schemas: []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
		ID:      member.ID, UserName: member.Email, Name: name,
		Emails: []scimUserEmail{{Value: member.Email, Primary: true}}, Active: true,
	}
}

func (h *scimReadHandler) writeError(w http.ResponseWriter, status int, detail string) {
	writeSCIMJSON(w, status, scimErrorResponse{
		Schemas: []string{"urn:ietf:params:scim:api:messages:2.0:Error"},
		Status:  strconv.Itoa(status),
		Detail:  detail,
	})
}

func (h *scimReadHandler) unavailable(w http.ResponseWriter, action string) {
	h.logger.Error("SCIM database request failed", "action", action)
	h.writeError(w, http.StatusServiceUnavailable, "SCIM service is temporarily unavailable")
}

func writeSCIMJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	if status == http.StatusNoContent {
		return
	}
	_ = json.NewEncoder(w).Encode(value)
}
